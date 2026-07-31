import type { ChatMessage, NPCEntry, SceneStakes, PipelinePhase } from '../../types';
import type { TurnCallbacks, TurnState } from './turnOrchestrator';
import type { TurnContext } from './turnContext';
import type { OpenAIMessage } from '../llm/llmService';
import { runPostTurnPipeline } from './postTurnPipeline';
import { classifySceneStakes } from './sceneStakesTag';
import { tierAllows } from './aiTier';
import { shouldCondense, computeTrimIndex, getCondenseBudgetRatio } from '../archive-memory/condenser';
import { toast } from '../../components/Toast';
import { useAppStore } from '../../store/useAppStore';
import { saveCampaignState } from '../../store/campaignStore';

// ── In-memory snapshot ─────────────────────────────────────────────────
// Lost on crash — that's OK. Relaunch reconciliation rebuilds from the live
// store (no "next turn's messages" exist after a crash, so live == snapshot).
interface PendingTurnSnapshot {
    turnState: TurnState;               // ORIGINAL reference — do NOT rebuild from live
    messages: ChatMessage[];              // messages at swipe-1 completion time (frozen)
    cachedPayload: OpenAIMessage[];      // for swipes 2–5 (sanitizePayloadForApi(false))
    displayInput: string;                // user's display input for this turn
    activeCampaignId: string;            // campaign at turn time
    npcLedger: NPCEntry[];               // ledger at turn time
    // WO-P1-03: the TurnContext bus, carried across the commit boundary by the
    // snapshot. Post-turn runs a turn later, off the frozen snapshot — so the
    // bus is carried HERE, not by one live object. The post-turn pipeline may
    // read bus fields (e.g. ctx.locationLedger) instead of reaching into
    // getState(). Thread-only: this does NOT rewrite what post-turn computes
    // (that's Project 4's memory port). Optional for now — callers that don't
    // pass it leave it undefined (the post-turn pipeline falls back to its
    // existing reads, preserving byte-identical behaviour).
    turnContext?: TurnContext;
}

let pendingSnapshot: PendingTurnSnapshot | null = null;

export function capturePendingTurnSnapshot(
    state: TurnState,
    cachedPayload: OpenAIMessage[],
    displayInput: string,
    // WO-P1-03: optional bus — carried across the commit boundary so the
    // post-turn pipeline can read bus fields without a live reference. The
    // generation stage passes the bus it built; other callers (none today)
    // omit it. Optional to keep the signature backward-compatible.
    turnContext?: TurnContext,
): void {
    pendingSnapshot = {
        turnState: state,
        messages: [...state.getMessages()],
        cachedPayload: [...cachedPayload],
        displayInput,
        activeCampaignId: state.activeCampaignId ?? '',
        npcLedger: state.npcLedger,
        turnContext,
    };
}

export function clearPendingTurnSnapshot(): void {
    pendingSnapshot = null;
}

export function getPendingTurnSnapshot(): PendingTurnSnapshot | null {
    return pendingSnapshot;
}

export function getCachedSwipePayload(): OpenAIMessage[] | null {
    return pendingSnapshot?.cachedPayload ?? null;
}

// ── Durable-commit v1 ──────────────────────────────────────────────────
/** Flush the campaign state to disk immediately (no debounce). Called right after
 *  the swipe set + `pendingCommit` marker land on the finished GM bubble.
 *
 *  The stamp rides `updateLastAssistantMessage`, which schedules no save, and the
 *  commit itself is deferred to the next send / Exit / campaign switch. So until
 *  this fires the pending turn exists ONLY in memory: an improper close or an idle
 *  timeout left the GM text on disk with no marker, `findPendingCommitMessage`
 *  returned null forever after, and the scene was never archived. */
export async function persistPendingTurn(): Promise<void> {
    const s = useAppStore.getState();
    if (!s.activeCampaignId) return;
    try {
        await saveCampaignState(s.activeCampaignId, {
            context: s.context,
            messages: s.messages,
            condenser: s.condenser,
            pinnedExcerpts: s.pinnedExcerpts,
        });
    } catch (e) {
        console.warn('[PendingTurn] Immediate persist failed:', e);
    }
}

