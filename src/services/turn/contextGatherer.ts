import type { ArchiveChapter, TimelineEvent } from '../../types';
import type { TurnState } from './turnOrchestrator';
import { gatherSemanticCandidates } from '../context-gatherer/semanticCandidates';
import {
    gatherPlannerSceneIds,
    buildExcludeSceneIds,
    setMemoryRecallDefaultContext,
    toMemoryRecallChapters,
    type MemoryRecallAnswer,
    type MemoryRecallInput,
} from '../context-gatherer/archiveRecall';
import { gatherRecommender } from '../context-gatherer/recommenderGather';
import { gatherLoreAndRules } from '../context-gatherer/loreRulesGather';
import { injectPinnedChapters } from '../context-gatherer/pinnedChaptersGather';
import { gatherDeepSearch, gatherSemanticFacts } from '../context-gatherer/deepSearchGather';
import { gatherDynamicElevation, type ElevatedScene } from '../archive-memory/dynamicElevation';
import { gatherSlottedRag, type SlottedRagSnippet } from '../archive-memory/slottedRag';
import { beginGatherStage, endGatherStage, clearGatherStages } from './gatherProgress';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { LoreChunk } from '../../types';
import type { HostFacade } from './hostFacade';
import { fetchArchiveScenes } from '../archiveMemory';
import { EMPTY_REGISTER, getDivergenceSceneIds } from '../campaign-state/divergenceRegister';
import { formatRoleFaultReason, roleFaultStore, serviceRoles } from '../roles';
import {
    buildRelationshipStanceSceneContext,
    computeRelationshipStances,
    currentRelationshipSceneId,
    sceneKeyForRelationshipStance,
} from '../npc/relationshipStance';
import { hasHostModelRole } from './hostFacade';
import { blockTokenCap, isBlockEnabled } from './blockEnablement';
import { BUILTIN_IDS, getBuiltinTokenCap } from '../payload/contributions/builtins';
import { readRelationshipMemoryState, writeRelationshipMemoryState } from '../../store/relationshipMemoryState';

// Friendly, user-facing labels for the live step indicator (keyed by internal stage id).
const STAGE_LABELS: Record<string, string> = {
    'planner': 'Planning search',
    'semantic-candidates': 'Searching memory',
    'archive-recall': 'Recalling scenes',
    'recommender': 'Selecting context',
    'lore-rules': 'Loading lore & rules',
    'deep-search': 'Deep archive search',
    'dynamic-elevation': 'Elevating memories',
};

export type GatheredContext = {
    archiveRecall: import('../../types').ArchiveScene[] | undefined;
    recommendedNPCNames: string[] | undefined;
    timelineEvents: TimelineEvent[];
    relevantLore: LoreChunk[] | undefined;
    semanticArchiveIds: string[] | undefined;
    semanticLoreIds: string[] | undefined;
    inventoryCategories: string[] | undefined;
    profileFields: string[] | undefined;
    deepContextSummary?: string;
    semanticFactText?: string;
    relevantRules?: LoreChunk[];
    rulesManifest?: string;
    // WO-11: synopsis-tier scenes surfaced verbatim below the cache boundary for
    // this turn only. Attached chapterId for the labeled rendering in world.ts.
    elevatedScenes?: ElevatedScene[];
    elevatedSceneRankedIds?: string[];
    // WO-12: Slotted RAG — one-line snippets from synopsis-tier scenes that had
    // search hits but did NOT get elevated (WO-11). Reuses WO-11's ranked IDs —
    // no second vector search. Witness-filtered, capped at 4 scenes / N per scene.
    slottedRagSnippets?: SlottedRagSnippet[];
    // WO-3: UI-only per-NPC stance readings. Never consumed by payload assembly.
    relationshipStances?: import('../../types').RelationshipStance[];
};

type GatherDeps = {
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    deepSearchThisTurn: boolean;
    setLoadingStatus?: (status: string | null) => void;
};

