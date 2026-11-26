/* eslint-disable @typescript-eslint/no-explicit-any */
// Smart Retry v1 — Phase 3 hook tests.
//
// Freezes the two load-bearing contracts from the work order §4:
//   1. Retry success ⇒ snapshot.messages for that id carries the FINAL text, not
//      empty (§2.1 — the single most important line: refreshPendingSnapshotMessage).
//   2. Abort mid-retry leaves the bubble retryable:true (re-armable).
// Also asserts: clearGatherStages fires at retry start (§2.4); the cached
// payload comes from getCachedSwipePayload; saveCampaignState is invoked on
// success; the success path stamps swipeSet + pendingCommit (swipe-UI unification).
//
// Uses the REAL useAppStore (no mock) so the hook reads/writes through the same
// Zustand store it uses in production. State is seeded via useAppStore.setState.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// ── Service mocks (hoisted) ──────────────────────────────────────────────
const generateSwipeVariantMock = vi.fn();
const getCachedSwipePayloadMock = vi.fn();
const refreshPendingSnapshotMessageMock = vi.fn((..._args: unknown[]) => undefined);
const clearGatherStagesMock = vi.fn((..._args: unknown[]) => undefined);
const saveCampaignStateMock = vi.fn(async (..._args: unknown[]) => {});

vi.mock('../../../services/turn/swipeGeneration', () => ({
    generateSwipeVariant: (...args: unknown[]) => generateSwipeVariantMock(...args),
    SWIPE_BASE_TEMP_OFFSET: 0.1,
    computeSwipeTemperature: (base: number, off: number) => base + off,
}));

vi.mock('../../../services/turn/pendingCommit', () => ({
    getCachedSwipePayload: () => getCachedSwipePayloadMock(),
    refreshPendingSnapshotMessage: (...args: unknown[]) => refreshPendingSnapshotMessageMock(...args),
}));

vi.mock('../../../services/turn/gatherProgress', () => ({
    clearGatherStages: (...args: unknown[]) => clearGatherStagesMock(...args),
}));

vi.mock('../../../store/campaignStore', () => ({
    saveCampaignState: (...args: unknown[]) => saveCampaignStateMock(...args),
}));

// ── SUT + real store imports (after mocks hoist) ──────────────────────────
import { useAppStore } from '../../../store/useAppStore';
import { useRetryStoryAI } from '../useRetryStoryAI';

function retryableMsg(overrides: Partial<Record<string, any>> = {}): any {
    return {
        id: 'a1',
        role: 'assistant',
        content: '⚠️ Error: fail',
        timestamp: 1,
        retryable: true,
        precontext: { summary: 'Lore×1 · Archive×2' },
        ...overrides,
    };
}

/** Seed the real store with the minimum state the hook reads. The hook needs
 *  getActiveStoryEndpoint() to return a truthy provider, which requires
 *  presets[0].storyAIProviderId + a matching providers[] entry. */
function seedStore(messages: any[]): void {
    useAppStore.setState({
        messages,
        settings: {
            presets: [{ id: 'p1', storyAIProviderId: 'prov1', sampling: { temperature: 0.7 } }],
            activePresetId: 'p1',
            aiTier: 'lite',
            providers: [{ id: 'prov1', endpoint: 'http://x', modelName: 'm' }],
        } as any,
        activeCampaignId: 'camp1',
        context: {} as any,
        condenser: { condensedUpToIndex: -1 } as any,
        pinnedExcerpts: undefined,
    } as any);
}

