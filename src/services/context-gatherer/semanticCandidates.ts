import type { NPCEntry, LoreChunk, ArchiveIndexEntry, ChatMessage } from '../../types';
import { mentionedNpcs } from '../npc/witnessCapture';
import type { TurnState } from '../turn/turnOrchestrator';
import { API_BASE as API } from '../../lib/apiBase';
import { rerankCandidates, type RerankCandidate } from '../retrieval/semanticReranker';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { isBlockEnabled } from '../turn/blockEnablement';
import { hasHostModelRole, type HostFacade, type ModelRequest, type ModelResponse } from '../turn/hostFacade';

/** What the reranker sees of a scene: what happened (event tags), who was there, and
 *  the player's line. The player's line + keywords alone was too thin to judge relevance. */
export function sceneRerankSummary(entry: ArchiveIndexEntry): string {
    const events = (entry.events ?? []).map(e => e.text).filter(Boolean).slice(0, 3);
    const what = events.length > 0 ? events.join('; ') : entry.keywords.slice(0, 5).join(', ');
    const who = (entry.witnesses ?? []).slice(0, 6).join(', ');
    return [what, who ? `present: ${who}` : '', `player: ${entry.userSnippet}`].filter(Boolean).join(' | ');
}

const CALLBACK_REGEX =/\b(remember|earlier|back when|before|previously|that .*(we|i) (did|met|fought|saw|found|got))\b/i;

/** The last exchange, trimmed: what "her", "it" or "the job" in a short message refers to. */
export function recentSceneText(messages: readonly ChatMessage[]): string {
    const recent = messages.filter(m => m.role === 'user' || m.role === 'assistant').slice(-2);
    return recent.map(m => `${m.role === 'assistant' ? 'GM' : 'PLAYER'}: ${(m.content ?? '').slice(0, m.role === 'assistant' ? 1500 : 400)}`).join('\n\n');
}

// Expansion used to get the first 10 ledger NPCs (the oldest, usually unrelated) and no
// scene, so the model wove random names into the query ("the blood-debt pact … Kaiser
// Voss") and recall got worse. It now sees the last exchange and only the NPCs named in it.
async function expandQuery(query: string, messages: readonly ChatMessage[], npcLedger: NPCEntry[], utilityEndpoint: import('../../types').EndpointConfig | undefined, modelCall?: (request: ModelRequest) => Promise<ModelResponse>): Promise<string[]> {
    try {
        const scene = recentSceneText(messages);
        const names = mentionedNpcs(`${scene}\n${query}`, npcLedger).slice(0, 12).map(n => n.name);
        const prompt = `The player's message below is short, so a memory search on it alone may miss the past scene they mean. Rewrite it as 2 standalone search queries for the campaign archive. Replace pronouns and vague references ("her", "it", "the job", "that place") with the specific people, places and things they refer to. Use ONLY names that appear in the recent scene, the character list, or the message itself. Do not invent names, events or details.

RECENT SCENE:
"""
${scene || '(none)'}
"""
CHARACTERS IN THE RECENT SCENE: ${names.join(', ') || '(none)'}
PLAYER MESSAGE: "${query}"

Return ONLY a JSON array of 2 strings. No prose.`;

        const raw = modelCall
            ? (await modelCall({ prompt, temperature: 0.2, priority: 'high', maxTokens: 200, thinkingEffort: 'off', trackingLabel: 'query-expansion', timeoutMs: AI_CALL_TIMEOUT_MS })).content
            : utilityEndpoint
                ? await llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high', maxTokens: 200, thinkingEffort: 'off', trackingLabel: 'query-expansion', timeoutMs: AI_CALL_TIMEOUT_MS })
                : '';

        const { value: parsed, parseOk } = extractJsonRobust<string[]>(raw, []);
        if (parseOk && Array.isArray(parsed) && parsed.length >= 2 && parsed.every((x: unknown) => typeof x === 'string')) {
            return [query, parsed[0], parsed[1]];
        }
        return [query];
    } catch {
        return [query];
    }
}

export type SemanticCandidates = {
    semanticArchiveIds: string[] | undefined;
    semanticLoreIds: string[] | undefined;
    semanticRuleIds: string[] | undefined;
};

