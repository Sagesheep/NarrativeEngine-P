import type { NPCEntry, LoreChunk } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { API_BASE as API } from '../../lib/apiBase';
import { rerankCandidates, type RerankCandidate } from '../retrieval/semanticReranker';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { tierAllows } from '../turn/aiTier';
import { hasHostModelRole, type HostFacade, type ModelRequest, type ModelResponse } from '../turn/hostFacade';

const CALLBACK_REGEX = /\b(remember|earlier|back when|before|previously|that .*(we|i) (did|met|fought|saw|found|got))\b/i;

async function expandQuery(query: string, npcLedger: NPCEntry[], utilityEndpoint: import('../../types').EndpointConfig | undefined, modelCall?: (request: ModelRequest) => Promise<ModelResponse>): Promise<string[]> {
    try {
        const npcContext = npcLedger.slice(0, 10).map(n => n.name).join(', ');
        const prompt = `User query: "${query}"
Known NPCs: ${npcContext}
Generate 2 alternative phrasings that expand pronouns, add likely entity names from context, and use synonyms. Return ONLY a JSON array of 2 strings. No prose.`;

        const raw = modelCall
            ? (await modelCall({ prompt, temperature: 0.2, priority: 'high', maxTokens: 200, trackingLabel: 'query-expansion', timeoutMs: AI_CALL_TIMEOUT_MS })).content
            : utilityEndpoint
                ? await llmCall(utilityEndpoint, prompt, { temperature: 0.2, priority: 'high', maxTokens: 200, trackingLabel: 'query-expansion', timeoutMs: AI_CALL_TIMEOUT_MS })
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
        if ((isCallback || isShort) && hasRetrievableContent && utilityAvailable && tierAllows(config?.aiTier ?? state.settings.aiTier, 'expandQuery')) {
            const expanded = await expandQuery(input, npcLedger, utilityEndpoint, modelCall);
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

        // Rerank candidates via LLM if enough results and utility endpoint available
        if (utilityEndpoint?.endpoint && tierAllows(state.settings.aiTier, 'reranker')) {
            if (semanticArchiveIds && semanticArchiveIds.length >= 5) {
                const sceneCandidates: RerankCandidate[] = semanticArchiveIds.map(id => {
                    const idxEntry = archiveIndex.find(e => e.sceneId === id);
                    return {
                        id,
                        summary: idxEntry ? `${idxEntry.userSnippet} — ${idxEntry.keywords.slice(0, 5).join(', ')}` : id,
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