describe('Smart Retry v1 — useRetryStoryAI hook', () => {
    beforeEach(() => {
        generateSwipeVariantMock.mockReset();
        getCachedSwipePayloadMock.mockReset();
        refreshPendingSnapshotMessageMock.mockReset();
        clearGatherStagesMock.mockReset();
        saveCampaignStateMock.mockReset();
        saveCampaignStateMock.mockResolvedValue(undefined);
        seedStore([retryableMsg()]);
        getCachedSwipePayloadMock.mockReturnValue([{ role: 'user', content: 'cached payload' }]);
    });

    it('retry success refreshes the snapshot with the FINAL text (§2.1 — not the empty pre-Story-AI capture)', async () => {
        const finalText = 'The dragon rears back, scales glinting.';
        generateSwipeVariantMock.mockImplementation(
            async (_opts: any, onChunk: (t: string) => void) => {
                onChunk('partial...');
                return { variant: { id: 'v1', text: finalText, sceneStakes: 'calm', tagPresent: false } };
            },
        );

        const { result } = renderHook(() => useRetryStoryAI());
        await act(async () => {
            await result.current.retryStoryAI('a1');
        });

        // §2.1: refreshPendingSnapshotMessage called with the final variant text.
        expect(refreshPendingSnapshotMessageMock).toHaveBeenCalledWith('a1', { content: finalText });
        // The store message now carries the final text + swipeSet + pendingCommit.
        const stamped = useAppStore.getState().messages.find((m: any) => m.id === 'a1')!;
        expect(stamped.content).toBe(finalText);
        expect(stamped.swipeSet?.[0]?.text).toBe(finalText);
        expect(stamped.pendingCommit).toBe(true);
        expect(stamped.retryable).toBeUndefined();
        // saveCampaignState fired on success.
        expect(saveCampaignStateMock).toHaveBeenCalledTimes(1);
        // clearGatherStages fired at start (§2.4).
        expect(clearGatherStagesMock).toHaveBeenCalledTimes(1);
        // The cached payload was read from the in-memory snapshot.
        expect(getCachedSwipePayloadMock).toHaveBeenCalled();
    });

    it('abort mid-retry leaves the bubble retryable:true (re-armable)', async () => {
        const abortErr = new DOMException('Aborted', 'AbortError');
        generateSwipeVariantMock.mockRejectedValue(abortErr);

        const { result } = renderHook(() => useRetryStoryAI());
        await act(async () => {
            await result.current.retryStoryAI('a1');
        });

        const stamped = useAppStore.getState().messages.find((m: any) => m.id === 'a1')!;
        // Re-armed: retryable back to true so the Retry button renders again.
        expect(stamped.retryable).toBe(true);
        // No snapshot refresh on abort.
        expect(refreshPendingSnapshotMessageMock).not.toHaveBeenCalled();
        // No save on abort.
        expect(saveCampaignStateMock).not.toHaveBeenCalled();
    });

    it('non-abort error re-stamps retryable:true so the user can try again', async () => {
        generateSwipeVariantMock.mockRejectedValue(new Error('network down'));

        const { result } = renderHook(() => useRetryStoryAI());
        await act(async () => {
            await result.current.retryStoryAI('a1');
        });

        const stamped = useAppStore.getState().messages.find((m: any) => m.id === 'a1')!;
        expect(stamped.retryable).toBe(true);
        expect(refreshPendingSnapshotMessageMock).not.toHaveBeenCalled();
    });

    it('no cached payload ⇒ Context lost toast, no generation call', async () => {
        getCachedSwipePayloadMock.mockReturnValue(null);

        const { result } = renderHook(() => useRetryStoryAI());
        await act(async () => {
            await result.current.retryStoryAI('a1');
        });

        expect(generateSwipeVariantMock).not.toHaveBeenCalled();
        expect(refreshPendingSnapshotMessageMock).not.toHaveBeenCalled();
        // The bubble stays retryable (the flag was not cleared — early return before the clear).
        expect(useAppStore.getState().messages.find((m: any) => m.id === 'a1')?.retryable).toBe(true);
    });

    it('a non-retryable message is a no-op (no generation, no state change)', async () => {
        seedStore([{ id: 'a2', role: 'assistant', content: 'ok', timestamp: 1 }]);

        const { result } = renderHook(() => useRetryStoryAI());
        await act(async () => {
            await result.current.retryStoryAI('a2');
        });

        expect(generateSwipeVariantMock).not.toHaveBeenCalled();
        expect(clearGatherStagesMock).not.toHaveBeenCalled();
    });
});