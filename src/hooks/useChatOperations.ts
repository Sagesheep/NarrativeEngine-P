import { useState, useRef, useEffect } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useAppStore } from '../store/useAppStore';
import { runTurn } from '../services/turn/turnOrchestrator';
import { commitPendingTurn, findRetryableMessage, persistPendingTurn } from '../services/turn/pendingCommit';
import { debouncedSaveCampaignState } from '../store/slices/campaignSlice';
import type { InventoryProposal } from '../types';
import type { useSceneContinue } from '../components/hooks/useSceneContinue';

/**
 * Send / stop / abort lifecycle for the main chat turn loop, extracted from
 * ChatArea. Owns the streaming flags, the AbortController, the live streaming
 * stats ticker, and the staged GM inventory proposal.
 */
export function useChatOperations({
    input,
    setInput,
    resetTextareaHeight,
    oocBusy,
    armedAskGmBrief,
    setArmedAskGmBrief,
    sceneContinue,
    checkAndSealChapter,
}: {
    input: string;
    setInput: (v: string) => void;
    resetTextareaHeight: () => void;
    oocBusy: boolean;
    armedAskGmBrief: { campaignId: string; text: string } | null;
    setArmedAskGmBrief: (v: { campaignId: string; text: string } | null) => void;
    sceneContinue: ReturnType<typeof useSceneContinue>;
    checkAndSealChapter: (campaignId: string) => void;
}) {
    const context = useAppStore(s => s.context);
    const activeCampaignId = useAppStore(s => s.activeCampaignId);
    const deepArmed = useAppStore(s => s.deepArmed);
    const setDeepArmed = useAppStore(s => s.setDeepArmed);

    const { settings, loreChunks, npcLedger, enemyCompendium, enemyInstances, enemyEncounters, enemyCombatConfig, archiveIndex } = useAppStore(
        useShallow(s => ({
            settings: s.settings,
            loreChunks: s.loreChunks,
            npcLedger: s.npcLedger,
            enemyCompendium: s.enemyCompendium,
            enemyInstances: s.enemyInstances,
            enemyEncounters: s.enemyEncounters,
            enemyCombatConfig: s.enemyCombatConfig,
            archiveIndex: s.archiveIndex,
        }))
    );

    const {
        setArchiveIndex, updateLastAssistant, updateLastAssistantMessage, updateContext, setCondensed,
        setTimeline, setChapters,
        pipelinePhase, setPipelinePhase, setStreamingStats,
    } = useAppStore(
        useShallow(s => ({
            setArchiveIndex: s.setArchiveIndex,
            updateLastAssistant: s.updateLastAssistant,
            updateLastAssistantMessage: s.updateLastAssistantMessage,
            updateContext: s.updateContext,
            setCondensed: s.setCondensed,
            setTimeline: s.setTimeline,
            setChapters: s.setChapters,
            pipelinePhase: s.pipelinePhase,
            setPipelinePhase: s.setPipelinePhase,
            setStreamingStats: s.setStreamingStats,
        }))
    );

    const [isStreaming, setStreaming] = useState(false);
    const [, setIsCheckingNotes] = useState(false);
    const [loadingStatus, setLoadingStatus] = useState<string | null>(null);
    // Phase 6: GM-proposed inventory change awaiting user confirmation.
    const [pendingProposal, setPendingProposal] = useState<InventoryProposal | null>(null);
    // WO-A2 §2.1 — first-send intercept modal. `pendingPcPrompt` is set when
    // handleSend blocks on a missing PC; the UI renders a modal and calls
    // `resolvePcPrompt` with 'create' | 'proceed' | 'cancel'.
    const [pendingPcPrompt, setPendingPcPrompt] = useState(false);
    const pcPromptResolverRef = useRef<((decision: 'create' | 'proceed' | 'cancel') => void) | null>(null);
    const promptPcCreation = (): Promise<'create' | 'proceed' | 'cancel'> => {
        return new Promise(resolve => {
            pcPromptResolverRef.current = resolve;
            setPendingPcPrompt(true);
        });
    };
    const resolvePcPrompt = (decision: 'create' | 'proceed' | 'cancel') => {
        setPendingPcPrompt(false);
        pcPromptResolverRef.current?.(decision);
        pcPromptResolverRef.current = null;
    };
    // WO-05: Director Brief UI state. `directorBriefRunning` toggles the
    // "Director drafting brief…" status + Skip affordance in GenerationProgress.
    // `directorAbortRef` is the abort handle for the Director call ONLY — aborting
    // it does NOT abort the turn's `abortControllerRef`. The orchestrator combines
    // both signals via `AbortSignal.any` so an outer Stop still aborts the Director.
    const [directorBriefRunning, setDirectorBriefRunning] = useState(false);
    const directorAbortRef = useRef<AbortController | null>(null);
    const abortControllerRef = useRef<AbortController | null>(null);
    const streamStartRef = useRef<number>(0);

    useEffect(() => {
        if (pipelinePhase === 'generating') {
            streamStartRef.current = Date.now();
        }
    }, [pipelinePhase]);

    useEffect(() => {
        if (pipelinePhase !== 'generating') {
            setStreamingStats(null);
            return;
        }
        const interval = setInterval(() => {
            const msgs = useAppStore.getState().messages;
            const last = msgs[msgs.length - 1];
            if (!last || last.role !== 'assistant') return;
            const tokens = Math.round(last.content.length / 4);
            const elapsed = Date.now() - streamStartRef.current;
            const speed = elapsed > 0 ? (tokens / (elapsed / 1000)) : 0;
            setStreamingStats({ tokens, elapsed, speed });
        }, 500);
        return () => clearInterval(interval);
    }, [pipelinePhase, setStreamingStats]);

    const handleSend = async (overrideText?: string, deepSearch = false) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming || oocBusy) return;

        // WO-A2 §2.1 Trigger B — first-send intercept. If no PC exists and the
        // user hasn't dismissed the prompt for this campaign, block the send
        // and ask whether they want to create a character or proceed anyway.
        // Ask once per campaign: "Proceed anyway" sets `context.pcPromptDismissed`
        // and the intercept never fires again in that campaign.
        const st = useAppStore.getState();
        if (!st.context.playerCharacter && !st.context.pcPromptDismissed) {
            const decision = await promptPcCreation();
            if (decision === 'create') {
                st.togglePCPanel();
                return;
            }
            // 'proceed' → set the dismissed flag and continue.
            st.updateContext({ pcPromptDismissed: true } as never);
        }

        const useDeepSearch = deepSearch || deepArmed;
        if (deepArmed) setDeepArmed(false);

        // Consume the armed dice mode (cleared whether or not a roll was set this turn).
        const useArmedRoll = useAppStore.getState().armedRoll;
        useAppStore.getState().setArmedRoll(null);

        const useArmedLoot = useAppStore.getState().armedLoot;
        useAppStore.getState().clearArmedLoot();

        // One-Shot Event Injector v1: capture then clear, exactly like the
        // dice/loot arming above. Cleared BEFORE runTurn so it fires exactly
        // once even if the turn errors mid-stream (mirrors armedRoll/armedLoot).
        const useArmedOneShot = useAppStore.getState().armedOneShot;
        useAppStore.getState().setArmedOneShot(null);

        // Absolute Command v1: capture then clear before runTurn, mirroring
        // armedOneShot. Fires exactly once; the command block travels as a
        // buildPayload parameter (placed after userMessage), never on
        // historyInput so it never persists in chat history.
        const useAbsoluteCommand = useAppStore.getState().armedAbsoluteCommand;
        useAppStore.getState().setArmedAbsoluteCommand(null);

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        // Smart Retry v1: clear stale retryable/precontext flags on any older
        // bubble before starting a new turn. A retryable bubble from a prior
        // failed turn is no longer retryable once the user moves on — its cached
        // precontext is orphaned by the new turn's gather. Also clears the
        // in-memory snapshot so the orphaned payload doesn't linger.
        const staleRetryable = findRetryableMessage(useAppStore.getState().messages);
        if (staleRetryable) {
            const msgs = useAppStore.getState().messages;
            const idx = msgs.findIndex(m => m.id === staleRetryable.id);
            if (idx !== -1) {
                const updated = [...msgs];
                updated[idx] = { ...updated[idx], retryable: undefined, precontext: undefined };
                useAppStore.setState({ messages: updated });
            }
        }

        abortControllerRef.current = new AbortController();
        // WO-05: fresh skip handle for this turn's Director call. Cleared on
        // turn end (handleStop / phase 'done') so a stale abort never leaks
        // into the next turn. The orchestrator combines this signal with the
        // turn's abort signal via `AbortSignal.any`.
        directorAbortRef.current = new AbortController();

        const storeSnapshot = useAppStore.getState();

        // Swipe Generation v1 — commit any pending turn BEFORE the next turn's
        // gatherContext. The previous turn's post-turn work (archive append,
        // agency tick, arc tick, witness capture) must fire on the variant the
        // user is keeping, before the next turn re-gathers context. A late
        // swipe result still streaming in the background finishes and fills its
        // slot (the onDone guard drops it silently once commit fired).
        await commitPendingTurn().catch(e => console.warn('[ChatArea] commit failed:', e));
        const storyProvider = storeSnapshot.getActiveStoryEndpoint();
        if (!storyProvider) return;
        const useAskGmBrief = armedAskGmBrief?.campaignId === activeCampaignId ? armedAskGmBrief.text : undefined;
        // Consume only as the real story run begins. runTurn builds once, so retries reuse this payload.
        if (useAskGmBrief) {
            setArmedAskGmBrief(null);
        }

        await runTurn({
            input: textToUse,
            displayInput: textToUse,
            settings,
            context,
            messages: storeSnapshot.messages,
            condenser: storeSnapshot.condenser,
            loreChunks,
            npcLedger,
            enemyCompendium,
            enemyInstances,
            enemyEncounters,
            enemyCombatConfig,
            archiveIndex,
            activeCampaignId,
            provider: storyProvider,
            getMessages: () => useAppStore.getState().messages,
            getFreshProvider: () => useAppStore.getState().getActiveStoryEndpoint(),
            getUtilityEndpoint: () => useAppStore.getState().getActiveUtilityEndpoint(),
            timeline: storeSnapshot.timeline,
            chapters: storeSnapshot.chapters,
            pinnedChapterIds: storeSnapshot.pinnedChapterIds,
            clearPinnedChapters: storeSnapshot.clearPinnedChapters,
            setChapters: setChapters,
            incrementBookkeepingTurnCounter: storeSnapshot.incrementBookkeepingTurnCounter,
            resetBookkeepingTurnCounter: storeSnapshot.resetBookkeepingTurnCounter,
            autoBookkeepingInterval: storeSnapshot.autoBookkeepingInterval,
            getFreshContext: () => useAppStore.getState().context,
            sampling: storeSnapshot.getActivePreset()?.sampling,
            deepSearchThisTurn: useDeepSearch,
            divergenceRegister: storeSnapshot.divergenceRegister,
            onStageNpcIds: storeSnapshot.onStageNpcIds,
            pinnedExcerpts: storeSnapshot.pinnedExcerpts,
            armedRoll: useArmedRoll,
            armedLoot: useArmedLoot,
            armedOneShot: useArmedOneShot,
            absoluteCommand: useAbsoluteCommand,
            getFreshAuxiliaryProvider: () => {
                const aux = useAppStore.getState().getActiveAuxiliaryEndpoint();
                return aux?.modelName ? aux : useAppStore.getState().getActiveStoryEndpoint();
            },
            nextTurnOocBrief: useAskGmBrief,
            directorSkipController: directorAbortRef.current,
        }, {
            onCheckingNotes: setIsCheckingNotes,
            addMessage: storeSnapshot.addMessage,
            updateLastAssistant: updateLastAssistant,
            updateLastMessage: storeSnapshot.updateLastMessage,
            updateLastAssistantMessage: updateLastAssistantMessage,
            updateContext: updateContext,
            setArchiveIndex: setArchiveIndex,
            setTimeline: setTimeline,
            updateNPC: storeSnapshot.updateNPC,
            addNPC: storeSnapshot.addNPC,
            setCondensed: setCondensed,
            setStreaming: setStreaming,
            setLoadingStatus: setLoadingStatus,
            setPipelinePhase: setPipelinePhase,
            setLastPayloadTrace: storeSnapshot.setLastPayloadTrace,
            setDivergenceRegister: storeSnapshot.setDivergenceRegister,
            setOnStageNpcIds: storeSnapshot.setOnStageNpcIds,
            addNpcSuggestions: storeSnapshot.addNpcSuggestions,
            archiveNPC: storeSnapshot.archiveNPC,
            restoreNPC: storeSnapshot.restoreNPC,
            stageInventoryProposal: (proposal) => setPendingProposal(proposal),
            // Durable-commit v1: flush the finished turn (text + pendingCommit + swipe
            // set) the moment it is staged, so an improper close or an idle timeout
            // before the deferred commit leaves a recoverable turn on disk instead of
            // an orphaned GM bubble that no code path can ever archive.
            persistTurnState: () => { void persistPendingTurn(); },
            onDirectorBriefPhase: (phase) => {
                // 'running' → show "Director drafting brief…" + Skip; 'done' → hide.
                // The flag toggles true on start and false on settle (success,
                // timeout, abort, parse-failure — `runDirectorBrief` always returns).
                setDirectorBriefRunning(phase === 'running');
                if (phase === 'done') {
                    // Drop the skip handle so a stale abort never fires after settle.
                    directorAbortRef.current = null;
                }
            },
        }, abortControllerRef.current);

        if (activeCampaignId) {
            checkAndSealChapter(activeCampaignId);
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        // Scene Continue v1: abort an in-flight continue too (the global Stop owns
        // every streaming operation — no second stop button is built).
        sceneContinue.getAbortController()?.abort();
        setStreaming(false);
        setIsCheckingNotes(false);
        setLoadingStatus(null);
        setPipelinePhase('idle');
        // WO-05: clear Director UI state on a full Stop. The outer abort already
        // cancels the Director via `AbortSignal.any`; this just resets the flag +
        // drops the stale skip handle. `onDirectorBriefPhase('done')` may also fire
        // from the orchestrator's `finally`, but the outer-stop path can short-
        // circuit before reaching it, so reset here too.
        setDirectorBriefRunning(false);
        directorAbortRef.current = null;
        debouncedSaveCampaignState();
    };

    /** WO-05: Skip the in-flight Director Brief call only. Aborts the Director
     *  signal without aborting the turn's `AbortController`; the orchestrator's
     *  `AbortSignal.any` resolves the combined signal, `runDirectorBrief` catches
     *  internally and returns null, and the turn continues without a Brief.
     *  No-op when no Director call is in flight. */
    const handleSkipDirectorBrief = () => {
        if (directorAbortRef.current) {
            directorAbortRef.current.abort();
            directorAbortRef.current = null;
            // The orchestrator's `finally` fires `onDirectorBriefPhase('done')`,
            // which clears `directorBriefRunning`. Set false here too as a hedge
            // in case the orchestrator path never reaches the finally (it does,
            // but this keeps the UI honest if a future refactor changes that).
            setDirectorBriefRunning(false);
        }
    };

    return {
        isStreaming,
        loadingStatus,
        pendingProposal,
        setPendingProposal,
        pendingPcPrompt,
        resolvePcPrompt,
        handleSend,
        handleStop,
        directorBriefRunning,
        handleSkipDirectorBrief,
    };
}
