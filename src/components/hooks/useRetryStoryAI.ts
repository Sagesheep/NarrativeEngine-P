import { useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { generateSwipeVariant, SWIPE_BASE_TEMP_OFFSET, computeSwipeTemperature } from '../../services/turn/swipeGeneration';
import { getCachedSwipePayload, refreshPendingSnapshotMessage } from '../../services/turn/pendingCommit';
import { clearGatherStages } from '../../services/turn/gatherProgress';
import type { ChatMessage } from '../../types';
import { toast } from '../Toast';
import { saveCampaignState } from '../../store/campaignStore';

// Smart Retry v1: re-enter the Story AI with the cached precontext, bypassing
// gatherContext. Reuses the same `generateSwipeVariant` primitive as swipes 2–5
// (consistent payload sanitization, scene-stakes parsing, abort handling).
//
// Differences from `useSwipeVariants.generateSwipe`:
//   1. Replaces the failed bubble's content in place (does NOT append a slot).
//   2. On success, stamps variant 0 + pendingCommit (swipe-style), so the
//      success path unifies with the existing swipe-browse UI.
//   3. Clears `retryable` on success so the Retry button disappears.
//
// v1 deltas from the mobile hook (per the work order):
//   - NO soft-edit / NO `newPromptText` parameter (§2.3 — desktop's engine-tag
//     set is richer than mobile's 4-pattern list; `patchUserPromptInPayload`
//     and `ENGINE_TAG_PATTERNS` are dropped entirely).
//   - Calls `refreshPendingSnapshotMessage(messageId, { content: variant.text })`
//     on success (§2.1 — desktop-only; the early snapshot freezes messages
//     before the Story AI runs, so the assistant bubble is empty at capture
//     time. Without this refresh, the next commit's importance rater reads an
//     empty assistant bubble from snapshot.messages). This is the single most
//     important line in the hook.
//   - Calls `clearGatherStages()` at start (§2.4 — retry bypasses gather, so
//     GenerationProgress may otherwise render stale stage labels).
//   - Imports `toast` from `../Toast` and `saveCampaignState` from
//     `../../store/campaignStore` (desktop paths differ from mobile's).
//
// v1 known limitations (documented, not fixed here):
//   1. `generateSwipeVariant` hard-codes `allowTools=false` + appends
//      `SWIPE_SYSTEM_LINE` ("narrate only from results already in history").
//      After a pre-tool failure there are no tool results in history, so a
//      retried turn cannot roll dice or query lore, and that system line is
//      mildly misleading. Inherited from mobile.
//   2. Scene Continue after a Retry runs off the early payload — no tool
//      history (§2.2). Accepted for v1.
//   3. No soft-edit (§2.3). Revisit as v2.

export function useRetryStoryAI() {
    const [retryLoading, setRetryLoading] = useState(false);
    const abortRef = useRef<AbortController | null>(null);
    // Guard tag: a committed/discarded retry set drops late results silently.
    const activeSetIdRef = useRef<string>(`retry_none`);

    const retryStoryAI = useCallback(async (messageId: string): Promise<void> => {
        if (retryLoading) return;
        const store = useAppStore.getState();
        const msg = store.messages.find(m => m.id === messageId);
        if (!msg || !msg.retryable) return;

        const provider = store.getActiveStoryEndpoint();
        if (!provider) {
            toast.error('No Story AI configured.');
            return;
        }

        const cachedPayload = getCachedSwipePayload();
        if (!cachedPayload) {
            toast.error('Context lost — send a new message to regenerate.');
            return;
        }

        // §2.4: retry bypasses gather, so clear any stale gather-stage labels
        // (a prior aborted turn may have left them in the live tracker).
        clearGatherStages();

        const setTag = activeSetIdRef.current;

        const updateStore = (patch: Partial<ChatMessage>) => {
            const s = useAppStore.getState();
            const idx = s.messages.findIndex(m => m.id === messageId);
            if (idx === -1) return;
            const updated = [...s.messages];
            updated[idx] = { ...updated[idx], ...patch } as ChatMessage;
            useAppStore.setState({ messages: updated });
        };

        // Clear the retryable flag + partial error text — we're regenerating.
        // precontext stays so the box remains visible during the retry; it's
        // cleared on success (swipeSet replaces it).
        updateStore({
            retryable: undefined,
            content: '',
            displayContent: '',
            reasoning_content: undefined,
        });

        setRetryLoading(true);
        abortRef.current = new AbortController();
        const abortSignal = abortRef.current.signal;

        try {
            const activePreset = store.settings.presets.find(p => p.id === store.settings.activePresetId);
            const baseTemp = activePreset?.sampling?.temperature;
            const temperature = computeSwipeTemperature(baseTemp, SWIPE_BASE_TEMP_OFFSET);

            const { variant } = await generateSwipeVariant(
                {
                    provider,
                    cachedPayload,
                    modelName: provider.modelName,
                    temperature,
                    abortSignal,
                },
                (chunk) => {
                    if (abortSignal.aborted) return;
                    if (activeSetIdRef.current !== setTag) return;
                    const s = useAppStore.getState();
                    const idx = s.messages.findIndex(m => m.id === messageId);
                    if (idx === -1) return;
                    const updated = [...s.messages];
                    updated[idx] = {
                        ...s.messages[idx],
                        content: chunk,
                        displayContent: chunk,
                    };
                    useAppStore.setState({ messages: updated });
                },
            );

            // Guard: late result from a discarded/committed set — drop silently.
            if (activeSetIdRef.current !== setTag) return;
            if (abortSignal.aborted) return;

            // Success: stamp variant 0 + pendingCommit (unify with swipe UI).
            // Clear retryable so the Retry button disappears.
            const fresh = useAppStore.getState();
            const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
            if (freshIdx === -1) return;
            const updated = [...fresh.messages];
            updated[freshIdx] = {
                ...fresh.messages[freshIdx],
                content: variant.text,
                displayContent: variant.text,
                reasoning_content: variant.reasoningContent,
                swipeSet: [variant],
                pendingCommit: true,
                swipeActiveIndex: 0,
                retryable: undefined,
            };
            useAppStore.setState({ messages: updated });

            // §2.1 — CRITICAL: refresh the snapshot's frozen message copy so the
            // next commit's importance rater reads the final text, not the empty
            // assistant bubble captured before the Story AI ran. Without this,
            // the archive entry is rated on nothing (silent archive corruption).
            refreshPendingSnapshotMessage(messageId, { content: variant.text });

            if (fresh.activeCampaignId) {
                saveCampaignState(fresh.activeCampaignId, {
                    context: fresh.context,
                    messages: updated,
                    condenser: fresh.condenser,
                    pinnedExcerpts: fresh.pinnedExcerpts,
                }).catch(e => console.warn('[Retry] saveCampaignState failed:', e));
            }
        } catch (err) {
            // ── On abort ──
            if (err instanceof DOMException && err.name === 'AbortError') {
                // Keep whatever streamed (matches Scene Continue's abort idiom),
                // re-stamp retryable so the user can try again, persist partial.
                if (activeSetIdRef.current !== setTag) return;
                const fresh = useAppStore.getState();
                const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
                if (freshIdx !== -1) {
                    const partialText = fresh.messages[freshIdx].content ?? '';
                    const updated = [...fresh.messages];
                    updated[freshIdx] = {
                        ...fresh.messages[freshIdx],
                        retryable: true,
                        ...(partialText ? {} : { content: '⚠️ Retry aborted.' }),
                    };
                    useAppStore.setState({ messages: updated });
                }
                return;
            }
            if (err instanceof Error && err.message === '__ABORT__') return;

            // ── On error (non-abort) ──
            console.warn('[Retry] generation failed:', err);
            if (activeSetIdRef.current !== setTag) return;
            // Re-stamp retryable so the user can try again.
            updateStore({ retryable: true });
            toast.error('Retry failed — try again.');
        } finally {
            setRetryLoading(false);
            abortRef.current = null;
        }
    }, [retryLoading]);

    const abortRetry = useCallback(() => {
        abortRef.current?.abort();
    }, []);

    // ── Cleanup on unmount ──
    useEffect(() => {
        return () => {
            activeSetIdRef.current = `retry_inactive_${Date.now()}`;
            abortRef.current?.abort();
        };
    }, []);

    return { retryStoryAI, retryLoading, abortRetry };
}