/** The user half of the turn a pending GM message answers — the nearest preceding
 *  user bubble. `displayContent` is the player-facing text (what the live commit
 *  path archives via `state.displayInput`); `content` carries injected directives,
 *  so it is only the fallback.
 *
 *  This is what makes a pending turn self-describing on disk. The live commit reads
 *  the input from the in-memory snapshot, but that snapshot dies with the process —
 *  and the crash-recovery rebuild used to substitute an empty string, which the
 *  archive endpoint rejects outright (400: non-empty userContent required). Every
 *  turn recovered after a crash was therefore dropped on the floor. */
export function findTurnUserInput(messages: ChatMessage[], pendingMsgId?: string): string {
    let from = messages.length - 1;
    if (pendingMsgId) {
        const idx = messages.findIndex(m => m.id === pendingMsgId);
        if (idx !== -1) from = idx - 1;
    }
    for (let i = from; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'user') return m.displayContent || m.content || '';
        // Don't cross into an earlier, already-committed turn.
        if (m.role === 'assistant' && m.sceneId) break;
    }
    return '';
}

/** After a continue merges text into the pending message, refresh the snapshot's
 *  frozen copy of that message so the commit-time importance rater sees the
 *  merged text (snapshot.messages holds stale object refs otherwise). */
export function refreshPendingSnapshotMessage(messageId: string, patch: Partial<ChatMessage>): void {
    if (!pendingSnapshot) return;
    const idx = pendingSnapshot.messages.findIndex(m => m.id === messageId);
    if (idx === -1) return;
    pendingSnapshot = {
        ...pendingSnapshot,
        messages: pendingSnapshot.messages.map(m =>
            m.id === messageId ? { ...m, ...patch } : m
        ),
    };
}

// ── Find the latest GM message with a pending commit ───────────────────
// mainApp stamps sceneId on committed messages (WO-F) instead of inserting a
// scene-marker system message. So the scan stops at a message with sceneId set
// (committed) OR at a user message — only the un-committed tail is eligible.
export function findPendingCommitMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.pendingCommit) return m;
        // Stop at a committed assistant message (sceneId is set) or a user message —
        // the pending message is always the latest GM bubble in the un-committed tail.
        if (m.role === 'assistant' && m.sceneId) break;
        if (m.role === 'user') break;
    }
    return null;
}

// Smart Retry v1: find the latest assistant message marked retryable (the story
// AI was aborted or failed its final retry). Like findPendingCommitMessage but
// for the pre-commit failure state. Used by the commit guard (skip the snapshot
// clear so the Retry button stays armed), delete/regenerate handlers (clear the
// orphaned precontext + in-memory snapshot when the turn is discarded), and the
// new-turn-clears-stale-flags step.
export function findRetryableMessage(messages: ChatMessage[]): ChatMessage | null {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant' && m.retryable) return m;
        if (m.role === 'assistant' && m.sceneId) break;
        if (m.role === 'user') break;
    }
    return null;
}

