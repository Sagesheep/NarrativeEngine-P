import type { ArchiveScene, TimelineEvent, LoreChunk, ArchiveChapter, NPCEntry } from '../types';
import type { TurnState } from './turnOrchestrator';
import { API_BASE as API } from '../lib/apiBase';
import { retrieveRelevantLore } from './loreRetriever';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { rankChapters, recallWithChapterFunnel } from './archiveChapterEngine';
import { recommendContext } from './contextRecommender';
import { deepArchiveScan } from './deepArchiveSearch';
import { getDivergenceSceneIds, EMPTY_REGISTER, buildSceneMap } from './divergenceRegister';
import { rerankCandidates, type RerankCandidate } from './semanticReranker';
import { callLLM } from './callLLM';

const CALLBACK_REGEX = /\b(remember|earlier|back when|before|previously|that .*(we|i) (did|met|fought|saw|found|got))\b/i;

async function expandQuery(query: string, npcLedger: NPCEntry[], utilityEndpoint: import('../types').EndpointConfig): Promise<string[]> {
    try {
        const npcContext = npcLedger.slice(0, 10).map(n => n.name).join(', ');
        const prompt = `User query: "${query}"
Known NPCs: ${npcContext}
Generate 2 alternative phrasings that expand pronouns, add likely entity names from context, and use synonyms. Return ONLY a JSON array of 2 strings. No prose.`;

        const raw = await callLLM(utilityEndpoint, prompt, {
            temperature: 0.2,
            priority: 'high',
            maxTokens: 200,
        });

        let clean = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];

        const bracketStart = clean.indexOf('[');
        const bracketEnd = clean.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1) return [query];

        const parsed = JSON.parse(clean.substring(bracketStart, bracketEnd + 1));
        if (Array.isArray(parsed) && parsed.length >= 2 && parsed.every((x: unknown) => typeof x === 'string')) {
            return [query, parsed[0], parsed[1]];
        }
        return [query];
    } catch {
        return [query];
    }
}

export type GatheredContext = {
    sceneNumber: string | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    recommendedNPCNames: string[] | undefined;
    timelineEvents: TimelineEvent[];
    relevantLore: LoreChunk[] | undefined;
    semanticArchiveIds: string[] | undefined;
    semanticLoreIds: string[] | undefined;
    inventoryCategories: string[] | undefined;
    profileFields: string[] | undefined;
    deepContextSummary?: string;
};

type GatherDeps = {
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    deepSearchThisTurn: boolean;
    setLoadingStatus?: (status: string | null) => void;
};

