import type { ArchiveScene, ArchiveChapter, ArchiveIndexEntry, ChatMessage, NPCEntry, ProviderConfig, EndpointConfig } from '../../types';
import type { TurnState } from '../turn/turnOrchestrator';
import { retrieveArchiveMemory, fetchRecallScenes } from '../archiveMemory';
import { rankChapters, selectArchiveSceneIdsWithChapterFunnel } from '../archive-memory/archiveChapterEngine';
import { applyRecallPicks, runRecallPicker, PICKER_CANDIDATES, type PickerCandidate } from '../archive-memory/recallPicker';
import { recallShortForm } from '../archive-memory/recall';
import { getDivergenceSceneIds, EMPTY_REGISTER, buildSceneMap } from '../campaign-state/divergenceRegister';
import { isBlockEnabled } from '../turn/blockEnablement';
import type { SemanticCandidates } from './semanticCandidates';
import type { HostFacade } from '../turn/hostFacade';
import type { RecallDepth } from '../archive-memory/dynamicMax';
import { normalizeSceneRecallBudget } from '../archive-memory/recallBudget';

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
    /** The Block View toggles (`settings.moduleEnabled`); an explicit entry beats the tier preset. */
    readonly moduleEnabled?: Record<string, boolean>;
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
    sceneRanges?: [string, string][],
    maxScenes?: number,
): string[] {
    return retrieveArchiveMemory(
        input.archiveIndex as ArchiveIndexEntry[],
        input.query,
        input.messages as ChatMessage[],
        input.npcLedger as NPCEntry[],
        maxScenes,
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

/**
 * The Recall Picker block (block id `planner`, which it replaced): a utility model
 * reads the one-line definitions of the engine's best 30 candidates and picks what
 * the GM needs, best first. Its first pick is the scene recalled in full. Off,
 * without a utility model, or on any failure, the engine's order stands.
 *
 * Whether it runs is decided synchronously, so a turn where it does not run keeps
 * exactly the await steps it had before (the base-app gate's trace pins them).
 */
function recallPickerCandidates(
    input: MemoryRecallInput,
    context: MemoryRecallCoreContext,
    engineIds: string[],
): PickerCandidate[] | null {
    if (engineIds.length === 0) return null;
    if (!isBlockEnabled('planner', context.aiTier, context.moduleEnabled)) return null;
    const hasModel = Boolean(context.modelCall) || Boolean((context.utilityProvider as EndpointConfig | undefined)?.endpoint);
    if (!hasModel) return null;

    const byId = new Map(input.archiveIndex.map(e => [e.sceneId, e]));
    const engineCandidates = flatMemoryRecallIds(input, undefined, PICKER_CANDIDATES);
    const candidates = engineCandidates
        .map(sceneId => ({ sceneId, line: recallShortForm(byId.get(sceneId)) }))
        .filter((c): c is PickerCandidate => Boolean(c.line));
    return candidates.length < 2 ? null : candidates;
}

async function pickMemoryRecallIds(
    input: MemoryRecallInput,
    context: MemoryRecallCoreContext,
    engineIds: string[],
    candidates: PickerCandidate[],
): Promise<string[]> {
    const lastReply = [...input.messages].reverse().find(m => m.role === 'assistant' && typeof m.content === 'string')?.content;
    const picks = await runRecallPicker({
        userMessage: input.query,
        lastReply: typeof lastReply === 'string' ? lastReply : '',
        candidates,
        provider: context.utilityProvider,
        modelCall: context.modelCall,
    });
    if (!picks || picks.length === 0) return engineIds;
    return applyRecallPicks(engineIds, picks);
}

/** Select IDs only. The host performs archive fetches after a provider answers. */
export async function selectMemoryRecallIds(
    input: MemoryRecallInput,
    context: MemoryRecallCoreContext,
): Promise<string[] | undefined> {
    if (input.archiveIndex.length === 0 || !input.campaignId) return undefined;

    const chapters = context.chapters as ArchiveChapter[];
    const hasSealedChapters = chapters.some((chapter) => chapter.sealedAt && chapter.summary);
    // The funnel is off in every preset: on the Turn Prep memory probes it locked onto
    // the wrong chapters, and its scene step is keyword-only (it never sees the meaning
    // search or the planner), while archive-wide search found the right scenes. Read
    // through the block switch so a user who turns it back on gets it.
    if (!hasSealedChapters || !isBlockEnabled('archiveFunnel', context.aiTier, context.moduleEnabled)) {
        const engineIds = flatMemoryRecallIds(input);
        const picker = recallPickerCandidates(input, context, engineIds);
        return picker ? pickMemoryRecallIds(input, context, engineIds, picker) : engineIds;
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

/**
 * The Archive Planner is retired: the Recall Picker took its Block View switch
 * (`planner`) and runs inside memory recall, where it can decide which scene is
 * recalled in full. This stays as the turn's "Planning search" stage, resolving at
 * once, so a mod-supplied `plannerSceneIds` contract and the turn's timing are unchanged.
 */
export async function gatherPlannerSceneIds(
    _state: TurnState,
    _signal?: AbortSignal,
    _facade?: HostFacade,
): Promise<string[] | undefined> {
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
        tokenBudget: facade?.config.sceneRecallBudget ?? normalizeSceneRecallBudget(state.settings.sceneRecallBudget),
    };
    setMemoryRecallDefaultContext({
        chapters: deps.chapters,
        aiTier: facade?.config.aiTier ?? state.settings.aiTier,
        moduleEnabled: state.settings.moduleEnabled,
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
    return fetchRecallScenes(activeCampaignId, filteredSceneIds, recallInput.tokenBudget, archiveIndex);
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
