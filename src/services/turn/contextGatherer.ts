import type { ArchiveChapter, TimelineEvent } from '../../types';
import type { TurnState } from './turnOrchestrator';
import { gatherSemanticCandidates } from '../context-gatherer/semanticCandidates';
import { gatherPlannerSceneIds, gatherArchiveRecall, buildExcludeSceneIds } from '../context-gatherer/archiveRecall';
import { gatherRecommender } from '../context-gatherer/recommenderGather';
import { gatherLoreAndRules } from '../context-gatherer/loreRulesGather';
import { injectPinnedChapters } from '../context-gatherer/pinnedChaptersGather';
import { gatherDeepSearch, gatherSemanticFacts } from '../context-gatherer/deepSearchGather';
import { gatherDynamicElevation, type ElevatedScene } from '../archive-memory/dynamicElevation';
import { gatherSlottedRag, type SlottedRagSnippet } from '../archive-memory/slottedRag';
import { beginGatherStage, endGatherStage, clearGatherStages } from './gatherProgress';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { LoreChunk } from '../../types';

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
    const plannerPromise = timed('planner', gatherPlannerSceneIds(state, signal));

    const semanticPromise = timed('semantic-candidates', activeCampaignId
        ? gatherSemanticCandidates(state, signal)
        : Promise.resolve({ semanticArchiveIds: undefined, semanticLoreIds: undefined, semanticRuleIds: undefined }));

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
        return gatherArchiveRecall(state, { chapters: deps.chapters }, semanticCandidates, plannerSceneIds, excludeSceneIds, signal);
    })());

    // ─── Recommender — independent ───
    const recommenderPromise = timed('recommender', gatherRecommender(state, finalInput, pinnedChaptersForRecommender, signal));

    // ─── Lore & rules — depend on semantic candidates ───
    const loreRulesPromise = timed('lore-rules', (async () => {
        const semanticCandidates = await semanticPromise;
        return gatherLoreAndRules(state, semanticCandidates);
    })());

    // ─── Dynamic Elevation (WO-11) — depends on state only (synopsis scope
    // computation re-derives the LOD tier map from state.chapters). Runs in
    // parallel with the other stages; timeout/failure → empty, never blocks.
    // Per spec item 2: expanded queries are not reachable from this layer
    // (gatherSemanticCandidates does query expansion internally but does not
    // expose the expanded queries). Uses the raw user message as the single
    // query. Reported in the WO-11 report.
    const elevationPromise = timed('dynamic-elevation', gatherDynamicElevation(state, { chapters: deps.chapters }, signal));

    // Timeline events — from state, used directly
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // ─── Await all async operations with a safety backstop ───
    // Raised to match the AI-call budget: gather waits for slow stages rather than
    // bailing early, and the live step indicator (GenerationProgress) shows what's
    // running so the user sees movement instead of a frozen "GATHERING CONTEXT".
    // Individual calls have their own (tighter) timeouts, so this is just a backstop.
    const CONTEXT_GATHER_TIMEOUT_MS = AI_CALL_TIMEOUT_MS;
    await Promise.race([
        Promise.all([archiveRecallPromise, recommenderPromise, loreRulesPromise, plannerPromise, elevationPromise]),
        new Promise<void>((resolve) => setTimeout(() => {
            console.warn('[ContextGatherer] Context gather timeout — proceeding with partial results');
            resolve();
        }, CONTEXT_GATHER_TIMEOUT_MS)),
    ]);

    let archiveRecall = await archiveRecallPromise;
    const recommender = await recommenderPromise;
    const { relevantLore, relevantRules, rulesManifest } = await loreRulesPromise.catch(() => ({ relevantLore: undefined, relevantRules: [], rulesManifest: '' }));
    const semanticCandidates = await semanticPromise;
    const plannerSceneIds = await plannerPromise;
    // WO-11: never let elevation failure block the turn — default to empty.
    const elevation = await elevationPromise.catch(() => ({ scenes: [] as ElevatedScene[], rankedSceneIds: [] as string[] }));

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
    });

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
        signal
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
    };
}
