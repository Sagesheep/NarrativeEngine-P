import type { ArchiveScene, TimelineEvent, LoreChunk, ArchiveChapter } from '../types';
import type { TurnState } from './turnOrchestrator';
import { API_BASE as API } from '../lib/apiBase';
import { retrieveRelevantLore } from './loreRetriever';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { rankChapters, recallWithChapterFunnel } from './archiveChapterEngine';
import { recommendContext } from './contextRecommender';

export type GatheredContext = {
    sceneNumber: string | undefined;
    archiveRecall: ArchiveScene[] | undefined;
    recommendedNPCNames: string[] | undefined;
    timelineEvents: TimelineEvent[];
    relevantLore: LoreChunk[] | undefined;
    semanticArchiveIds: string[] | undefined;
    semanticLoreIds: string[] | undefined;
};

type GatherDeps = {
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
};

export async function gatherContext(
    state: TurnState,
    finalInput: string,
    deps: GatherDeps,
    signal?: AbortSignal
): Promise<GatheredContext> {
    const { input, messages, loreChunks, npcLedger, archiveIndex, activeCampaignId, context } = state;

    // Prepare mutable state for parallel promises
    let sceneNumber: string | undefined;
    let archiveRecall: ArchiveScene[] | undefined;
    let recommendedNPCNames: string[] | undefined;
    let semanticArchiveIds: string[] | undefined;
    let semanticLoreIds: string[] | undefined;

    // ─── Semantic Candidate Pre-filter ───
    const semanticPromise = activeCampaignId
        ? (async () => {
            try {
                const [archiveRes, loreRes] = await Promise.all([
                    fetch(`${API}/campaigns/${activeCampaignId}/archive/semantic-candidates`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query: input }),
                        signal,
                    }),
                    fetch(`${API}/campaigns/${activeCampaignId}/lore/semantic-candidates`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ query: input }),
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
                    undefined, undefined, semanticArchiveIds
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
                activeCampaignId, 3000
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
                        undefined, semanticArchiveIds
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
                    undefined, undefined, semanticArchiveIds
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
        pinnedChaptersForRecommender
    ).then(result => {
        recommendedNPCNames = result.relevantNPCNames;
        console.log(`[ContextGatherer] Recommender returned: ${recommendedNPCNames.length} NPCs, ${result.relevantLoreIds.length} lore`);
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
                pinnedRanges, undefined, semanticArchiveIds
            ).filter(id => !alreadyCoveredIds.has(id));

            if (scoredIds.length > 0) {
                try {
                    const pinnedScenes = await fetchArchiveScenes(activeCampaignId, scoredIds, 1500);
                    archiveRecall = [...(archiveRecall ?? []), ...pinnedScenes];
                    console.log(`[Pin] Injected ${pinnedScenes.length} scored scenes from ${pinnedRanges.length} pinned chapter(s)`);
                } catch (err) {
                    console.warn('[Pin] Failed to fetch pinned scenes:', err);
                }
            }
        }
        deps.clearPinnedChapters();
    }

    return { sceneNumber, archiveRecall, recommendedNPCNames, timelineEvents, relevantLore, semanticArchiveIds, semanticLoreIds };
}
