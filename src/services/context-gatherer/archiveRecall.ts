import type { ArchiveScene, ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, ProviderConfig, EndpointConfig } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { retrieveArchiveMemory, fetchArchiveScenes } from '../archiveMemory';
import { rankChapters, selectArchiveSceneIdsWithChapterFunnel } from '../archive-memory/archiveChapterEngine';
import { runArchivePlanner } from '../archive-memory/archivePlanner';
import { getDivergenceSceneIds, EMPTY_REGISTER, buildSceneMap } from '../campaign-state/divergenceRegister';
import { tierAllows } from '../turn/aiTier';
import type { SemanticCandidates } from './semanticCandidates';
import { hasHostModelRole, type HostFacade } from '../turn/hostFacade';
import type { RecallDepth } from '../archive-memory/dynamicMax';

export interface MemoryRecallInput {
    readonly campaignId: string;
    readonly query: string;
    readonly messages: readonly ChatMessage[];
    readonly archiveIndex: readonly ArchiveIndexEntry[];
    readonly chapters: readonly {
        readonly chapterId: string;
        readonly title: string;
        readonly sealedAt: number | null;
        readonly sceneIds: readonly string[];
        readonly summary: string;
    }[];
    readonly npcLedger: readonly NPCEntry[];
    readonly semanticFacts: readonly { subject: string; predicate: string; object: string; importance: number }[];
    readonly candidateSceneIds?: readonly string[];
    readonly plannerSceneIds?: readonly string[];
    readonly excludeSceneIds: readonly string[];
    readonly divergenceSceneIds: readonly string[];
    readonly depth: RecallDepth;
    readonly tokenBudget: number;
}

export interface MemoryRecallAnswer {
    readonly sceneIds: readonly string[];
}

export interface MemoryRecallCoreContext {
    readonly chapters: readonly ArchiveChapter[];
    readonly aiTier: TurnState['settings']['aiTier'];
    readonly utilityProvider?: EndpointConfig | ProviderConfig;
    readonly modelCall?: (request: import('../turn/hostFacade').ModelRequest) => Promise<import('../turn/hostFacade').ModelResponse>;
}

let currentDefaultContext: MemoryRecallCoreContext | undefined;

/** The default provider captures this synchronously at the ask boundary. */
export function setMemoryRecallDefaultContext(context: MemoryRecallCoreContext): void {
    currentDefaultContext = context;
}

export function toMemoryRecallChapters(chapters: readonly ArchiveChapter[]): MemoryRecallInput['chapters'] {
    return chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        title: chapter.title,
        sealedAt: typeof chapter.sealedAt === 'number' ? chapter.sealedAt : null,
        sceneIds: [...chapter.sceneIds],
        summary: chapter.summary,
    }));
}

function flatMemoryRecallIds(
    input: MemoryRecallInput,
    sceneRanges?: [string, string][]
): string[] {
    return retrieveArchiveMemory(
        input.archiveIndex as ArchiveIndexEntry[],
        input.query,
        input.messages as ChatMessage[],
        input.npcLedger as NPCEntry[],
        undefined,
        input.semanticFacts as { subject: string; predicate: string; object: string; importance: number }[],
        sceneRanges,
        undefined,
        input.candidateSceneIds as string[] | undefined,
        new Set(input.divergenceSceneIds),
        new Set(input.excludeSceneIds),
        input.plannerSceneIds as string[] | undefined,
        input.depth,
        input.campaignId,
    );
}

