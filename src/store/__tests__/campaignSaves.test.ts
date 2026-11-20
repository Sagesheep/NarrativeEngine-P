// The debounced campaign saves, against the real save pipeline with only `fetch` stubbed.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../components/Toast', () => ({ toast: { error: vi.fn(), warning: vi.fn(), info: vi.fn(), success: vi.fn() } }));

import { useAppStore } from '../useAppStore';
import {
    cancelPendingSaves,
    debouncedSaveCampaignState,
    debouncedSaveNPCLedger,
    flushAllPendingSaves,
    hasPendingSaves,
} from '../slices/campaignSlice';
import { toast } from '../../components/Toast';
import type { ChatMessage, NPCEntry } from '../../types';

type AppState = ReturnType<typeof useAppStore.getState>;
let fetchMock: ReturnType<typeof vi.fn>;
let status = 200;

const puts = (suffix: string) => fetchMock.mock.calls.filter(([url, init]) =>
    String(url).endsWith(suffix) && (init as RequestInit | undefined)?.method === 'PUT');

beforeEach(() => {
    vi.useFakeTimers();
    status = 200;
    fetchMock = vi.fn(async () => ({ ok: status < 400, status, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    cancelPendingSaves();
    vi.mocked(toast.error).mockClear();
    useAppStore.setState({ activeCampaignId: 'camp-a', messages: [] } as Partial<AppState>);
});

afterEach(() => {
    cancelPendingSaves();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('debounced campaign saves', () => {
    it('stops counting as pending once the save has gone out', async () => {
        debouncedSaveCampaignState();
        expect(hasPendingSaves()).toBe(true);
        await vi.advanceTimersByTimeAsync(1100);
        expect(puts('/campaigns/camp-a/state')).toHaveLength(1);
        // Was stuck at true: every close then asked "Leave site?".
        expect(hasPendingSaves()).toBe(false);
    });

    it('never writes the in-memory retry fields to disk', async () => {
        useAppStore.setState({
            messages: [{ id: 'm1', role: 'assistant', content: 'x', timestamp: 1, retryable: true, precontext: { big: 'payload' } } as unknown as ChatMessage],
        } as Partial<AppState>);
        debouncedSaveCampaignState();
        await vi.advanceTimersByTimeAsync(1100);
        const body = JSON.parse(String((puts('/campaigns/camp-a/state')[0][1] as RequestInit).body));
        expect(body.messages[0]).not.toHaveProperty('retryable');
        expect(body.messages[0]).not.toHaveProperty('precontext');
        expect(body.messages[0].content).toBe('x');
    });

    it('reports a save the server refused', async () => {
        status = 500;
        debouncedSaveCampaignState();
        await vi.advanceTimersByTimeAsync(1100);
        expect(toast.error).toHaveBeenCalledWith('Failed to save campaign state');
    });

    it('Save Now fails when the server refuses a write', async () => {
        status = 500;
        debouncedSaveCampaignState();
        await expect(flushAllPendingSaves()).rejects.toThrow(/failed/);
    });

    it('keeps one pending NPC save per campaign', async () => {
        debouncedSaveNPCLedger('camp-a', [{ id: 'n1', name: 'Rin' } as NPCEntry]);
        debouncedSaveNPCLedger('camp-b', [{ id: 'n2', name: 'Sol' } as NPCEntry]);
        await vi.advanceTimersByTimeAsync(1100);
        // A single shared timer used to drop camp-a's save here.
        expect(puts('/campaigns/camp-a/npcs')).toHaveLength(1);
        expect(puts('/campaigns/camp-b/npcs')).toHaveLength(1);
        expect(hasPendingSaves()).toBe(false);
    });
});