async function gatherRelationshipStances(
    state: TurnState,
    finalInput: string,
    signal: AbortSignal | undefined,
    facade: HostFacade | undefined,
): Promise<import('../../types').RelationshipStance[]> {
    const data = facade?.data;
    const context = data?.context ?? state.context;
    // Same gate as the payload side (payloadBuilder): the switch, else the tier preset.
    // Reading only the switch ran the stance calls on a tier that then dropped them.
    const stanceOn = isBlockEnabled('npcStance', facade?.config.aiTier ?? state.settings.aiTier, facade?.config.moduleEnabled ?? state.settings.moduleEnabled);
    if (context.relationshipMemory !== true || !stanceOn) return [];

    const onStageNpcIds = data?.onStageNpcIds ?? state.onStageNpcIds ?? [];
    const utilityEndpoint = facade ? undefined : state.getUtilityEndpoint?.();
    const utilityAvailable = facade
        ? hasHostModelRole(facade, 'utility')
        : Boolean(utilityEndpoint?.endpoint);
    const modelCall = facade && utilityAvailable
        ? (request: import('./hostFacade').ModelRequest) => facade.model.call('utility', request)
        : undefined;

    const recentMessages = (data?.messages ?? state.messages).slice(-6);
    const sceneNote = context.sceneNoteActive ? context.sceneNote : '';
    const sceneId = currentRelationshipSceneId(
        (data?.archiveIndex ?? state.archiveIndex).map(entry => entry.sceneId),
    );
    const sceneKey = sceneKeyForRelationshipStance({
        onStageNpcIds,
        sceneNote,
        currentPlaceId: context.currentPlaceId,
        currentFeature: context.currentFeature,
    });
    const sceneContext = buildRelationshipStanceSceneContext({
        finalInput,
        sceneNote,
        currentPlace: context.currentPlaceId ?? undefined,
        currentFeature: context.currentFeature,
        recentMessages,
    });

    return computeRelationshipStances({
        campaignId: data?.activeCampaignId ?? state.activeCampaignId,
        enabled: true,
        aiTier: facade?.config.aiTier ?? state.settings.aiTier,
        npcs: data?.npcLedger ?? state.npcLedger,
        onStageNpcIds,
        relationshipMemoriesNpcToMc: state.relationshipMemoriesNpcToMc ?? [],
        playerCharacter: context.playerCharacter,
        sceneId,
        sceneKey,
        sceneMood: 'logistical',
        sceneContext,
        maxTokens: blockTokenCap(
            BUILTIN_IDS.stance,
            getBuiltinTokenCap(BUILTIN_IDS.stance)?.default ?? 1200,
            state.settings.moduleTokens,
        ),
        modelCall,
        provider: utilityAvailable ? utilityEndpoint : undefined,
        signal,
        // WO-3.5 Fix D: surface dropped stances in the tuning panel so they are
        // distinguishable from a cheap-tier NPC. Non-blocking, never retried.
        onFault: (fault) => {
            const current = readRelationshipMemoryState();
            writeRelationshipMemoryState({
                relationshipMemoryFaults: [...current.relationshipMemoryFaults, fault],
            });
        },
    });
}

/**
 * The `memory.recall` ask site. Exported for the Phase 7.1.1 claim test, which
 * drives the real post-conditions (unknown ids faulted and dropped, exclusions
 * dropped, host fetch under the token budget) rather than reimplementing them.
 * `gatherContext` remains the only production caller.
 */
