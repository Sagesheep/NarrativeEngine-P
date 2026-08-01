import type { ArchiveScene, ArchiveChapter } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from '../archiveMemory';
import { rankChapters, recallWithChapterFunnel } from '../archive-memory/archiveChapterEngine';
import { runArchivePlanner } from '../archive-memory/archivePlanner';
import { getDivergenceSceneIds, EMPTY_REGISTER, buildSceneMap } from '../campaign-state/divergenceRegister';
import { tierAllows } from '../turn/aiTier';
import type { SemanticCandidates } from './semanticCandidates';
import { hasHostModelRole, type HostFacade } from '../turn/hostFacade';

export type ArchiveRecallDeps = {
    chapters: ArchiveChapter[];
};

export async function gatherPlannerSceneIds(
    state: TurnState,
    signal?: AbortSignal,
    facade?: HostFacade,
): Promise<string[] | undefined> {
    const plannerEndpoint = facade ? undefined : state.getUtilityEndpoint?.();
    const plannerEnabled = facade?.config.enableArchivePlanner ?? state.settings.enableArchivePlanner;
    const plannerAvailable = facade ? hasHostModelRole(facade, 'utility') : Boolean(plannerEndpoint?.endpoint);
    if (tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'planner') && plannerEnabled && plannerAvailable) {
        try {
            return await runArchivePlanner(
                plannerEndpoint,
                facade?.data.input ?? state.input,
                facade?.data.archiveIndex ?? state.archiveIndex,
                signal,
                facade ? (request: import('../turn/hostFacade').ModelRequest) => facade.model.call('utility', request) : undefined
            );
        } catch {
            return undefined;
        }
    }
    return undefined;
}

export async function gatherArchiveRecall(
    state: TurnState,
    deps: ArchiveRecallDeps,
    semanticCandidates: SemanticCandidates,
    plannerSceneIds: string[] | undefined,
    excludeSceneIds: Set<string> | undefined,
    // Accepted for signature symmetry with gatherPlannerSceneIds, but the archive
    // recall path (recallArchiveScenes / recallWithChapterFunnel) has no AbortSignal
    // plumbing yet, so cancellation is not wired through here. See follow-up.
    signal?: AbortSignal,
    facade?: HostFacade
): Promise<ArchiveScene[] | undefined> {
    void signal;
    const data = facade?.data;
    const input = data?.input ?? state.input;
    const messages = data?.messages ?? state.messages;
    const npcLedger = data?.npcLedger ?? state.npcLedger;
    const archiveIndex = data?.archiveIndex ?? state.archiveIndex;
    const activeCampaignId = data?.activeCampaignId ?? state.activeCampaignId;

    if (archiveIndex.length === 0 || !activeCampaignId) {
        return undefined;
    }

    const { semanticArchiveIds } = semanticCandidates;
    const archiveRecallDepth = facade?.config.archiveRecallDepth ?? state.settings.archiveRecallDepth ?? 'standard';
    const divergenceSceneIds = getDivergenceSceneIds((data?.divergenceRegister ?? state.divergenceRegister) || EMPTY_REGISTER);
    const chapters = deps.chapters;
    const hasSealedChapters = chapters.some(c => c.sealedAt && c.summary);

    if (!hasSealedChapters) {
        return recallArchiveScenes(
            activeCampaignId, archiveIndex, input, messages, 3000,
            npcLedger, (data?.semanticFacts ?? state.semanticFacts),
            undefined, semanticArchiveIds,
            divergenceSceneIds,
            excludeSceneIds,
            plannerSceneIds,
            archiveRecallDepth
        );
    }

    // Lite tier: skip the chapter funnel (LLM-backed) — fall through to flat recall.
    if (!tierAllows(facade?.config.aiTier ?? state.settings.aiTier, 'archiveFunnel')) {
        return recallArchiveScenes(
            activeCampaignId, archiveIndex, input, messages, 3000,
            npcLedger, (data?.semanticFacts ?? state.semanticFacts),
            undefined, semanticArchiveIds,
            divergenceSceneIds,
            excludeSceneIds,
            plannerSceneIds,
            archiveRecallDepth
        );
    }

    const rankedChapters = rankChapters(
        chapters, input, messages, npcLedger, (data?.semanticFacts ?? state.semanticFacts)
    );

    const utilityConfig = facade ? undefined : state.getUtilityEndpoint?.();
    const modelCall = facade ? (request: import('../turn/hostFacade').ModelRequest) => facade.model.call('utility', request) : undefined;
    const FUNNEL_TIMEOUT_MS = 8000;

    const funnelPromise = recallWithChapterFunnel(
        chapters, archiveIndex, input, messages,
        npcLedger, (data?.semanticFacts ?? state.semanticFacts), utilityConfig,
        activeCampaignId, 3000, excludeSceneIds, modelCall
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
                undefined, (data?.semanticFacts ?? state.semanticFacts), fallbackRanges,
                undefined, semanticArchiveIds,
                divergenceSceneIds,
                excludeSceneIds,
                plannerSceneIds,
                archiveRecallDepth
            );
            fetchArchiveScenes(activeCampaignId!, matchedIds, 3000)
                .then(resolve)
                .catch(() => resolve([]));
        }, FUNNEL_TIMEOUT_MS);
    });

    let archiveRecall = await Promise.race([funnelPromise, timeoutPromise]);

    if (archiveRecall.length === 0) {
        console.warn('[ChapterFunnel] Empty result - falling back to flat retrieval');
        archiveRecall = await recallArchiveScenes(
            activeCampaignId, archiveIndex, input, messages, 3000,
            npcLedger, (data?.semanticFacts ?? state.semanticFacts),
            undefined, semanticArchiveIds,
            divergenceSceneIds,
            excludeSceneIds,
            plannerSceneIds,
            archiveRecallDepth
        );
    }

    return archiveRecall;
}

export function buildExcludeSceneIds(state: TurnState): Set<string> | undefined {
    const { messages, archiveIndex } = state;
    const candidateMessages = (state.condenser?.condensedUpToIndex !== undefined && state.condenser.condensedUpToIndex >= 0)
        ? messages.slice(state.condenser.condensedUpToIndex + 1)
        : messages;
    const sceneMap = archiveIndex.length > 0 ? buildSceneMap(archiveIndex, candidateMessages) : null;
    return sceneMap
        ? new Set(Object.values(sceneMap.sceneIdsByMessageId))
        : undefined;
}
