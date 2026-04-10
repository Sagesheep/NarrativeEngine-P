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
};

type GatherDeps = {
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
};

export async function gatherContext(
    state: TurnState,
    finalInput: string,
    deps: GatherDeps
): Promise<GatheredContext> {
    const { input, messages, loreChunks, npcLedger, archiveIndex, activeCampaignId, context } = state;

    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, input, 1200, messages)
        : undefined;

    // Prepare parallel promises
    let sceneNumber: string | undefined;
    let archiveRecall: ArchiveScene[] | undefined;
    let recommendedNPCNames: string[] | undefined;

    const timelinePromise = activeCampaignId
        ? fetch(`${API}/campaigns/${activeCampaignId}/archive/next-scene`)
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
            const chapters = deps.chapters;
            const hasSealedChapters = chapters.some(c => c.sealedAt && c.summary);

            if (!hasSealedChapters) {
                // No sealed chapters - use flat retrieval unchanged
                const result = await recallArchiveScenes(
                    activeCampaignId, archiveIndex, input, messages, 3000,
                    npcLedger, (state as any).semanticFacts
                );
                archiveRecall = result;
                return;
            }

            // Stage 1: Synchronous 3D scoring (~1ms)
            const rankedChapters = rankChapters(
                chapters, input, messages, npcLedger, (state as any).semanticFacts
            );

            // Stage 2: LLM validation with funnel timeout
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
                        undefined, (state as any).semanticFacts, fallbackRanges
                    );
                    fetchArchiveScenes(activeCampaignId!, matchedIds, 3000)
                        .then(resolve)
                        .catch(() => resolve([]));
                }, FUNNEL_TIMEOUT_MS);
            });

            archiveRecall = await Promise.race([funnelPromise, timeoutPromise]);

            // Double-fallback: if funnel returned empty
            if (archiveRecall.length === 0) {
                console.warn('[ChapterFunnel] Empty result - falling back to flat retrieval');
                archiveRecall = await recallArchiveScenes(
                    activeCampaignId, archiveIndex, input, messages, 3000,
                    npcLedger, (state as any).semanticFacts
                );
            }
        })()
        : Promise.resolve();

    const utilityEndpoint = state.getUtilityEndpoint?.();
    const recommenderPromise = utilityEndpoint?.endpoint ? recommendContext(
        utilityEndpoint,
        npcLedger,
        loreChunks,
        messages,
        finalInput
    ).then(result => {
        recommendedNPCNames = result.relevantNPCNames;
        console.log(`[ContextGatherer] Recommender returned: ${recommendedNPCNames.length} NPCs, ${result.relevantLoreIds.length} lore`);
    }).catch(err => {
        console.warn('[ContextGatherer] UtilityAI recommender failed:', err);
    }) : Promise.resolve();

    // Timeline events — from state, used directly in buildPayload
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // Await all async operations simultaneously, with a 15s safety timeout.
    const CONTEXT_GATHER_TIMEOUT_MS = 15_000;
    await Promise.race([
        Promise.all([timelinePromise, archivePromise, recommenderPromise]),
        new Promise<void>((resolve) => setTimeout(() => {
            console.warn('[ContextGatherer] Context gather timeout — proceeding with partial results');
            resolve();
        }, CONTEXT_GATHER_TIMEOUT_MS)),
    ]);

    // ─── Pinned Chapter Injection ──────────────────────────────────────
    if (deps.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));
        for (const pinnedId of deps.pinnedChapterIds) {
            const pinnedChapter = deps.chapters.find(c => c.chapterId === pinnedId);
            if (!pinnedChapter) continue;
            const startNum = parseInt(pinnedChapter.sceneRange[0], 10);
            const endNum = parseInt(pinnedChapter.sceneRange[1], 10);
            const sceneIds = Array.from({ length: endNum - startNum + 1 }, (_, i) =>
                String(startNum + i).padStart(3, '0')
            ).filter(id => !alreadyCoveredIds.has(id));
            if (sceneIds.length > 0) {
                try {
                    const pinnedScenes = await fetchArchiveScenes(activeCampaignId, sceneIds, 1500);
                    archiveRecall = [...(archiveRecall ?? []), ...pinnedScenes];
                    console.log(`[Pin] Injected ${pinnedScenes.length} scenes from pinned chapter ${pinnedId}`);
                } catch (err) {
                    console.warn(`[Pin] Failed to fetch pinned chapter ${pinnedId}:`, err);
                }
            }
        }
        deps.clearPinnedChapters();
    }

    return { sceneNumber, archiveRecall, recommendedNPCNames, timelineEvents, relevantLore };
}