export async function gatherMemoryRecallViaRole(
    state: TurnState,
    chapters: ArchiveChapter[],
    semanticArchiveIds: string[] | undefined,
    plannerSceneIds: string[] | undefined,
    excludeSceneIds: Set<string> | undefined,
    signal: AbortSignal | undefined,
    facade: HostFacade | undefined,
): Promise<import('../../types').ArchiveScene[] | undefined> {
    void signal;
    const data = facade?.data;
    const archiveIndex = data?.archiveIndex ?? state.archiveIndex;
    const activeCampaignId = data?.activeCampaignId ?? state.activeCampaignId;
    if (archiveIndex.length === 0 || !activeCampaignId) return undefined;

    const input: MemoryRecallInput = {
        campaignId: activeCampaignId,
        query: data?.input ?? state.input,
        messages: data?.messages ?? state.messages,
        archiveIndex,
        chapters: toMemoryRecallChapters(chapters),
        npcLedger: data?.npcLedger ?? state.npcLedger,
        semanticFacts: (data?.semanticFacts ?? state.semanticFacts ?? []).map(({ subject, predicate, object, importance }) => ({
            subject,
            predicate,
            object,
            importance,
        })),
        candidateSceneIds: semanticArchiveIds,
        plannerSceneIds,
        excludeSceneIds: [...(excludeSceneIds ?? [])],
        divergenceSceneIds: [...getDivergenceSceneIds((data?.divergenceRegister ?? state.divergenceRegister) || EMPTY_REGISTER)],
        depth: facade?.config.archiveRecallDepth ?? state.settings.archiveRecallDepth ?? 'standard',
        tokenBudget: 3000,
    };

    setMemoryRecallDefaultContext({
        chapters,
        aiTier: facade?.config.aiTier ?? state.settings.aiTier,
        moduleEnabled: state.settings.moduleEnabled,
        utilityProvider: facade ? undefined : state.getUtilityEndpoint?.(),
        modelCall: facade
            ? (request: import('./hostFacade').ModelRequest) => facade.model.call('utility', request)
            : undefined,
    });

    const provider = serviceRoles.activeProviderFor('memory.recall');
    const answer = await serviceRoles.ask<MemoryRecallInput, MemoryRecallAnswer>('memory.recall', input);
    if (!answer || answer.sceneIds.length === 0) return answer ? [] : undefined;

    const knownSceneIds = new Set(archiveIndex.map((entry) => entry.sceneId));
    const unknownSceneIds = answer.sceneIds.filter((sceneId) => !knownSceneIds.has(sceneId));
    if (unknownSceneIds.length > 0) {
        const modId = provider?.modId ?? provider?.providerId ?? 'role-registry';
        roleFaultStore.add({
            modId,
            file: provider?.source === 'mod' ? 'mod:' + modId : 'role:memory.recall',
            kind: 'partial',
            roleId: 'memory.recall',
            reason: formatRoleFaultReason({
                modName: modId,
                kind: 'partial',
                roleId: 'memory.recall',
                message: unknownSceneIds.join(', '),
            }),
        });
    }

    const excluded = new Set(input.excludeSceneIds);
    const sceneIds = answer.sceneIds.filter((sceneId) => knownSceneIds.has(sceneId) && !excluded.has(sceneId));
    if (sceneIds.length === 0) return [];
    return fetchArchiveScenes(input.campaignId, sceneIds, input.tokenBudget);
}