// ── Build fresh callbacks from the live store for commit ────────────────
function buildCommitCallbacks(
    activeCampaignId: string,
    store: ReturnType<typeof useAppStore.getState>,
): TurnCallbacks {
    return {
        onCheckingNotes: () => {},
        addMessage: (msg) => useAppStore.getState().addMessage(msg),
        updateLastAssistant: (content) => useAppStore.getState().updateLastAssistant(content),
        updateLastMessage: (patch) => {
            const msgs = useAppStore.getState().messages;
            if (msgs.length > 0) useAppStore.getState().updateLastMessage(patch);
        },
        // Swipe Generation v1 / WO-F sceneId stamp — must target the LAST
        // ASSISTANT message, not the literal last message. After a tool call,
        // the literal last message is the tool message (desktop reuses the
        // same assistant id across iterations instead of pushing a fresh
        // bubble per call like mobile does), so `updateLastMessage` would
        // stamp sceneId on the tool message and the assistant would never
        // receive its archive-anchor sceneId — breaking surgical-delete,
        // edit-sync, and LOD history mapping for that turn.
        updateLastAssistantMessage: (patch) => useAppStore.getState().updateLastAssistantMessage(patch),
        updateContext: (patch) => useAppStore.getState().updateContext(patch),
        getFreshLocationState: () => {
            const fresh = useAppStore.getState();
            return {
                activeCampaignId: fresh.activeCampaignId,
                locationLedger: fresh.locationLedger,
                context: fresh.context,
            };
        },
        setCharacterProfileData: store.setCharacterProfileData,
        setInventoryItems: store.setInventoryItems,
        setLocationLedger: store.setLocationLedger,
        addLocationSuggestions: store.addLocationSuggestions,
        setArchiveIndex: (entries) => useAppStore.getState().setArchiveIndex(entries),
        setTimeline: (events) => useAppStore.getState().setTimeline(events),
        updateNPC: (id, patch) => useAppStore.getState().updateNPC(id, patch),
        addNPC: (npc) => useAppStore.getState().addNPC(npc),
        addNpcSuggestions: (names, ctx) => useAppStore.getState().addNpcSuggestions(names, ctx),
        addEnemySuggestions: (suggestions, ctx) => useAppStore.getState().addEnemySuggestions(suggestions, ctx),
        setCondensed: (upToIndex) => useAppStore.getState().setCondensed(upToIndex),
        setStreaming: () => {},
        setLastPayloadTrace: useAppStore.getState().setLastPayloadTrace,
        setLoadingStatus: () => {},
        setPipelinePhase: (phase: PipelinePhase) => useAppStore.getState().setPipelinePhase(phase),
        setDivergenceRegister: (reg) => {
            useAppStore.getState().setDivergenceRegister(reg);
            if (activeCampaignId) {
                import('../../store/campaignStore')
                    .then(m => m.saveDivergenceRegister(activeCampaignId, reg))
                    .catch(e => console.warn('[Commit] saveDivergenceRegister failed:', e));
            }
        },
        setOnStageNpcIds: (ids) => useAppStore.getState().setOnStageNpcIds(ids),
        archiveNPC: (id, turn, reason) => useAppStore.getState().archiveNPC(id, turn, reason),
        restoreNPC: (id) => useAppStore.getState().restoreNPC(id),
        stageInventoryProposal: (proposal) => {
            // No direct store slot; surface via a custom event the ChatArea listens to.
            // For the commit path this is unlikely (swipes send tools: undefined), but
            // wire it for parity so a late proposal doesn't crash.
            window.dispatchEvent(new CustomEvent('stage-inventory-proposal', { detail: proposal }));
        },
    };
}

// ── commitPendingTurn ──────────────────────────────────────────────────
// Fires runPostTurnPipeline with the visible variant's CURRENT (possibly edited)
// text. Guards against late swipe results. Reworded failure toast for the
// commit path. Auto-condense runs here (moved out of the orchestrator onDone).
//
// SINGLE-FLIGHT. Four independent callers reach this — `handleSend`,
// `setActiveCampaign`, `reconcilePendingCommitOnLaunch` and the Arc Injector —
// and none of them coordinate. The `pendingCommit` / `swipeSet` markers that
// gate the early return below are only cleared AFTER `await
// runPostTurnPipeline`, so two calls overlapping that await both observe a live
// pending message and both append the SAME turn. That produced a byte-identical
// duplicate scene pair in a live campaign (024 == 025): one turn, archived
// twice, retrievable twice by recall, and the scene counter permanently one
// ahead. Concurrent callers now await the in-flight commit instead of starting
// a second one.
let inFlightCommit: Promise<void> | null = null;

export function commitPendingTurn(): Promise<void> {
    if (inFlightCommit) return inFlightCommit;
    inFlightCommit = runCommitPendingTurn().finally(() => { inFlightCommit = null; });
    return inFlightCommit;
}

