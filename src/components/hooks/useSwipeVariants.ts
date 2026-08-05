import { useState, useCallback, useRef, useEffect } from 'react';
import { useAppStore } from '../../store/useAppStore';
import {
    generateSwipeVariant,
    MAX_SWIPES,
    SWIPE_BASE_TEMP_OFFSET,
    computeSwipeTemperature,
} from '../../services/turn/swipeGeneration';
import { getCachedSwipePayload } from '../../services/turn/pendingCommit';
import type { SwipeVariant, ChatMessage } from '../../types';
import { toast } from '../Toast';
import { debouncedSaveCampaignState } from '../../store/slices/campaignSlice';
import { emitCoreEvent } from '../../services/mods/events';

/**
 * useSwipeVariants — manages the swipe set on the LATEST GM message.
 *
 * Lazy generation: one variant at a time, max MAX_SWIPES. A swipe still
 * streaming when the user swipes away FINISHES in background and fills its
 * slot; the onDone callback is guarded so a late result from a discarded slot
 * never touches the committed bubble or triggers post-turn work.
 *
 * Session temperature offset: opens at base + 0.1. If the user drags the
 * slider, the offset is remembered for the rest of this browse session and
 * reset on commit (the caller resets via resetSessionOffset).
 */
export function useSwipeVariants(messageId: string | null) {
    const [swipeGenLoading, setSwipeGenLoading] = useState(false);
    // Session offset remembered across swipes for this browse session.
    // Reset on commit by the caller calling resetSessionOffset.
    const sessionOffsetRef = useRef<number>(SWIPE_BASE_TEMP_OFFSET);
    // Active swipe-set generation id — guards against late results from a
    // discarded swipe set (the user committed, deleted, or rewound).
    const activeSetIdRef = useRef<string>(`set_${messageId ?? 'none'}`);
    // AbortController for the in-flight swipe generation.
    const abortRef = useRef<AbortController | null>(null);
    // Slot-level guard: the index of the slot currently being streamed into.
    // When the user navigates away from the streaming slot, onChunk stops
    // overwriting content. The generation still FINISHES in background and
    // fills its slot — it just doesn't touch the visible bubble.
    const streamingSlotRef = useRef<number | null>(null);

    // Reset the session offset (called by the caller on commit).
    const resetSessionOffset = useCallback(() => {
        sessionOffsetRef.current = SWIPE_BASE_TEMP_OFFSET;
    }, []);

    // Set the session offset (when the user drags the slider).
    const setSessionOffset = useCallback((offset: number) => {
        sessionOffsetRef.current = offset;
    }, []);

    const getSessionOffset = useCallback(() => sessionOffsetRef.current, []);

    // Compute the current swipe temperature from the active preset's base.
    const getSwipeTemperature = useCallback(() => {
        const store = useAppStore.getState();
        const activePreset = store.getActivePreset?.();
        const baseTemp = activePreset?.sampling?.temperature;
        return computeSwipeTemperature(baseTemp, sessionOffsetRef.current);
    }, []);

    // ── Browse: change the visible variant ──
    const setSwipeIndex = useCallback((index: number) => {
        if (!messageId) return;
        const store = useAppStore.getState();
        const msgs = store.messages;
        const idx = msgs.findIndex(m => m.id === messageId);
        if (idx === -1) return;
        const msg = msgs[idx];
        if (!msg.swipeSet || !msg.pendingCommit) return;
        if (index < 0 || index >= msg.swipeSet.length) return;

        const variant = msg.swipeSet[index];
        const updated = [...msgs];
        updated[idx] = {
            ...msg,
            swipeActiveIndex: index,
            // The visible variant's text becomes the message content (so the
            // bubble renders it). displayContent tracks it too. Edits apply
            // to this variant only — see updateVariantText.
            content: variant.text,
            displayContent: variant.text,
            reasoning_content: variant.reasoningContent,
        };
        useAppStore.setState({ messages: updated });

        // Phase 3.2 / `EVENTS.md` §6.7 — the browse half of `message.swiped`.
        // One event, two sites: a mod that mirrors the visible text does not care
        // *why* the visible variant changed, only that it did.
        emitCoreEvent('message.swiped', {
            campaignId: store.activeCampaignId ?? '',
            messageId,
            index,
            total: msg.swipeSet.length,
            generated: false,
        });

        // Slot-level guard: if the user navigated AWAY from a streaming slot,
        // stop the onChunk callback from overwriting the visible content. The
        // generation still finishes and fills its slot — it just doesn't touch
        // the visible bubble anymore.
        // BUT: if the user navigated BACK to the streaming slot, restore the
        // ref so onChunk resumes updating the visible content.
        if (variant.streaming) {
            streamingSlotRef.current = index;
        } else if (streamingSlotRef.current !== null && streamingSlotRef.current !== index) {
            streamingSlotRef.current = null;
        }

        // Persist the index change (debounced — mainApp server-based save).
        debouncedSaveCampaignState();
    }, [messageId]);

    const nextSwipe = useCallback(() => {
        if (!messageId) return;
        const msg = useAppStore.getState().messages.find(m => m.id === messageId);
        if (!msg?.swipeSet) return;
        const current = msg.swipeActiveIndex ?? 0;
        // Navigate between EXISTING filled slots only. Generation is triggered
        // explicitly via the Generate button in the sheet (which passes guidance).
        if (current < msg.swipeSet.length - 1) {
            setSwipeIndex(current + 1);
        }
        // At the last filled slot — do nothing. The user opens the sheet and
        // taps Generate (with optional guidance) to create the next variant.
    }, [messageId, setSwipeIndex]);

    const prevSwipe = useCallback(() => {
        if (!messageId) return;
        const msg = useAppStore.getState().messages.find(m => m.id === messageId);
        if (!msg?.swipeSet) return;
        const current = msg.swipeActiveIndex ?? 0;
        if (current > 0) setSwipeIndex(current - 1);
    }, [messageId, setSwipeIndex]);

    // ── Generate a new swipe variant ──
    // guidance: optional free-text instruction from the player for this variant.
    const generateSwipe = useCallback(async (guidance?: string) => {
        if (!messageId) return;
        if (swipeGenLoading) return;

        const store = useAppStore.getState();
        const msg = store.messages.find(m => m.id === messageId);
        if (!msg || !msg.pendingCommit || !msg.swipeSet) return;
        if (msg.swipeSet.length >= MAX_SWIPES) return;

        const provider = store.getActiveStoryEndpoint();
        if (!provider) {
            toast.error('No Story AI configured.');
            return;
        }

        const cachedPayload = getCachedSwipePayload();
        if (!cachedPayload) {
            toast.error('Swipe context lost — send a new message to regenerate.');
            return;
        }

        // Mark a new slot as streaming and switch to it.
        const newVariant: SwipeVariant = {
            id: `swipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            text: '',
            sceneStakes: 'calm',
            tagPresent: false,
            streaming: true,
        };
        const newSwipeSet = [...msg.swipeSet, newVariant];
        const newIndex = newSwipeSet.length - 1;
        const setTag = activeSetIdRef.current;
        const updateStore = (patch: Partial<ChatMessage>) => {
            const s = useAppStore.getState();
            const idx = s.messages.findIndex(m => m.id === messageId);
            if (idx === -1) return;
            const updated = [...s.messages];
            updated[idx] = { ...updated[idx], ...patch };
            useAppStore.setState({ messages: updated });
        };

        updateStore({
            swipeSet: newSwipeSet,
            swipeActiveIndex: newIndex,
            content: '',
            displayContent: '',
            reasoning_content: undefined,
        });

        // Mark which slot is streaming so onChunk knows whether to update the
        // visible content. Cleared when the user navigates away (setSwipeIndex)
        // or when generation completes.
        streamingSlotRef.current = newIndex;

        setSwipeGenLoading(true);
        abortRef.current = new AbortController();
        const abortSignal = abortRef.current.signal;

        try {
            const temperature = getSwipeTemperature();
            const { variant } = await generateSwipeVariant(
                {
                    provider,
                    cachedPayload,
                    modelName: provider.modelName,
                    temperature,
                    abortSignal,
                    guidance,
                },
                (chunk) => {
                    // Guard 1: is this swipe set still active? If commit already
                    // fired, drop the streaming result silently.
                    if (activeSetIdRef.current !== setTag) return;

                    // ALWAYS write the partial text to the streaming variant's
                    // `text` field in swipeSet, so it persists across navigation.
                    // The user can navigate away and back and still see the partial.
                    const s = useAppStore.getState();
                    const sIdx = s.messages.findIndex(m => m.id === messageId);
                    if (sIdx !== -1 && s.messages[sIdx].swipeSet) {
                        const updatedSwipeSet = s.messages[sIdx].swipeSet!.map(v =>
                            v.id === newVariant.id ? { ...v, text: chunk } : v
                        );
                        const updatedMsgs = [...s.messages];
                        // Only update the visible content if the user is still on
                        // the streaming slot. The variant's text is updated either way.
                        const stillViewing = streamingSlotRef.current === newIndex;
                        updatedMsgs[sIdx] = {
                            ...s.messages[sIdx],
                            swipeSet: updatedSwipeSet,
                            ...(stillViewing ? {
                                content: chunk,
                                displayContent: chunk,
                            } : {}),
                        };
                        useAppStore.setState({ messages: updatedMsgs });
                    }
                },
            );

            // Guard: late result from a discarded set — drop silently.
            if (activeSetIdRef.current !== setTag) {
                return;
            }

            // Fill the slot with the completed variant (regardless of whether
            // the user is still looking at it — the slot is filled in the
            // swipeSet array so the user can navigate back to it).
            const fresh = useAppStore.getState();
            const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
            if (freshIdx === -1) return;
            const freshMsg = fresh.messages[freshIdx];
            if (!freshMsg.swipeSet) return;
            const filledSet = freshMsg.swipeSet.map(v =>
                v.id === newVariant.id ? { ...variant, streaming: false } : v
            );
            const updated = [...fresh.messages];
            // Only update the visible content if the user is still on this slot.
            const stillViewing = streamingSlotRef.current === newIndex;
            updated[freshIdx] = {
                ...freshMsg,
                swipeSet: filledSet,
                ...(stillViewing ? {
                    content: variant.text,
                    displayContent: variant.text,
                    reasoning_content: variant.reasoningContent,
                } : {}),
            };
            useAppStore.setState({ messages: updated });
            streamingSlotRef.current = null;
            // Phase 3.2 / `EVENTS.md` §6.7 — the generation half: a newly
            // generated variant filled its slot.
            emitCoreEvent('message.swiped', {
                campaignId: fresh.activeCampaignId ?? '',
                messageId,
                index: newIndex,
                total: filledSet.length,
                generated: true,
            });
            debouncedSaveCampaignState();
        } catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError') return;
            if (err instanceof Error && err.message === '__ABORT__') return;
            console.warn('[Swipe] generation failed:', err);
            // Remove the empty streaming slot on failure.
            const fresh = useAppStore.getState();
            const freshIdx = fresh.messages.findIndex(m => m.id === messageId);
            if (freshIdx === -1) return;
            const freshMsg = fresh.messages[freshIdx];
            if (!freshMsg.swipeSet) return;
            const cleanedSet = freshMsg.swipeSet.filter(v => v.id !== newVariant.id);
            const fallbackIdx = Math.min(newIndex, cleanedSet.length - 1);
            const fallbackVariant = cleanedSet[fallbackIdx];
            const updated = [...fresh.messages];
            updated[freshIdx] = {
                ...freshMsg,
                swipeSet: cleanedSet.length > 0 ? cleanedSet : freshMsg.swipeSet,
                swipeActiveIndex: Math.max(0, fallbackIdx),
                content: fallbackVariant?.text ?? freshMsg.content,
                displayContent: fallbackVariant?.text ?? freshMsg.displayContent,
            };
            useAppStore.setState({ messages: updated });
            toast.error('Swipe generation failed — try again.');
        } finally {
            setSwipeGenLoading(false);
            abortRef.current = null;
        }
    }, [messageId, swipeGenLoading, getSwipeTemperature]);

    // ── Update a variant's text (pre-commit editing) ──
    // Edits apply to the visible variant only. The message content tracks the
    // edited text so the bubble renders it, and the variant's text is updated
    // so commit reads the edited text from the variant.
    const updateVariantText = useCallback((text: string) => {
        if (!messageId) return;
        const store = useAppStore.getState();
        const idx = store.messages.findIndex(m => m.id === messageId);
        if (idx === -1) return;
        const msg = store.messages[idx];
        if (!msg.swipeSet || !msg.pendingCommit) return;
        const activeIdx = msg.swipeActiveIndex ?? 0;
        const updatedSwipeSet = msg.swipeSet.map((v, i) =>
            i === activeIdx ? { ...v, text } : v
        );
        const updated = [...store.messages];
        updated[idx] = {
            ...msg,
            content: text,
            displayContent: text,
            swipeSet: updatedSwipeSet,
        };
        useAppStore.setState({ messages: updated });

        // Phase 3.2 / `EVENTS.md` §6.7 — the third user-edit path: a pre-commit
        // variant edit. `pending` is always true here, because the guard above
        // requires `pendingCommit`.
        emitCoreEvent('message.edited', {
            campaignId: store.activeCampaignId ?? '',
            messageId,
            role: msg.role,
            pending: true,
        });
    }, [messageId]);

    // ── Invalidate the swipe set (discard without commit) ──
    // Called when the message is deleted or rewound. The caller (handleDeleteOutput /
    // handleRegenerate) also calls clearPendingTurnSnapshot.
    const discardSwipeSet = useCallback(() => {
        activeSetIdRef.current = `set_discarded_${Date.now()}`;
        abortRef.current?.abort();
    }, []);

    // ── Cleanup on unmount or messageId change ──
    useEffect(() => {
        // When the messageId changes, invalidate the old set so any in-flight
        // streaming result lands nowhere.
        return () => {
            activeSetIdRef.current = `set_inactive_${Date.now()}`;
            abortRef.current?.abort();
        };
    }, [messageId]);

    // ── Invalidate when the message no longer has pendingCommit (committed) ──
    useEffect(() => {
        if (!messageId) return;
        const msg = useAppStore.getState().messages.find(m => m.id === messageId);
        if (msg && !msg.pendingCommit) {
            // The turn was committed (by handleSend, Arc Injector, etc.).
            // Invalidate so any in-flight swipe result lands nowhere.
            activeSetIdRef.current = `set_committed_${Date.now()}`;
            abortRef.current?.abort();
            // Reset the session offset on commit.
            sessionOffsetRef.current = SWIPE_BASE_TEMP_OFFSET;
        }
    });

    return {
        swipeGenLoading,
        generateSwipe,
        nextSwipe,
        prevSwipe,
        setSwipeIndex,
        updateVariantText,
        discardSwipeSet,
        resetSessionOffset,
        setSessionOffset,
        getSessionOffset,
        getSwipeTemperature,
    };
}