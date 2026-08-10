import { useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import {
    generateSceneContinuation,
    buildSceneContinueDirective,
    computeLastSegmentWordCount,
    buildMergedContinueView,
} from '../../services/turn/sceneContinue';
import { getCachedSwipePayload, refreshPendingSnapshotMessage } from '../../services/turn/pendingCommit';
import { buildPayload } from '../../services/chatEngine';
import { gatherContext } from '../../services/turn/contextGatherer';
import { rebuildStateFromLiveStoreLike } from './sceneContinueFallback';
import { toast } from '../Toast';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { emitCoreEvent } from '../../services/mods/events';
// Phase 7.5 — enemy-subsystem plumbing, deleted with the subsystem in Phase 8.3.
import { buildEnemyVolatileSegment } from '../../services/enemy/enemyPayloadSegment';
import type { ChatMessage } from '../../types';

/**
 * useSceneContinue — extends the latest GM bubble in place (a swipe that appends
 * instead of replaces). Mirrors useSwipeVariants' guard architecture exactly:
 * activeSetIdRef (late results land nowhere after commit/discard), streamingSlotRef
 * (user navigates away mid-stream → generation keeps writing to its variant, stops
 * touching the visible bubble), error rollback, debouncedSaveCampaignState() on
 * completion.
 *
 * Continue is NOT a turn (R5): no counters, no commit, no armed-state consumption,
 * no scene-number change, no isStreaming/pipeline-phase globals — local loading
 * state only.
 *
 * The hook's AbortController is exposed via the returned `getAbortController` so the
 * global Stop control in ChatArea can abort a continue the same way it aborts a turn
 * (the ChatArea wires both abort controllers into the same Stop handler).
 */
export function useSceneContinue(messageId: string | null) {
    const [continueLoading, setContinueLoading] = useState(false);
    const activeSetIdRef = useRef<string>(`continue_${messageId ?? 'none'}`);
    const abortRef = useRef<AbortController | null>(null);
    const streamingSlotRef = useRef<number | null>(null);

    const runSceneContinue = useCallback(async () => {
        if (!messageId) return;
        if (continueLoading) return;

        const store = useAppStore.getState();
        const idx = store.messages.findIndex(m => m.id === messageId);
        if (idx === -1) return;
        const msg = store.messages[idx];
        if (!msg.pendingCommit || !msg.swipeSet) return;

        const provider = store.getActiveStoryEndpoint();
        if (!provider) {
            toast.error('No Story AI configured.');
            return;
        }

        // ── Capture pre-continue state for rollback and slot-guarding ──
        const preContinueContent = msg.content;
        const activeIdx = msg.swipeActiveIndex ?? 0;
        const setTag = activeSetIdRef.current;

        // ── Choose path: snapshot vs fallback ──
        const cachedPayload = getCachedSwipePayload();
        let basePayload: import('../../services/llm/llmService').OpenAIMessage[];
        let assistantText: string | null;
        let directive: string;

        const pcName = store.context.characterProfileData?.name ?? '';
        const targetWords = computeLastSegmentWordCount(msg.content);
        const allowDiceTool = store.context.diceFairnessActive === false;

        if (cachedPayload) {
            // Snapshot path — append assistant + system to the cached payload.
            basePayload = cachedPayload;
            assistantText = msg.content; // LIVE content — user may have swiped/edited
            directive = buildSceneContinueDirective({ pcName, targetWords, allowDiceTool });
        } else {
            // Fallback path — rebuild payload from live store (§6).
            const built = await buildFallbackPayload({
                pendingMsg: msg,
                pcName,
                targetWords,
                allowDiceTool,
                abortSignal: abortRef.current?.signal,
            });
            if (!built) {
                toast.error('Continue context unavailable — send a new message to regenerate.');
                return;
            }
            basePayload = built.basePayload;
            assistantText = null;
            // Directive is already the payload's final user message — pass empty so
            // generateSceneContinuation skips appending (§6.4).
            directive = built.directive;
        }

        // ── Streaming ──
        // Slot-level guard: while the user stays on activeIdx, also update the visible
        // content. If they navigate away, the variant's text is updated but the visible
        // bubble stops changing.
        streamingSlotRef.current = activeIdx;
        setContinueLoading(true);
        abortRef.current = new AbortController();
        const abortSignal = abortRef.current.signal;

        try {
            const temperature = store.getActivePreset()?.sampling?.temperature ?? 0.7;
            const result = await generateSceneContinuation(
                {
                    provider,
                    basePayload,
                    assistantText,
                    directive,
                    modelName: provider.modelName,
                    temperature,
                    allowDiceTool,
                    combatModeActive: false, // passed through to getToolDefinitions (unused for roll_dice filter)
                    abortSignal,
                },
                (partial) => {
                    // Guard 1: is this continue set still active? If commit fired, drop silently.
                    if (activeSetIdRef.current !== setTag) return;

                    const merged = buildMergedContinueView(preContinueContent, partial);

                    const s = useAppStore.getState();
                    const sIdx = s.messages.findIndex(m => m.id === messageId);
                    if (sIdx === -1 || !s.messages[sIdx].swipeSet) return;

                    // ALWAYS write the merged text to the variant's `text` field, so it
                    // persists across navigation. Visible content updates only if the user
                    // is still on the streaming slot.
                    const stillViewing = streamingSlotRef.current === activeIdx;
                    const updatedSwipeSet = s.messages[sIdx].swipeSet!.map((v, i) =>
                        i === activeIdx ? { ...v, text: merged } : v
                    );
                    const updatedMsgs = [...s.messages];
                    updatedMsgs[sIdx] = {
                        ...s.messages[sIdx],
                        swipeSet: updatedSwipeSet,
                        ...(stillViewing ? {
                            content: merged,
                            displayContent: merged,
                        } : {}),
                    };
                    useAppStore.setState({ messages: updatedMsgs });
                },
            );

            // Guard: late result from a discarded/committed set — drop silently.
            if (activeSetIdRef.current !== setTag) return;

            const finalMerged = buildMergedContinueView(preContinueContent, result.text);

            // ── On success ──
            // Patch variant activeIdx: text = finalMerged; if stakes !== null, OVERRIDE
            // the variant's sceneStakes + tagPresent. Do NOT touch reasoningContent (R4).
            const fresh = useAppStore.getState();
            const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
            if (freshIdx === -1) return;
            const freshMsg = fresh.messages[freshIdx];
            if (!freshMsg.swipeSet) return;
            const filledSet = freshMsg.swipeSet.map((v, i) => {
                if (i !== activeIdx) return v;
                return {
                    ...v,
                    text: finalMerged,
                    ...(result.stakes !== null ? {
                        sceneStakes: result.stakes,
                        tagPresent: true,
                    } : {}),
                };
            });
            const updated = [...fresh.messages];
            const stillViewing = streamingSlotRef.current === activeIdx;
            updated[freshIdx] = {
                ...freshMsg,
                swipeSet: filledSet,
                // Patch the message's visible content only if still viewing.
                ...(stillViewing ? {
                    content: finalMerged,
                    displayContent: finalMerged,
                } : {}),
                // Do NOT touch reasoning_content (R4).
            };
            useAppStore.setState({ messages: updated });
            streamingSlotRef.current = null;

            // Refresh the snapshot's frozen message copy so the commit-time importance
            // rater sees the merged text (snapshot.messages holds stale object refs otherwise).
            refreshPendingSnapshotMessage(messageId, { content: finalMerged });

            // Phase 3.2 / `EVENTS.md` §6.7 — after `refreshPendingSnapshotMessage`,
            // so the commit-time view and the store agree before any listener
            // runs. `addedText` is the continuation ONLY; the merged whole is on
            // the message.
            emitCoreEvent('message.continued', {
                campaignId: fresh.activeCampaignId ?? '',
                messageId,
                addedText: result.text,
            });

            // R8: persist after every merge.
            debouncedSaveCampaignState();
        } catch (err) {
            // ── On abort ──
            if (err instanceof DOMException && err.name === 'AbortError') {
                // Keep the partial merged text (matches main-turn behavior), still run
                // persistence with whatever streamed (skip stakes override), no toast.
                const fresh = useAppStore.getState();
                const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
                if (freshIdx !== -1) {
                    const freshMsg = fresh.messages[freshIdx];
                    const swipeSet = freshMsg.swipeSet;
                    if (swipeSet) {
                        const partialText = swipeSet[activeIdx]?.text ?? preContinueContent;
                        const filledSet = swipeSet.map((v, i) =>
                            i === activeIdx ? { ...v, text: partialText } : v
                        );
                        const updated = [...fresh.messages];
                        updated[freshIdx] = { ...freshMsg, swipeSet: filledSet };
                        useAppStore.setState({ messages: updated });
                        refreshPendingSnapshotMessage(messageId, { content: partialText });
                        debouncedSaveCampaignState();
                    }
                }
                return;
            }
            if (err instanceof Error && err.message === '__ABORT__') return;

            // ── On error (non-abort) ──
            console.warn('[SceneContinue] failed:', err);
            // Restore variant activeIdx text and (if still viewing) message content.
            const fresh = useAppStore.getState();
            const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
            if (freshIdx !== -1) {
                const freshMsg = fresh.messages[freshIdx];
                const swipeSet = freshMsg.swipeSet;
                if (swipeSet) {
                    const filledSet = swipeSet.map((v, i) =>
                        i === activeIdx ? { ...v, text: preContinueContent } : v
                    );
                    const stillViewing = streamingSlotRef.current === activeIdx;
                    const updated = [...fresh.messages];
                    updated[freshIdx] = {
                        ...freshMsg,
                        swipeSet: filledSet,
                        ...(stillViewing ? {
                            content: preContinueContent,
                            displayContent: preContinueContent,
                        } : {}),
                    };
                    useAppStore.setState({ messages: updated });
                }
            }
            toast.error('Continue failed — your reply is unchanged.');
        } finally {
            setContinueLoading(false);
            abortRef.current = null;
        }
    }, [messageId, continueLoading]);

    const discardSceneContinue = useCallback(() => {
        activeSetIdRef.current = `continue_discarded_${Date.now()}`;
        abortRef.current?.abort();
    }, []);

    /** Returns the in-flight AbortController so ChatArea's global Stop can abort it. */
    const getAbortController = useCallback(() => abortRef.current, []);

    // ── Cleanup on unmount or messageId change ──
    useEffect(() => {
        return () => {
            activeSetIdRef.current = `continue_inactive_${Date.now()}`;
            abortRef.current?.abort();
        };
    }, [messageId]);

    // ── Invalidate when the message no longer has pendingCommit (committed) ──
    useEffect(() => {
        if (!messageId) return;
        const msg = useAppStore.getState().messages.find(m => m.id === messageId);
        if (msg && !msg.pendingCommit) {
            activeSetIdRef.current = `continue_committed_${Date.now()}`;
            abortRef.current?.abort();
        }
    });

    return {
        continueLoading,
        runSceneContinue,
        discardSceneContinue,
        getAbortController,
    };
}

// ── Fallback payload builder (§6) ──────────────────────────────────────
// Snapshot-dead continue (e.g. app relaunched mid-browse). Builds a fresh payload
// WITHOUT store mutation. clearPinnedChapters is a no-op so the user's pins for
// their next real turn aren't spent here (§6.1).
async function buildFallbackPayload(opts: {
    pendingMsg: ChatMessage;
    pcName: string;
    targetWords: number;
    allowDiceTool: boolean;
    abortSignal?: AbortSignal;
}): Promise<{ basePayload: import('../../services/llm/llmService').OpenAIMessage[]; directive: string } | null> {
    const { pendingMsg, pcName, targetWords, allowDiceTool, abortSignal } = opts;
    const store = useAppStore.getState();

    const state = rebuildStateFromLiveStoreLike(store, {
        clearPinnedChapters: () => {}, // no-op (§6.1) — don't consume pins
        deepSearchThisTurn: false,
    });

    // Retrieval query: last real user input + the final ~500 chars of the pending GM reply.
    // NOT the directive text (it would retrieve garbage).
    const lastUser = [...store.messages].reverse().find(m => m.role === 'user');
    const userText = lastUser?.content ?? '';
    const gmTail = pendingMsg.content.slice(-500);
    const retrievalQuery = `${userText}\n\n${gmTail}`.trim();

    try {
        const gathered = await gatherContext(state, retrievalQuery, {
            chapters: store.chapters ?? [],
            pinnedChapterIds: store.pinnedChapterIds,
            clearPinnedChapters: () => {}, // no-op (§6.1)
            deepSearchThisTurn: false,
            setLoadingStatus: undefined,
        }, abortSignal);

        // Build the payload with the directive as the input (it becomes the final
        // user-role message — provider-safe shape). The live messages already include
        // the pending GM reply, so history contains it naturally.
        const directive = buildSceneContinueDirective({ pcName, targetWords, allowDiceTool });
        const payloadResult = buildPayload({
            settings: store.settings,
            context: store.context,
            history: store.messages,
            userMessage: directive,   // userMessage slot — directive becomes the final user message
            condensedUpToIndex: store.condenser.condensedUpToIndex,
            relevantLore: gathered.relevantLore,
            npcLedger: store.npcLedger,
            // Phase 7.5 — see `turnStages.ts`: the enemy block is a segment the
            // subsystem renders itself. Deleted with the subsystem in Phase 8.3.
            volatileSegments: [buildEnemyVolatileSegment(store)],
            archiveRecall: gathered.archiveRecall,
            // _sceneNumber dropped (WO-P1-01) — was unread.
            recommendedNPCNames: gathered.recommendedNPCNames,
            semanticFactText: gathered.semanticFactText,
            archiveIndex: store.archiveIndex,
            timelineEvents: gathered.timelineEvents,
            inventoryCategories: gathered.inventoryCategories as (import('../../types').InventoryItemCategory | 'equipped')[] | undefined,
            profileFields: gathered.profileFields as string[] | undefined,
            deepContextSummary: gathered.deepContextSummary,
            divergenceRegister: store.divergenceRegister,
            chapters: gathered.relevantRules ? undefined : store.chapters,
            onStageNpcIds: store.onStageNpcIds,
            relevantRules: gathered.relevantRules,
            rulesManifest: gathered.rulesManifest,
            pinnedExcerpts: store.pinnedExcerpts,
            // plannerEventTypes omitted — recomputed inside buildWorld.
            locationLedger: store.locationLedger,
            // nextTurnOocBrief omitted — continue has none.
            // watchdogNudge omitted — not wired for scene-continue.
            // directorBrief omitted — not wired for scene-continue.
            elevatedScenes: gathered.elevatedScenes,
            slottedRagSnippets: gathered.slottedRagSnippets,
        });

        return { basePayload: payloadResult.messages, directive: '' };
    } catch (err) {
        console.warn('[SceneContinue] fallback payload build failed:', err);
        return null;
    }
}