async function runCommitPendingTurn(): Promise<void> {
    const snapshot = pendingSnapshot;
    const store = useAppStore.getState();
    const messages = store.messages;

    const pendingMsg = findPendingCommitMessage(messages);
    if (!pendingMsg || !pendingMsg.swipeSet) {
        // Smart Retry v1: a retryable bubble holds a live in-memory snapshot captured
        // before the Story AI run (the Retry button re-enters generation from it). The
        // unconditional `clearPendingTurnSnapshot()` here would wipe that payload and
        // kill the Retry button — e.g. arming an Arc Injector after a failure fires
        // `commitPendingTurn()` unconditionally (ArcInjectorButton.tsx) and would have
        // orphaned the retry. Guard: skip the clear when the tail assistant message is
        // retryable. A failed turn has neither `pendingCommit` nor `swipeSet`, so this
        // early return is otherwise inert — the orphan early snapshot hits here and is
        // safe to keep (commitPendingTurn only acts on a pendingCommit+swipeSet msg).
        const tailRetryable = findRetryableMessage(messages);
        if (!tailRetryable) {
            clearPendingTurnSnapshot();
        }
        return;
    }

    const variantIdx = pendingMsg.swipeActiveIndex ?? 0;
    const variant = pendingMsg.swipeSet[variantIdx];
    if (!variant) {
        clearPendingTurnSnapshot();
        return;
    }

    // Durable-commit v1: an armed message that ALREADY carries a sceneId was
    // archived by an earlier attempt that then died mid-pipeline. Re-running would
    // append the same turn a second time (the 024/025 duplicate class). Retire it.
    if (pendingMsg.sceneId) {
        console.warn(`[Commit] Pending message already archived as scene #${pendingMsg.sceneId} — retiring without re-append`);
        retirePendingMessage(pendingMsg.id, commitStateCampaignId(snapshot, store));
        clearPendingTurnSnapshot();
        return;
    }

    // The visible variant's CURRENT text — read from the message content
    // (which reflects edits the user may have made while browsing).
    const text = pendingMsg.content;

    // Build the commit state — use the ORIGINAL TurnState reference but
    // override getMessages so the importance rater reads the snapshot,
    // never live getMessages() (a late commit must not see the next turn's messages).
    const commitState: TurnState = snapshot
        ? { ...snapshot.turnState, getMessages: () => snapshot.messages }
        : rebuildStateFromLiveStore(store, findTurnUserInput(messages, pendingMsg.id));

    // Determine scene stakes from the chosen variant.
    let sceneStakes: SceneStakes = variant.sceneStakes;
    if (!variant.tagPresent) {
        const utilityProvider = commitState.getUtilityEndpoint?.();
        const aiTier = commitState.settings.aiTier;
        if (utilityProvider && tierAllows(aiTier, 'sceneStakesClassify')) {
            try {
                const recentScene = (snapshot?.messages ?? messages).slice(-3).map(m => {
                    const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
                    return `[${role}]: ${(m.content || '').slice(0, 500)}`;
                }).join('\n\n');
                sceneStakes = await classifySceneStakes(utilityProvider, recentScene + '\n\n' + text.slice(0, 1000));
            } catch (e) {
                console.warn('[Commit] scene-stakes fallback classify failed:', e);
            }
        }
    }

    // Update context with lastSceneStakes from the chosen variant (commit only).
    store.updateContext({ lastSceneStakes: sceneStakes });

    const commitCallbacks = buildCommitCallbacks(commitState.activeCampaignId ?? '', store);
    const snapshotMessages = commitState.getMessages();

    // Durable-commit v1: did the scene actually reach long-term memory? Only then
    // may the turn be retired. Pre-fix this was assumed — the markers were cleared
    // unconditionally, so one failed append (server down, or the empty-user-input
    // 400 the rebuild path used to produce) turned a retryable turn into a
    // permanently uncommittable one: the next send, Exit, relaunch and even a
    // backup restore all found no marker and no-op'd, and the scene was gone.
    let archived = false;
    try {
        // WO-P1-03: pass the bus (carried by the snapshot across the commit
        // boundary) to the post-turn pipeline. Thread-only — the pipeline does
        // NOT yet read it; Project 4 will swap selected reads to bus fields.
        const result = await runPostTurnPipeline(
            commitState, commitCallbacks, text, snapshotMessages, snapshot?.turnContext,
            { verifyExistingScene: pendingMsg.commitFailed === true },
        );
        // A pipeline that reports nothing (older signature / test doubles) is taken
        // at its word: only an explicit `archived: false` blocks retirement.
        archived = result?.archived !== false;

        // Auto-condense check — moved to commit (was in the orchestrator completion callback).
        if (commitState.settings.autoCondenseEnabled) {
            const allMsgs = commitState.getMessages();
            if (shouldCondense(allMsgs, commitState.settings.contextLimit, commitState.condenser.condensedUpToIndex, getCondenseBudgetRatio(commitState.settings.condenseAggressiveness ?? 'smart'))) {
                const newIndex = computeTrimIndex(allMsgs, commitState.condenser.condensedUpToIndex);
                if (newIndex !== commitState.condenser.condensedUpToIndex) {
                    useAppStore.getState().setCondensed(newIndex);
                }
            }
        }
    } catch (err) {
        console.error('[Commit] runPostTurnPipeline failed:', err);
        // A throw says nothing about whether the append landed — leave the turn
        // armed and let the next attempt's index check decide (it re-links an
        // already-written scene instead of duplicating it).
        archived = false;
        toast.error('Turn could not be filed. Your story is saved — this turn will retry.');
    }

    const activeCampaignId = commitState.activeCampaignId ?? '';

    if (!archived) {
        // Keep `pendingCommit` + `swipeSet` so the next commit retries this turn,
        // and flag it so a retry verifies before appending. Persisted, so the retry
        // survives a restart even if a new turn buries this one in the meantime
        // (`retryFailedCommits` sweeps those on launch).
        markCommitFailed(pendingMsg.id, activeCampaignId);
        return;
    }

    // Clear the swipe set + pendingCommit marker — the bubble is now a
    // normal historical message. Flush immediately (commit path should not debounce).
    retirePendingMessage(pendingMsg.id, activeCampaignId);
    clearPendingTurnSnapshot();
}