export async function gatherContext(
    state: TurnState,
    finalInput: string,
    deps: GatherDeps,
    signal?: AbortSignal
): Promise<GatheredContext> {
    const { input, messages, loreChunks, npcLedger, archiveIndex, activeCampaignId, context } = state;

    const candidateMessages = (state.condenser?.condensedSummary && state.condenser?.condensedUpToIndex !== undefined && state.condenser.condensedUpToIndex >= 0)
        ? messages.slice(state.condenser.condensedUpToIndex + 1)
        : messages;
    const sceneMap = archiveIndex.length > 0 ? buildSceneMap(archiveIndex, candidateMessages) : null;
    const excludeSceneIds = sceneMap
        ? new Set(Object.values(sceneMap.sceneIdsByMessageId))
        : undefined;

    // Prepare mutable state for parallel promises
    let sceneNumber: string | undefined;
    let archiveRecall: ArchiveScene[] | undefined;
    let recommendedNPCNames: string[] | undefined;
    let inventoryCategories: string[] | undefined;
    let profileFields: string[] | undefined;
    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;

    // ─── Semantic Candidate Pre-filter ───
    const semanticPromise = activeCampaignId
        ? (async () => {
            try {
                // Query expansion for callback phrases or short queries
                let queries = [input];
                const utilityEndpoint = state.getUtilityEndpoint?.();
                const isCallback = CALLBACK_REGEX.test(input);
                const isShort = input.trim().split(/\s+/).length < 8;
                if ((isCallback || isShort) && utilityEndpoint?.endpoint) {
                    const expanded = await expandQuery(input, npcLedger, utilityEndpoint);
                    queries = expanded;
                    if (expanded.length > 1) {
                        console.log(`[QueryExpansion] "${input}" → ${expanded.length} variants`);
                    }
                }

                const queryBody = queries.length > 1 ? { queries } : { query: input };
                const [archiveRes, loreRes] = await Promise.all([
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
                ]);
                if (archiveRes.ok) {
                    const data = await archiveRes.json();
                    semanticArchiveIds = data.sceneIds;
                }
                if (loreRes.ok) {
                    const data = await loreRes.json();
                    semanticLoreIds = data.loreIds;
                }

                // Rerank candidates via LLM if enough results and utility endpoint available
                if (utilityEndpoint?.endpoint) {
                    if (semanticArchiveIds && semanticArchiveIds.length >= 5) {
                        const sceneCandidates: RerankCandidate[] = semanticArchiveIds.map(id => {
                            const idxEntry = archiveIndex.find(e => e.sceneId === id);
                            return {
                                id,
                                summary: idxEntry ? `${idxEntry.userSnippet} — ${idxEntry.keywords.slice(0, 5).join(', ')}` : id,
                                type: 'scene' as const,
                            };
                        });
                        const rerankedIds = await rerankCandidates(input, sceneCandidates, utilityEndpoint, { maxCandidates: 30, topN: 12 });
                        semanticArchiveIds = rerankedIds;
                        console.log(`[Reranker] Scene candidates: ${rerankedIds.length} after rerank`);
                    }

                    if (semanticLoreIds && semanticLoreIds.length >= 5) {
                        const loreCandidates: RerankCandidate[] = semanticLoreIds.map(id => {
                            const chunk = loreChunks.find(c => c.id === id);
                            return {
                                id,
                                summary: chunk ? `${chunk.header} — ${chunk.summary || chunk.content.slice(0, 80)}` : id,
                                type: 'lore' as const,
                            };
                        });
                        const rerankedLoreIds = await rerankCandidates(input, loreCandidates, utilityEndpoint, { maxCandidates: 25, topN: 10 });
                        semanticLoreIds = rerankedLoreIds;
                        console.log(`[Reranker] Lore candidates: ${rerankedLoreIds.length} after rerank`);
                    }
                }
            } catch (err) {
                console.warn('[ContextGatherer] Semantic candidates fetch failed:', err);
            }
        })()
        : Promise.resolve();

    const timelinePromise = activeCampaignId
        ? fetch(`${API}/campaigns/${activeCampaignId}/archive/next-scene`, { signal })
            .then(async res => {
                if (res.ok) {
                    const snData = await res.json();
                    sceneNumber = snData.sceneId;
                    console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
                }
            }).catch(() => { /* ignored */ })
        : Promise.resolve();

    // ─── Phase 4A: Two-Stage Chapter Funnel Retrieval ───
    const archivePromise = (archiveIndex.length > 0 && activeCampaignId)
        ? (async () => {
            await semanticPromise;

            const chapters = deps.chapters;
            const hasSealedChapters = chapters.some(c => c.sealedAt && c.summary);

            if (!hasSealedChapters) {
                const result = await recallArchiveScenes(
                    activeCampaignId, archiveIndex, input, messages, 3000,
                    npcLedger, (state as any).semanticFacts,
                    undefined, semanticArchiveIds,
                    getDivergenceSceneIds(state.divergenceRegister || EMPTY_REGISTER),
                    excludeSceneIds
                );
                archiveRecall = result;
                return;
            }

            const rankedChapters = rankChapters(
                chapters, input, messages, npcLedger, (state as any).semanticFacts
            );

            const utilityConfig = state.getUtilityEndpoint?.();
            const FUNNEL_TIMEOUT_MS = 8000;

            const funnelPromise = recallWithChapterFunnel(
                chapters, archiveIndex, input, messages,
                npcLedger, (state as any).semanticFacts, utilityConfig,
                activeCampaignId, 3000, excludeSceneIds
            );

            const timeoutPromise = new Promise<ArchiveScene[]>((resolve) => {
                setTimeout(() => {
                    console.warn('[ChapterFunnel] Timeout - using top-3 fallback');
                    const fallbackRanges: [string, string][] = rankedChapters
                        .slice(0, 3)
                        .map(ch => ch.sceneRange);
                    const openChapter = chapters.find(c => !c.sealedAt);
                    if (openChapter) fallbackRanges.push(openChapter.sceneRange);

                    const matchedIds = retrieveArchiveMemory(
                        archiveIndex, input, messages, npcLedger,
                        undefined, (state as any).semanticFacts, fallbackRanges,
                        undefined, semanticArchiveIds,
                        getDivergenceSceneIds(state.divergenceRegister || EMPTY_REGISTER),
                        excludeSceneIds
                    );
                    fetchArchiveScenes(activeCampaignId!, matchedIds, 3000)
                        .then(resolve)
                        .catch(() => resolve([]));
                }, FUNNEL_TIMEOUT_MS);
            });

            archiveRecall = await Promise.race([funnelPromise, timeoutPromise]);

            if (archiveRecall.length === 0) {
                console.warn('[ChapterFunnel] Empty result - falling back to flat retrieval');
                archiveRecall = await recallArchiveScenes(
                    activeCampaignId, archiveIndex, input, messages, 3000,
                    npcLedger, (state as any).semanticFacts,
                    undefined, semanticArchiveIds,
                    getDivergenceSceneIds(state.divergenceRegister || EMPTY_REGISTER),
                    excludeSceneIds
                );
            }
        })()
        : Promise.resolve();

    const utilityEndpoint = state.getUtilityEndpoint?.();
    const pinnedChaptersForRecommender = deps.pinnedChapterIds.length > 0
        ? deps.chapters.filter(c => deps.pinnedChapterIds.includes(c.chapterId))
        : undefined;
    const recommenderPromise = utilityEndpoint?.endpoint ? recommendContext(
        utilityEndpoint,
        npcLedger,
        loreChunks,
        messages,
        finalInput,
        signal,
        pinnedChaptersForRecommender,
        context.inventoryItems,
        context.characterProfileData
    ).then(result => {
        recommendedNPCNames = result.relevantNPCNames;
        inventoryCategories = result.inventoryCategories;
        profileFields = result.profileFields;
        console.log(`[ContextGatherer] Recommender returned: ${recommendedNPCNames?.length || 0} NPCs, ${result.relevantLoreIds.length} lore, ${inventoryCategories?.length || 0} inv cats, ${profileFields?.length || 0} profile fields`);
    }).catch(err => {
        console.warn('[ContextGatherer] UtilityAI recommender failed:', err);
    }) : Promise.resolve();

    // Lore retrieval — wait for semantic candidates first
    const lorePromise = (async () => {
        await semanticPromise;
        return loreChunks.length > 0
            ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, input, 1200, messages, semanticLoreIds)
            : undefined;
    })();

    // Timeline events — from state, used directly in buildPayload
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // Await all async operations simultaneously, with a 15s safety timeout.
    const CONTEXT_GATHER_TIMEOUT_MS = 15_000;
    await Promise.race([
        Promise.all([timelinePromise, archivePromise, recommenderPromise, lorePromise]),
        new Promise<void>((resolve) => setTimeout(() => {
            console.warn('[ContextGatherer] Context gather timeout — proceeding with partial results');
            resolve();
        }, CONTEXT_GATHER_TIMEOUT_MS)),
    ]);

    const relevantLore = await lorePromise;

    // ─── Pinned Chapter Injection ──────────────────────────────────────
    if (deps.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));

        const pinnedRanges: [string, string][] = deps.pinnedChapterIds
            .map(id => deps.chapters.find(c => c.chapterId === id))
            .filter((c): c is ArchiveChapter => !!c)
            .map(c => c.sceneRange);

        if (pinnedRanges.length > 0) {
            const scoredIds = retrieveArchiveMemory(
                archiveIndex, input, messages, npcLedger,
                undefined, (state as any).semanticFacts,
                pinnedRanges, undefined, semanticArchiveIds,
                getDivergenceSceneIds(state.divergenceRegister || EMPTY_REGISTER),
                excludeSceneIds
            ).filter(id => !alreadyCoveredIds.has(id));

            if (scoredIds.length > 0) {
                try {
                    const pinnedBudget = Math.floor((state.settings.contextLimit || 8192) * 0.35);
                    const pinnedScenes = await fetchArchiveScenes(activeCampaignId, scoredIds, pinnedBudget);
                    archiveRecall = [...(archiveRecall ?? []), ...pinnedScenes];
                    console.log(`[Pin] Injected ${pinnedScenes.length} scored scenes from ${pinnedRanges.length} pinned chapter(s)`);
                } catch (err) {
                    console.warn('[Pin] Failed to fetch pinned scenes:', err);
                }
            }
        }
        deps.clearPinnedChapters();
    }

    // ─── Deep Archive Search (one-shot) ──────────────────────────────────
    let deepContextSummary: string | undefined;

    if (deps.deepSearchThisTurn && activeCampaignId && utilityEndpoint?.endpoint) {
        try {
            const sealedChapters = deps.chapters.filter(c => c.sealedAt !== undefined);
            if (sealedChapters.length > 0) {
                const deepBudget = Math.floor((state.settings.contextLimit || 8192) * 0.45);
                deepContextSummary = await deepArchiveScan(
                    utilityEndpoint,
                    archiveIndex,
                    sealedChapters,
                    activeCampaignId,
                    messages,
                    finalInput,
                    deepBudget,
                    (msg) => deps.setLoadingStatus?.(msg),
                    signal,
                );
                console.log(`[DeepArchiveSearch] Brief generated: ~${Math.ceil((deepContextSummary || '').length / 4)} tokens`);
            }
        } catch (err) {
            console.warn('[DeepArchiveSearch] Failed, standard recall used:', err);
        }
    }

    return { sceneNumber, archiveRecall, recommendedNPCNames, timelineEvents, relevantLore, semanticArchiveIds, semanticLoreIds, inventoryCategories, profileFields, deepContextSummary };
}