/** Select IDs only. The host performs archive fetches after a provider answers. */
export async function selectMemoryRecallIds(
    input: MemoryRecallInput,
    context: MemoryRecallCoreContext,
): Promise<string[] | undefined> {
    if (input.archiveIndex.length === 0 || !input.campaignId) return undefined;

    const chapters = context.chapters as ArchiveChapter[];
    const hasSealedChapters = chapters.some((chapter) => chapter.sealedAt && chapter.summary);
    if (!hasSealedChapters || !tierAllows(context.aiTier, 'archiveFunnel')) {
        return flatMemoryRecallIds(input);
    }

    const rankedChapters = rankChapters(
        chapters,
        input.query,
        input.messages as ChatMessage[],
        input.npcLedger as NPCEntry[],
        input.semanticFacts as { subject: string; predicate: string; object: string; importance: number }[],
    );
    const funnelPromise = selectArchiveSceneIdsWithChapterFunnel(
        chapters,
        input.archiveIndex as ArchiveIndexEntry[],
        input.query,
        input.messages as ChatMessage[],
        input.npcLedger as NPCEntry[],
        input.semanticFacts as { subject: string; predicate: string; object: string; importance: number }[],
        context.utilityProvider,
        new Set(input.excludeSceneIds),
        context.modelCall,
    );

    const timeoutPromise = new Promise<string[]>((resolve) => {
        setTimeout(() => {
            console.warn('[ChapterFunnel] Timeout - using top-3 fallback');
            const fallbackRanges: [string, string][] = rankedChapters
                .slice(0, 3)
                .map((chapter) => chapter.sceneRange);
            const openChapter = chapters.find((chapter) => !chapter.sealedAt);
            if (openChapter) fallbackRanges.push(openChapter.sceneRange);
            resolve(flatMemoryRecallIds(input, fallbackRanges));
        }, 8000);
    });

    let sceneIds = await Promise.race([funnelPromise, timeoutPromise]);
    if (sceneIds.length === 0) {
        console.warn('[ChapterFunnel] Empty result - falling back to flat retrieval');
        sceneIds = flatMemoryRecallIds(input);
    }
    return sceneIds;
}

export async function askDefaultMemoryRecall(
    input: MemoryRecallInput,
    signal: AbortSignal,
): Promise<MemoryRecallAnswer | undefined> {
    void signal;
    const context = currentDefaultContext;
    if (!context) return undefined;
    const sceneIds = await selectMemoryRecallIds(input, context);
    return sceneIds === undefined ? undefined : { sceneIds };
}

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
    // Accepted for signature symmetry with gatherPlannerSceneIds. The role
    // boundary currently has no caller-signal parameter, so cancellation is
    // not wired through this path yet.
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
    const recallInput: MemoryRecallInput = {
        campaignId: activeCampaignId,
        query: input,
        messages,
        archiveIndex,
        chapters: toMemoryRecallChapters(deps.chapters),
        npcLedger,
        semanticFacts: (data?.semanticFacts ?? state.semanticFacts ?? []).map(({ subject, predicate, object, importance }) => ({
            subject,
            predicate,
            object,
            importance,
        })),
        candidateSceneIds: semanticArchiveIds,
        plannerSceneIds,
        excludeSceneIds: [...(excludeSceneIds ?? [])],
        divergenceSceneIds: [...divergenceSceneIds],
        depth: archiveRecallDepth,
        tokenBudget: 3000,
    };
    setMemoryRecallDefaultContext({
        chapters: deps.chapters,
        aiTier: facade?.config.aiTier ?? state.settings.aiTier,
        utilityProvider: facade ? undefined : state.getUtilityEndpoint?.(),
        modelCall: facade
            ? (request: import('../turn/hostFacade').ModelRequest) => facade.model.call('utility', request)
            : undefined,
    });
    const sceneIds = await askDefaultMemoryRecall(recallInput, signal ?? new AbortController().signal);
    if (!sceneIds || sceneIds.sceneIds.length === 0) return sceneIds ? [] : undefined;
    const knownSceneIds = new Set(archiveIndex.map((entry) => entry.sceneId));
    const filteredSceneIds = sceneIds.sceneIds.filter((sceneId) => knownSceneIds.has(sceneId));
    if (filteredSceneIds.length === 0) return [];
    return fetchArchiveScenes(activeCampaignId, filteredSceneIds, recallInput.tokenBudget);
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