// ── Message-state transitions (shared by commit + the recovery sweep) ───
/** The turn is filed: drop the pre-commit markers so the bubble becomes ordinary
 *  history, and flush immediately. */
function retirePendingMessage(messageId: string, activeCampaignId: string): void {
    const freshMsgs = useAppStore.getState().messages;
    const idx = freshMsgs.findIndex(m => m.id === messageId);
    if (idx === -1) return;

    const updated = [...freshMsgs];
    const rest = { ...updated[idx] };
    delete rest.swipeSet;
    delete rest.pendingCommit;
    delete rest.swipeActiveIndex;
    delete rest.commitFailed;
    updated[idx] = rest as ChatMessage;
    useAppStore.setState({ messages: updated });

    if (activeCampaignId) {
        saveCampaignState(activeCampaignId, {
            context: useAppStore.getState().context,
            messages: updated,
            condenser: useAppStore.getState().condenser,
            pinnedExcerpts: useAppStore.getState().pinnedExcerpts,
        }).catch(e => console.warn('[Commit] saveCampaignState failed:', e));
    }
}

/** The scene did not land: keep the turn armed and record that it needs a retry. */
function markCommitFailed(messageId: string, activeCampaignId: string): void {
    const freshMsgs = useAppStore.getState().messages;
    const idx = freshMsgs.findIndex(m => m.id === messageId);
    if (idx === -1) return;

    const updated = [...freshMsgs];
    updated[idx] = { ...updated[idx], commitFailed: true };
    useAppStore.setState({ messages: updated });
    console.warn('[Commit] Turn left armed for retry (scene not archived)');

    if (activeCampaignId) {
        saveCampaignState(activeCampaignId, {
            context: useAppStore.getState().context,
            messages: updated,
            condenser: useAppStore.getState().condenser,
            pinnedExcerpts: useAppStore.getState().pinnedExcerpts,
        }).catch(e => console.warn('[Commit] saveCampaignState failed:', e));
    }
}