export async function gatherContext(
    state: TurnState,
    finalInput: string,
    deps: GatherDeps,
    signal?: AbortSignal,
    facade?: HostFacade
): Promise<GatheredContext> {
    const { activeCampaignId } = state;

    const excludeSceneIds = buildExcludeSceneIds(state);

    // ─── Per-stage timing (debug only) ───
    // Surfaces what's actually slow during "GATHERING CONTEXT" — including non-LLM work
    // (fetches, archive recall) that the UtilityCallStrip can't see. Logged as one line
    // when debugMode or verbose utility logging is on; zero overhead otherwise.
    const debugTrace = !!(state.settings.debugMode || state.settings.verboseUtilityLogging);
    const gatherStart = performance.now();
    const traceTimings: Record<string, number> = {};
    clearGatherStages();
    // Always publishes the active stage to the live UI; records timing only under debug.
    const timed = <T,>(label: string, p: Promise<T>): Promise<T> => {
        const friendly = STAGE_LABELS[label] ?? label;
        beginGatherStage(friendly);
        const t0 = performance.now();
        return p.finally(() => {
            endGatherStage(friendly);
            if (debugTrace) traceTimings[label] = Math.round(performance.now() - t0);
        });
    };

    // ─── Kick off planner and semantic candidates in parallel ───
    const plannerPromise = timed('planner', gatherPlannerSceneIds(state, signal, facade));

    const semanticPromise = timed('semantic-candidates', activeCampaignId
        ? gatherSemanticCandidates(state, signal, facade)
        : Promise.resolve({ semanticArchiveIds: undefined, semanticLoreIds: undefined, semanticRuleIds: undefined }));

    // WO-3: start all present-NPC stance work beside the existing gather tracks.
    // It is cached at the scene boundary, so later turns in the same scene reuse it.
    const relationshipStancesPromise = gatherRelationshipStances(state, finalInput, signal, facade);

    // The `next-scene` pre-assignment used to run here: a guess at the number the
    // turn WOULD get, fetched before the turn was written and glued onto the reply
    // text. The real id is assigned independently by `appendScene` at commit, and
    // nothing reconciled the two — so anything that changed the archive in between
    // (an unawaited rollback, a swallowed fetch failure, a restore) left the
    // displayed number permanently disagreeing with the archived one. The number
    // now comes from `msg.sceneId` after commit, which is the id the server
    // actually assigned. Removing this also drops one HTTP round-trip per turn.

    // Pinned chapters for recommender (computed before awaiting)
    const pinnedChaptersForRecommender = deps.pinnedChapterIds.length > 0
        ? deps.chapters.filter(c => deps.pinnedChapterIds.includes(c.chapterId))
        : undefined;

    // ─── Archive recall — depends on semantic candidates + planner ───
    const archiveRecallPromise = timed('archive-recall', (async () => {
        const [semanticCandidates, plannerSceneIds] = await Promise.all([semanticPromise, plannerPromise]);
        return gatherMemoryRecallViaRole(
            state,
            deps.chapters,
            semanticCandidates.semanticArchiveIds,
            plannerSceneIds,
            excludeSceneIds,
            signal,
            facade,
        );
    })());

    // ─── Recommender — independent ───
    const recommenderPromise = timed('recommender', gatherRecommender(state, finalInput, pinnedChaptersForRecommender, signal, facade));

    // ─── Lore & rules — depend on semantic candidates ───
    // Waits for the recommender too: its lore picks join keyword + meaning search. With
    // thinking off it returns in 1–2 s, about when the meaning search does.
    const loreRulesPromise = timed('lore-rules', (async () => {
        const [semanticCandidates, recommender] = await Promise.all([semanticPromise, recommenderPromise]);
        return gatherLoreAndRules(state, semanticCandidates, recommender.recommendedLoreIds);
    })());

    // ─── Dynamic Elevation (WO-11) — depends on state only (synopsis scope
    // computation re-derives the LOD tier map from state.chapters). Runs in
    // parallel with the other stages; timeout/failure → empty, never blocks.
    // Per spec item 2: expanded queries are not reachable from this layer
    // (gatherSemanticCandidates does query expansion internally but does not
    // expose the expanded queries). Uses the raw user message as the single
    // query. Reported in the WO-11 report.
    const elevationPromise = timed('dynamic-elevation', gatherDynamicElevation(state, { chapters: deps.chapters }, signal, facade));

    // Timeline events — from state, used directly
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // ─── Await all async operations with a safety backstop ───
    // Raised to match the AI-call budget: gather waits for slow stages rather than
    // bailing early, and the live step indicator (GenerationProgress) shows what's
    // running so the user sees movement instead of a frozen "GATHERING CONTEXT".
    // Individual calls have their own (tighter) timeouts, so this is just a backstop.
    // A stage still running at the backstop is left behind with its empty result. (The
    // old race was followed by awaiting every stage anyway, so it never stopped the
    // wait, and its uncleared timer logged a false "timeout" 180 s after every turn.)
    const CONTEXT_GATHER_TIMEOUT_MS = AI_CALL_TIMEOUT_MS;
    const TIMED_OUT = Symbol('gather-backstop');
    const backstopDeadline = Date.now() + CONTEXT_GATHER_TIMEOUT_MS;
    let backstopTimer: ReturnType<typeof setTimeout> | undefined;
    let gatherSettled = false;
    // Resolves only once the deadline has truly passed: a timer that fires early
    // re-checks the clock and re-arms (the utilityCallTracker pattern). The re-check
    // is a microtask, not a direct call, so a timer flush cannot spin it in place.
    const backstop = new Promise<typeof TIMED_OUT>((resolve) => {
        const arm = (): void => {
            if (gatherSettled) return;
            const remaining = backstopDeadline - Date.now();
            if (remaining <= 0) { resolve(TIMED_OUT); return; }
            backstopTimer = setTimeout(() => { void Promise.resolve().then(arm); }, remaining);
        };
        arm();
    });
    const orBackstop = <T,>(label: string, p: Promise<T>, fallback: T): Promise<T> =>
        Promise.race([p, backstop]).then((value) => {
            if (value !== TIMED_OUT) return value as T;
            console.warn(`[ContextGatherer] ${label} still running after ${CONTEXT_GATHER_TIMEOUT_MS / 1000} s — continuing without it`);
            return fallback;
        });

    let archiveRecall: import('../../types').ArchiveScene[] | undefined;
    let recommender: Awaited<typeof recommenderPromise>;
    let loreRules: Awaited<typeof loreRulesPromise>;
    let semanticCandidates: Awaited<typeof semanticPromise>;
    let plannerSceneIds: string[] | undefined;
    let elevation: { scenes: ElevatedScene[]; rankedSceneIds: string[] };
    let relationshipStances: import('../../types').RelationshipStance[];
    try {
        archiveRecall = await orBackstop('Archive recall', archiveRecallPromise, undefined);
        recommender = await orBackstop('Recommender', recommenderPromise, { recommendedNPCNames: undefined, inventoryCategories: undefined, profileFields: undefined });
        loreRules = await orBackstop('Lore selection', loreRulesPromise.catch(() => ({ relevantLore: undefined, relevantRules: [], rulesManifest: '' })), { relevantLore: undefined, relevantRules: [], rulesManifest: '' });
        semanticCandidates = await orBackstop('Meaning search', semanticPromise, { semanticArchiveIds: undefined, semanticLoreIds: undefined, semanticRuleIds: undefined });
        plannerSceneIds = await orBackstop('Planner', plannerPromise, undefined);
        // WO-11: never let elevation failure block the turn — default to empty.
        elevation = await orBackstop('Dynamic elevation', elevationPromise.catch(() => ({ scenes: [] as ElevatedScene[], rankedSceneIds: [] as string[] })), { scenes: [], rankedSceneIds: [] });
        relationshipStances = await orBackstop('NPC stance', relationshipStancesPromise.catch(error => {
            console.warn('[ContextGatherer] Relationship stance pass failed:', error);
            return [] as import('../../types').RelationshipStance[];
        }), []);
    } finally {
        gatherSettled = true;
        clearTimeout(backstopTimer);
    }
    const { relevantLore, relevantRules, rulesManifest } = loreRules;

    // WO-12: Slotted RAG — consume WO-11's scoped search results (one search, two
    // consumers). Pure computation from the ranked IDs + archive index; no second
    // vector search. The elevated scene IDs are excluded so only non-elevated hits
    // contribute snippets. Tier-gated (lodSlottedRag: lite false, pro false, max true).
    // Failure-safe: returns empty on any missing input; never throws.
    const elevatedSceneIds = new Set(elevation.scenes.map(s => s.sceneId));
    const slottedRag = gatherSlottedRag(state, {
        rankedSceneIds: elevation.rankedSceneIds,
        elevatedSceneIds,
        chapters: deps.chapters,
    }, facade);

    // ─── Pinned Chapter Injection ───
    archiveRecall = await injectPinnedChapters(
        state,
        { pinnedChapterIds: deps.pinnedChapterIds, chapters: deps.chapters, clearPinnedChapters: deps.clearPinnedChapters },
        archiveRecall,
        semanticCandidates,
        plannerSceneIds,
        excludeSceneIds
    );

    // ─── Deep Archive Search (one-shot) ───
    const deepContextSummary = await timed('deep-search', gatherDeepSearch(
        state,
        { deepSearchThisTurn: deps.deepSearchThisTurn, chapters: deps.chapters, setLoadingStatus: deps.setLoadingStatus },
        finalInput,
        signal,
        facade
    ));

    // ─── Semantic Facts ───
    const semanticFactText = gatherSemanticFacts(state, finalInput);

    if (debugTrace) {
        const total = Math.round(performance.now() - gatherStart);
        const breakdown = Object.entries(traceTimings)
            .sort((a, b) => b[1] - a[1])
            .map(([k, v]) => `${k}=${v}ms`)
            .join('  ');
        console.log(`[GatherTrace] total=${total}ms | ${breakdown}`);
    }

    return {
        archiveRecall,
        recommendedNPCNames: recommender.recommendedNPCNames,
        timelineEvents,
        relevantLore,
        semanticArchiveIds: semanticCandidates.semanticArchiveIds,
        semanticLoreIds: semanticCandidates.semanticLoreIds,
        inventoryCategories: recommender.inventoryCategories,
        profileFields: recommender.profileFields,
        deepContextSummary,
        semanticFactText,
        relevantRules,
        rulesManifest,
        elevatedScenes: elevation.scenes,
        elevatedSceneRankedIds: elevation.rankedSceneIds,
        slottedRagSnippets: slottedRag.snippets,
        relationshipStances,
    };
}
