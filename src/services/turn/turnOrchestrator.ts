import { useAppStore } from '../../store/useAppStore';
import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, TimelineEvent, EndpointConfig, ProviderConfig, ArchiveChapter, SamplingConfig, PipelinePhase, DivergenceRegister, InventoryProposal, PayloadTrace, SemanticFact } from '../../types';
import type { OneShotEventId } from '../oneshot/oneShotEvents';
import { createTurnContext } from './turnContext';
import {
    resolveEngineRolls,
    addUserTurnMessage,
    gatherTurnContext,
    runIntroEngineStage,
    runDirectorStage,
    buildTurnPayload,
    runGenerationStage,
} from './turnStages';

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    /**
     * Patches the LAST assistant message (scans back from the tail). Use this
     * instead of `updateLastMessage` whenever the patch is meant for the
     * assistant bubble that produced the turn — e.g. swipeSet, pendingCommit,
     * sceneId, reasoning_content, tool_calls. After a tool call, the literal
     * last message in the array is the tool message (desktop reuses the same
     * assistant id across iterations instead of pushing a fresh bubble per
     * call like mobile does), so `updateLastMessage` would stamp the wrong
     * bubble and silently break the swipe UI + commit pipeline.
     */
    updateLastAssistantMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    setTimeline?: (events: TimelineEvent[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    setCondensed: (upToIndex: number) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: PayloadTrace[] | undefined) => void;
    setLoadingStatus?: (status: string | null) => void;
    setPipelinePhase?: (phase: PipelinePhase) => void;
    setDivergenceRegister?: (register: DivergenceRegister) => void;
    setOnStageNpcIds?: (ids: string[]) => void;
    addNpcSuggestions?: (names: string[], context?: string) => void;
    archiveNPC: (id: string, turn: number, reason: string) => void;
    restoreNPC: (id: string) => void;
    /** Stage a GM-proposed inventory change for user confirmation (Phase 6). The
     *  proposal does not mutate inventory until the user confirms it in the UI. */
    stageInventoryProposal?: (proposal: InventoryProposal) => void;
    /** WO-05: Director phase UI hook. Fires 'running' just before the Director
     *  call begins and 'done' after it settles (success, abort, timeout, or
     *  parse-failure — `runDirectorBrief` always returns). The UI uses this to
     *  show "Director drafting brief…" + a Skip affordance that aborts only the
     *  Director call (via `TurnState.directorSkipController`), never the turn. */
    onDirectorBriefPhase?: (phase: 'running' | 'done') => void;
    /** Durable-commit v1: flush the campaign state to disk NOW (no debounce).
     *  Called once, immediately after the swipe set + `pendingCommit` marker are
     *  stamped on the finished GM bubble. Until this fires, the pending turn
     *  exists only in memory: the stamp goes through `updateLastAssistantMessage`,
     *  which schedules no save, so a crash / close / timeout before the next
     *  store write left the turn with no marker on disk and nothing for
     *  `reconcilePendingCommitOnLaunch` to pick up — the scene was lost silently.
     *  Optional so callers that build their own callbacks (commit path, tests)
     *  can omit it. */
    persistTurnState?: () => void;
};

export type TurnState = {
    input: string;
    displayInput: string;
    settings: AppSettings;
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    loreChunks: LoreChunk[];
    npcLedger: NPCEntry[];
    archiveIndex: ArchiveIndexEntry[];
    activeCampaignId: string | null;
    provider: EndpointConfig | ProviderConfig | undefined;
    getMessages: () => ChatMessage[]; // to get fresh messages midway
    getFreshProvider: () => EndpointConfig | ProviderConfig | undefined;
    getUtilityEndpoint?: () => EndpointConfig | undefined;
    getFreshAuxiliaryProvider?: () => EndpointConfig | undefined;
    onStageNpcIds?: string[];
    timeline?: TimelineEvent[];
    // Phase 2B: store-lifted fields (eliminate useAppStore.getState() inside runTurn)
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    setChapters: (chapters: ArchiveChapter[]) => void;
    incrementBookkeepingTurnCounter: () => number;
    resetBookkeepingTurnCounter: () => void;
    autoBookkeepingInterval: number;
    getFreshContext: () => GameContext;
    sampling?: SamplingConfig;
    deepSearchThisTurn?: boolean;
    divergenceRegister?: DivergenceRegister;
    pinnedExcerpts?: import('../../types').PinnedExcerpt[];
    // Player-called dice ("dice me"): armed roll resolved at send time (WO-H).
    // Accepts the new ManualRollRequest shape OR the legacy '1d20'|'adv'|'disadv' string.
    armedRoll?: import('../../types').ManualRollRequest | string | null;
    armedLoot?: import('../../types').ArmedLoot | null;
    armedOneShot?: OneShotEventId | null;
    /** Absolute Command v1: binding OOC player instruction for THIS turn only.
     *  Cleared before runTurn (fires exactly once). Suppresses Director Brief,
     *  watchdog nudge, and GM_REMINDER; placed last in the prompt. Never enters
     *  chat history (travels as a buildPayload parameter). */
    absoluteCommand?: string | null;
    /** Confirmed Ask GM meta-guidance. Volatile only; it is never added to story history. */
    nextTurnOocBrief?: string;
    semanticFacts?: SemanticFact[];
    /** WO-05: Skip handle for the Director Brief call only. Aborting this
     *  controller cancels `runDirectorBrief` (the turn proceeds without a
     *  Brief) WITHOUT aborting the outer turn `AbortController`. The orchestrator
     *  combines this signal with the turn's abort signal via `AbortSignal.any`
     *  so an outer stop still aborts the Director (preserves WO-04 behavior). */
    directorSkipController?: AbortController | null;
};


export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, npcLedger, provider } = state;

    if (!provider) return;

    // ── WO-P1-01: TurnContext data bus ───────────────────────────────────
    // The bus replaces (a) the `let finalInput += …` string-gluing, (b) the
    // ~14 loose vars destructured out of gatherContext, and (c) the
    // `useAppStore.getState().locationLedger` coupling read at buildPayload
    // time. The locationLedger is lifted ONCE here from the store; the
    // `getFreshAuxiliaryProvider` getter on TurnState is used by the intro
    // stage in place of `useAppStore.getState().getActiveAuxiliaryEndpoint()`.
    // Both coupling-read kills are WO-P1-01 §4.3.
    const ctx = createTurnContext({
        input,
        displayInput,
        locationLedger: useAppStore.getState().locationLedger ?? [],
        npcLedger: npcLedger ?? [],
    });

    // ── WO-P1-02: turn stages ────────────────────────────────────────────
    // `runTurn` is now a thin composition root: each phase is a named stage
    // function in `turnStages.ts`. Pure code-move — no logic, ordering, or
    // control-flow change. The golden payload + turn-flow tests
    // (turnContextGolden.test.ts) are the byte-identical guard.
    resolveEngineRolls(ctx, state, callbacks);
    addUserTurnMessage(ctx, callbacks);

    await gatherTurnContext(ctx, state, callbacks, abortController.signal);
    if (abortController.signal.aborted) return;

    await runIntroEngineStage(ctx, state, callbacks);
    await runDirectorStage(ctx, state, callbacks, abortController);

    const genDeps = buildTurnPayload(ctx, state, callbacks);
    await runGenerationStage(ctx, state, callbacks, abortController, genDeps);
}