/** Campaign id for the early-exit paths, which run before `commitState` is built. */
function commitStateCampaignId(
    snapshot: PendingTurnSnapshot | null,
    store: ReturnType<typeof useAppStore.getState>,
): string {
    return snapshot?.activeCampaignId || store.activeCampaignId || '';
}

// ── Rebuild TurnState from the live store (crash recovery path) ────────
// Used when pendingCommit is true on launch but the in-memory snapshot was
// lost (Electron/renderer death). At relaunch, no "next turn's messages"
// exist, so reading live is safe — the snapshot invariant (don't see the
// next turn's messages) holds vacuously.
function rebuildStateFromLiveStore(
    store: ReturnType<typeof useAppStore.getState>,
    // Durable-commit v1: the turn's user half, recovered from the chat log by
    // `findTurnUserInput`. This used to be hardcoded `''`, which the archive
    // endpoint rejects (400 — userContent must be a non-empty string), so EVERY
    // crash-recovered turn failed to archive. The importance rater, pressure scan
    // and agency/arc ticks read the same field and were equally blind.
    recoveredUserInput = '',
): TurnState {
    return {
        input: recoveredUserInput,
        displayInput: recoveredUserInput,
        settings: store.settings,
        context: store.context,
        messages: store.messages,
        condenser: store.condenser,
        loreChunks: store.loreChunks,
        npcLedger: store.npcLedger,
        archiveIndex: store.archiveIndex,
        activeCampaignId: store.activeCampaignId,
        provider: store.getActiveStoryEndpoint(),
        getMessages: () => useAppStore.getState().messages,
        getFreshProvider: () => store.getActiveStoryEndpoint(),
        getUtilityEndpoint: () => store.getActiveUtilityEndpoint(),
        getFreshAuxiliaryProvider: () => {
            const aux = store.getActiveAuxiliaryEndpoint?.();
            return aux?.modelName ? aux : store.getActiveStoryEndpoint();
        },
        getRawAuxiliaryProvider: () => store.getActiveAuxiliaryEndpoint(),
        getRawSummariserProvider: () => store.getActiveSummarizerEndpoint(),
        chapters: store.chapters ?? [],
        pinnedChapterIds: useAppStore.getState().pinnedChapterIds,
        clearPinnedChapters: () => useAppStore.getState().clearPinnedChapters(),
        setChapters: (chapters) => useAppStore.getState().setChapters(chapters),
        incrementBookkeepingTurnCounter: () => useAppStore.getState().incrementBookkeepingTurnCounter(),
        resetBookkeepingTurnCounter: () => useAppStore.getState().resetBookkeepingTurnCounter(),
        autoBookkeepingInterval: useAppStore.getState().autoBookkeepingInterval,
        getFreshContext: () => useAppStore.getState().context,
        timeline: store.timeline,
        divergenceRegister: store.divergenceRegister,
        onStageNpcIds: store.onStageNpcIds,
        pinnedExcerpts: store.pinnedExcerpts,
    };
}

// ── Launch reconciliation ──────────────────────────────────────────────
// On app launch, if any message has pendingCommit=true, fire runPostTurnPipeline
// with the then-visible variant's text, then clear the marker. Covers
// Electron/renderer death mid-browse.
export async function reconcilePendingCommitOnLaunch(): Promise<void> {
    const store = useAppStore.getState();
    const pendingMsg = findPendingCommitMessage(store.messages);
    if (pendingMsg?.swipeSet) {
        console.log('[Reconcile] Found pendingCommit on launch — firing deferred runPostTurnPipeline');
        await commitPendingTurn();
    }

    // Durable-commit v1: sweep up turns whose commit failed and were then buried by
    // a later turn. `findPendingCommitMessage` stops at the first user message, so a
    // buried failure is invisible to it — without this sweep those scenes would sit
    // in the chat log forever, unreachable by recall.
    await retryFailedCommits();
}

