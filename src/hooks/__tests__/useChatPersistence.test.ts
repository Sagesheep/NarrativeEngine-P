// Regression guard for the "Save campaign" button.
//
// It used to write three IndexedDB keys and touch the server not at all:
//   - `nn_campaign_<id>_state` and `_npcs`, which nothing ever read;
//   - `nn_settings` carrying `settings.providers` in PLAINTEXT, overwriting
//     the encrypted record that `loadSettings` reads back at launch.
// It then reported "Campaign saved" regardless, so the user believed a save
// had happened when nothing durable had.
//
// The two properties pinned here: the button flushes pending saves to the
// server, and it never writes to IndexedDB.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const flushAllPendingSaves = vi.fn(async () => {});
const idbSet = vi.fn(async () => {});
const toastSuccess = vi.fn();
const toastError = vi.fn();

const state = {
    activeCampaignId: 'campaign-1',
    settings: { providers: [{ id: 'p1', apiKey: 'sk-SECRET-KEY' }] },
    context: {},
    messages: [],
    condenser: null,
    npcLedger: [],
};

vi.mock('idb-keyval', () => ({ set: idbSet, get: vi.fn(), del: vi.fn() }));
vi.mock('../../store/slices/campaignSlice', () => ({ flushAllPendingSaves }));
vi.mock('../../components/Toast', () => ({
    toast: { success: toastSuccess, error: toastError },
}));
vi.mock('../../services/archive-memory/archiveManager', () => ({ openArchive: vi.fn() }));
vi.mock('../../store/useAppStore', () => {
    const useAppStore = Object.assign(
        (selector: (s: typeof state) => unknown) => selector(state),
        { getState: () => state, subscribe: () => () => {} },
    );
    return { useAppStore };
});

beforeEach(() => {
    vi.clearAllMocks();
});

describe('useChatPersistence — save campaign', () => {
    it('flushes pending saves to the server', async () => {
        const { useChatPersistence } = await import('../useChatPersistence');
        const { result } = renderHook(() => useChatPersistence());

        await act(async () => { await result.current.handleForceSave(); });

        expect(flushAllPendingSaves).toHaveBeenCalledTimes(1);
        expect(toastSuccess).toHaveBeenCalledWith('Campaign saved');
    });

    it('never writes to IndexedDB, so provider keys cannot leak there', async () => {
        const { useChatPersistence } = await import('../useChatPersistence');
        const { result } = renderHook(() => useChatPersistence());

        await act(async () => { await result.current.handleForceSave(); });

        expect(idbSet).not.toHaveBeenCalled();
    });

    it('reports failure instead of claiming success', async () => {
        flushAllPendingSaves.mockRejectedValueOnce(new Error('network down'));
        const { useChatPersistence } = await import('../useChatPersistence');
        const { result } = renderHook(() => useChatPersistence());

        await act(async () => { await result.current.handleForceSave(); });

        expect(toastError).toHaveBeenCalledWith('Save failed');
        expect(toastSuccess).not.toHaveBeenCalled();
    });

    it('clears the saving flag when the flush settles', async () => {
        const { useChatPersistence } = await import('../useChatPersistence');
        const { result } = renderHook(() => useChatPersistence());

        expect(result.current.isSaving).toBe(false);
        await act(async () => { await result.current.handleForceSave(); });
        expect(result.current.isSaving).toBe(false);
    });
});
