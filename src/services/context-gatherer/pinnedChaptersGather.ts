import type { ArchiveScene, ArchiveChapter } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { retrieveArchiveMemory, fetchArchiveScenes } from '../archiveMemory';
import { getDivergenceSceneIds, EMPTY_REGISTER } from '../campaign-state/divergenceRegister';
import type { SemanticCandidates } from './semanticCandidates';

export type PinnedChaptersDeps = {
    pinnedChapterIds: string[];
    chapters: ArchiveChapter[];
    clearPinnedChapters: () => void;
};

export async function injectPinnedChapters(
    state: TurnState,
    deps: PinnedChaptersDeps,
    archiveRecall: ArchiveScene[] | undefined,
    semanticCandidates: SemanticCandidates,
    plannerSceneIds: string[] | undefined,
    excludeSceneIds: Set<string> | undefined
): Promise<ArchiveScene[] | undefined> {
    if (deps.pinnedChapterIds.length === 0 || !state.activeCampaignId) {
        return archiveRecall;
    }

    const { input, messages, npcLedger, archiveIndex } = state;
    const { semanticArchiveIds } = semanticCandidates;
    const archiveRecallDepth = state.settings.archiveRecallDepth ?? 'standard';
    const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));

    const pinnedRanges: [string, string][] = deps.pinnedChapterIds
        .map(id => deps.chapters.find(c => c.chapterId === id))
        .filter((c): c is ArchiveChapter => !!c)
        .map(c => c.sceneRange);

    if (pinnedRanges.length > 0) {
        const scoredIds = retrieveArchiveMemory(
            archiveIndex, input, messages, npcLedger,
            undefined, state.semanticFacts,
            pinnedRanges, undefined, semanticArchiveIds,
            getDivergenceSceneIds(state.divergenceRegister || EMPTY_REGISTER),
            excludeSceneIds,
            plannerSceneIds,
            archiveRecallDepth
        ).filter(id => !alreadyCoveredIds.has(id));

        if (scoredIds.length > 0) {
            try {
                const pinnedBudget = Math.floor((state.settings.contextLimit || 8192) * 0.35);
                const pinnedScenes = await fetchArchiveScenes(state.activeCampaignId!, scoredIds, pinnedBudget);
                archiveRecall = [...(archiveRecall ?? []), ...pinnedScenes];
                console.log(`[Pin] Injected ${pinnedScenes.length} scored scenes from ${pinnedRanges.length} pinned chapter(s)`);
            } catch (err) {
                console.warn('[Pin] Failed to fetch pinned scenes:', err);
            }
        }
    }

    deps.clearPinnedChapters();
    return archiveRecall;
}