export async function gatherSemanticCandidates(
    state: TurnState,
    signal?: AbortSignal,
    facade?: HostFacade
): Promise<SemanticCandidates> {
    const data = facade?.data;
    const config = facade?.config;
    const input = data?.input ?? state.input;
    const npcLedger = data?.npcLedger ?? state.npcLedger;
    const loreChunks = data?.loreChunks ?? state.loreChunks;
    const archiveIndex = data?.archiveIndex ?? state.archiveIndex;
    const activeCampaignId = data?.activeCampaignId ?? state.activeCampaignId;

    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;
    let semanticRuleIds: string[] | undefined;

    if (!activeCampaignId) {
        return { semanticArchiveIds, semanticLoreIds, semanticRuleIds };
    }

    try {
        // Query expansion for callback phrases or short queries
        let queries = [input];
        const utilityEndpoint = facade ? undefined : state.getUtilityEndpoint?.();
        const utilityAvailable = facade ? hasHostModelRole(facade, 'utility') : Boolean(utilityEndpoint?.endpoint);
        const modelCall = facade ? (request: ModelRequest) => facade.model.call('utility', request) : undefined;
        const isCallback = CALLBACK_REGEX.test(input);
        const isShort = input.trim().split(/\s+/).length < 8;
        // Expansion only feeds semantic retrieval over archive/lore/rules — if there's
        // nothing indexed yet (fresh campaign), it's a wasted LLM round-trip that stalls
        // turn 1. Skip it until there's something to retrieve.
        const hasRetrievableContent =
            archiveIndex.length > 0 ||
            loreChunks.length > 0 ||
            (data?.context?.rulesChunks?.length ?? state.context?.rulesChunks?.length ?? 0) > 0;
        if ((isCallback || isShort) && hasRetrievableContent && utilityAvailable && isBlockEnabled('expandQuery', config?.aiTier ?? state.settings.aiTier, state.settings.moduleEnabled)) {
            const expanded = await expandQuery(input, data?.messages ?? state.messages ?? [], npcLedger, utilityEndpoint, modelCall);
            queries = expanded;
            if (expanded.length > 1) {
                console.log(`[QueryExpansion] "${input}" → ${expanded.length} variants`);
            }
        }

        const queryBody = queries.length > 1 ? { queries } : { query: input };
        const [archiveRes, loreRes, rulesRes] = await Promise.all([
            fetch(`${API}/campaigns/${activeCampaignId}/archive/semantic-candidates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queryBody),
                signal,
            }),
            fetch(`${API}/campaigns/${activeCampaignId}/lore/semantic-candidates`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queryBody),
                signal,
            }),
            fetch(`${API}/campaigns/${activeCampaignId}/rules/search`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(queryBody),
                signal,
            }),
        ]);
        // `pending: true` means the server skipped semantic (model warming up or a bulk
        // embed in flight). Leave the ids undefined so retrieval falls back to lexical
        // (idf-rrf) instead of treating an empty list as "nothing relevant".
        if (archiveRes.ok) {
            const data = await archiveRes.json();
            if (!data.pending) semanticArchiveIds = data.sceneIds;
        }
        if (loreRes.ok) {
            const data = await loreRes.json();
            if (!data.pending) semanticLoreIds = data.loreIds;
        }
        if (rulesRes.ok) {
            const data = await rulesRes.json();
            if (!data.pending) semanticRuleIds = data.ruleIds;
        }

        // Rerank candidates via LLM if enough results and a utility model is available.
        // Gate on utilityAvailable, not utilityEndpoint: under the host facade (every live
        // turn) utilityEndpoint is undefined and the call goes through modelCall, so the
        // old endpoint check silently disabled the reranker from 2026-08-01 (db71eb4).
        if (utilityAvailable && isBlockEnabled('reranker', config?.aiTier ?? state.settings.aiTier, state.settings.moduleEnabled)) {
            if (semanticArchiveIds && semanticArchiveIds.length >= 5) {
                const sceneCandidates: RerankCandidate[] = semanticArchiveIds.map(id => {
                    const idxEntry = archiveIndex.find(e => e.sceneId === id);
                    return {
                        id,
                        summary: idxEntry ? sceneRerankSummary(idxEntry) : id,
                        type: 'scene' as const,
                    };
                });
                const rerankedIds = await rerankCandidates(input, sceneCandidates, utilityEndpoint, { maxCandidates: 30, topN: 12 }, modelCall);
                semanticArchiveIds = rerankedIds;
                console.log(`[Reranker] Scene candidates: ${rerankedIds.length} after rerank`);
            }

            if (semanticLoreIds && semanticLoreIds.length >= 5) {
                const loreCandidates: RerankCandidate[] = semanticLoreIds.map(id => {
                    const chunk = loreChunks.find((c: LoreChunk) => c.id === id);
                    return {
                        id,
                        summary: chunk ? `${chunk.header} — ${chunk.summary || chunk.content.slice(0, 80)}` : id,
                        type: 'lore' as const,
                    };
                });
                const rerankedLoreIds = await rerankCandidates(input, loreCandidates, utilityEndpoint, { maxCandidates: 25, topN: 10 }, modelCall);
                semanticLoreIds = rerankedLoreIds;
                console.log(`[Reranker] Lore candidates: ${rerankedLoreIds.length} after rerank`);
            }
        }
    } catch (err) {
        console.warn('[ContextGatherer] Semantic candidates fetch failed:', err);
    }

    return { semanticArchiveIds, semanticLoreIds, semanticRuleIds };
}