// ── Recovery sweep for buried failed commits ───────────────────────────
// Keyed STRICTLY off the explicit `commitFailed` marker — never off "assistant
// without a sceneId", which describes every message in a pre-WO-F campaign and
// would re-archive an entire history. Repairs the archive link only: the NPC /
// agency / arc bookkeeping for a buried turn would run against a state that has
// moved on, so it stays skipped (logged, not silently).
export async function retryFailedCommits(): Promise<number> {
    const store = useAppStore.getState();
    const messages = store.messages;
    const activeCampaignId = store.activeCampaignId ?? '';
    if (!activeCampaignId) return 0;

    // The current pending turn is owned by commitPendingTurn — don't race it.
    const ownedByCommit = findPendingCommitMessage(messages)?.id;
    const buried = messages.filter(m =>
        m.role === 'assistant' && m.commitFailed === true && !m.sceneId && m.id !== ownedByCommit
    );
    if (buried.length === 0) return 0;

    console.log(`[Reconcile] ${buried.length} unarchived turn(s) from failed commits — repairing`);
    const { api } = await import('../llm/apiClient');
    let repaired = 0;

    // Oldest first, so scene numbering follows story order.
    for (const msg of buried) {
        const userText = findTurnUserInput(messages, msg.id);
        if (!userText.trim()) {
            console.warn(`[Reconcile] Skipping ${msg.id} — no user half found to archive with`);
            continue;
        }
        const appended = await api.archive.append(activeCampaignId, userText, msg.content);
        if (!appended?.sceneId) {
            console.warn('[Reconcile] Repair append failed — leaving the turn flagged for the next launch');
            break; // Server still unreachable; stop rather than hammer it.
        }
        const fresh = useAppStore.getState().messages;
        const idx = fresh.findIndex(m => m.id === msg.id);
        if (idx !== -1) {
            const updated = [...fresh];
            const rest = { ...updated[idx], sceneId: appended.sceneId };
            delete rest.swipeSet;
            delete rest.pendingCommit;
            delete rest.swipeActiveIndex;
            delete rest.commitFailed;
            updated[idx] = rest as ChatMessage;
            useAppStore.setState({ messages: updated });
        }
        repaired++;
        console.log(`[Reconcile] Repaired turn ${msg.id} → scene #${appended.sceneId} (archive link only; post-turn bookkeeping for it stays skipped)`);
    }

    if (repaired > 0) {
        const s = useAppStore.getState();
        await saveCampaignState(activeCampaignId, {
            context: s.context, messages: s.messages, condenser: s.condenser, pinnedExcerpts: s.pinnedExcerpts,
        }).catch(e => console.warn('[Reconcile] Save after repair failed:', e));
        try {
            const freshIndex = await api.archive.getIndex(activeCampaignId);
            s.setArchiveIndex(freshIndex);
        } catch (e) {
            console.warn('[Reconcile] Index refresh after repair failed:', e);
        }
        toast.success(`Recovered ${repaired} unsaved scene${repaired > 1 ? 's' : ''} into long-term memory.`);
    }
    return repaired;
}

// ── Swipe-set helpers ──────────────────────────────────────────────────
// Check if a message is the latest GM message (eligible for 🔄)
export function isLatestGmMessage(messages: ChatMessage[], msgId: string): boolean {
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (m.role === 'assistant') return m.id === msgId;
        // Skip trailing system messages (timeskip-seam, etc.)
        if (m.role === 'system') continue;
        // If we hit a user message first, this isn't the latest GM
        if (m.role === 'user') return false;
    }
    return false;
}

// Check if a message has a browseable swipe set (pre-commit)
export function hasSwipeSet(msg: ChatMessage | undefined): boolean {
    return !!(msg && msg.swipeSet && msg.swipeSet.length > 0 && msg.pendingCommit);
}
