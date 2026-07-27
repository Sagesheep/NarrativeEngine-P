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
function buildCommitCallbacks(activeCampaignId: string): TurnCallbacks {
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
export async function commitPendingTurn(): Promise<void> {
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

    // The visible variant's CURRENT text — read from the message content
    // (which reflects edits the user may have made while browsing).
    const text = pendingMsg.content;

    // Determine scene stakes from the chosen variant.
    let sceneStakes: SceneStakes = variant.sceneStakes;
    if (!variant.tagPresent) {
        const utilityProvider = snapshot?.turnState.getUtilityEndpoint?.() ?? store.getActiveUtilityEndpoint?.();
        const aiTier = snapshot?.turnState.settings.aiTier ?? store.settings.aiTier;
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

    // Build the commit state — use the ORIGINAL TurnState reference but
    // override getMessages so the importance rater reads the snapshot,
    // never live getMessages() (a late commit must not see the next turn's messages).
    const commitState: TurnState = snapshot
        ? { ...snapshot.turnState, getMessages: () => snapshot.messages }
        : rebuildStateFromLiveStore(store);

    const commitCallbacks = buildCommitCallbacks(commitState.activeCampaignId ?? '');
    const snapshotMessages = commitState.getMessages();

    try {
        // WO-P1-03: pass the bus (carried by the snapshot across the commit
        // boundary) to the post-turn pipeline. Thread-only — the pipeline does
        // NOT yet read it; Project 4 will swap selected reads to bus fields.
        await runPostTurnPipeline(commitState, commitCallbacks, text, snapshotMessages, snapshot?.turnContext);

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
        toast.error('Turn committed but some archive updates may be missing. Your story is saved.');
    }

    // Clear the swipe set + pendingCommit marker — the bubble is now a
    // normal historical message. Flush immediately (commit path should not debounce).
    const freshStore = useAppStore.getState();
    const freshMsgs = freshStore.messages;
    const idx = freshMsgs.findIndex(m => m.id === pendingMsg.id);
    if (idx !== -1) {
        const updated = [...freshMsgs];
        const rest = { ...updated[idx] };
        delete rest.swipeSet;
        delete rest.pendingCommit;
        delete rest.swipeActiveIndex;
        updated[idx] = rest as ChatMessage;
        useAppStore.setState({ messages: updated });
        const activeCampaignId = commitState.activeCampaignId;
        if (activeCampaignId) {
            saveCampaignState(activeCampaignId, {
                context: useAppStore.getState().context,
                messages: updated,
                condenser: useAppStore.getState().condenser,
                pinnedExcerpts: useAppStore.getState().pinnedExcerpts,
            }).catch(e => console.warn('[Commit] saveCampaignState failed:', e));
        }
    }

    clearPendingTurnSnapshot();
}

// ── Rebuild TurnState from the live store (crash recovery path) ────────
// Used when pendingCommit is true on launch but the in-memory snapshot was
// lost (Electron/renderer death). At relaunch, no "next turn's messages"
// exist, so reading live is safe — the snapshot invariant (don't see the
// next turn's messages) holds vacuously.
function rebuildStateFromLiveStore(store: ReturnType<typeof useAppStore.getState>): TurnState {
    return {
        input: '',
        displayInput: '',
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
    if (!pendingMsg || !pendingMsg.swipeSet) return;

    console.log('[Reconcile] Found pendingCommit on launch — firing deferred runPostTurnPipeline');
    await commitPendingTurn();
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
