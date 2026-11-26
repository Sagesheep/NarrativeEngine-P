import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useAppStore } from '../useAppStore';
import { cancelPendingSaves, flushAllPendingSaves } from '../slices/campaignSlice';
import type { DivergenceEntry, DivergenceRegister } from '../../types';

/**
 * Edits to established facts must reach disk on their own.
 *
 * Every edit action used to call the campaign-state save, which writes
 * context, messages, condenser and pins — never the register, which has its
 * own route. A manual fact edit therefore survived only if a turn committed or
 * the user pressed Exit before the window closed, and each click paid for a
 * full campaign-state write instead.
 */

type AppState = ReturnType<typeof useAppStore.getState>;

function entry(id: string, text = `fact ${id}`): DivergenceEntry {
    return { id, chapterId: 'CH01', category: 'npc_events', text, sceneRef: '001', npcIds: [], pinned: false, source: 'auto' };
}

function register(entries: DivergenceEntry[]): DivergenceRegister {
    return { entries, chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 };
}

let fetchMock: ReturnType<typeof vi.fn>;

/** Every PUT the store made, as `{ url, body }`. */
function puts(): { url: string; body: unknown }[] {
    return fetchMock.mock.calls
        .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
        .map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));
}

beforeEach(() => {
    vi.useFakeTimers();
    fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }));
    vi.stubGlobal('fetch', fetchMock);
    cancelPendingSaves();
    useAppStore.setState({
        activeCampaignId: 'camp-a',
        divergenceRegister: register([entry('f1'), entry('f2')]),
    } as Partial<AppState>);
    fetchMock.mockClear();
});

afterEach(() => {
    cancelPendingSaves();
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('established facts persistence', () => {
    it('saves an edit to the register route, not the campaign-state route', async () => {
        useAppStore.getState().editDivergenceFact('f1', 'The bridge burned.');
        expect(puts()).toEqual([]);                 // debounced

        await vi.advanceTimersByTimeAsync(1000);

        const sent = puts();
        expect(sent.map(p => p.url)).toEqual([expect.stringMatching(/\/campaigns\/camp-a\/divergence$/)]);
        const saved = sent[0].body as DivergenceRegister;
        expect(saved.entries.find(e => e.id === 'f1')?.text).toBe('The bridge burned.');
    });

    it('coalesces rapid edits into one save of the latest register', async () => {
        const s = useAppStore.getState();
        s.editDivergenceFact('f1', 'first');
        s.pinDivergenceFact('f2');
        s.editDivergenceFact('f1', 'second');

        await vi.advanceTimersByTimeAsync(1000);

        const sent = puts();
        expect(sent).toHaveLength(1);
        const saved = sent[0].body as DivergenceRegister;
        expect(saved.entries.find(e => e.id === 'f1')?.text).toBe('second');
        expect(saved.entries.find(e => e.id === 'f2')?.pinned).toBe(true);
    });

    it('covers every kind of edit, including delete and reset', async () => {
        const s = useAppStore.getState();
        for (const act of [
            () => s.toggleDivergenceChapter('CH01', false),
            () => s.toggleDivergenceFact('f1'),
            () => s.dismissDivergenceReviewFlag('f1'),
            () => s.deleteDivergenceFact('f2'),
            () => s.addDivergenceEntry(entry('f3')),
            () => s.resetDivergenceRegister(),
        ]) {
            fetchMock.mockClear();
            act();
            await vi.advanceTimersByTimeAsync(1000);
            expect(puts().map(p => p.url)).toEqual([expect.stringMatching(/\/divergence$/)]);
        }
    });

    it('is flushed immediately by flushAllPendingSaves, even after Exit', async () => {
        useAppStore.getState().editDivergenceFact('f1', 'flushed');
        // Exit clears the active campaign; the pending save still belongs to camp-a.
        useAppStore.setState({ activeCampaignId: null } as Partial<AppState>);

        await flushAllPendingSaves();

        const sent = puts();
        expect(sent.map(p => p.url)).toEqual([expect.stringMatching(/\/campaigns\/camp-a\/divergence$/)]);
        await vi.advanceTimersByTimeAsync(2000);
        expect(puts()).toHaveLength(1);             // not sent a second time
    });

    it('keeps one pending save per campaign', async () => {
        useAppStore.getState().editDivergenceFact('f1', 'from A');
        useAppStore.setState({ activeCampaignId: 'camp-b', divergenceRegister: register([entry('g1')]) } as Partial<AppState>);
        useAppStore.getState().editDivergenceFact('g1', 'from B');

        await vi.advanceTimersByTimeAsync(1000);

        const urls = puts().map(p => p.url).sort();
        expect(urls).toEqual([
            expect.stringMatching(/\/campaigns\/camp-a\/divergence$/),
            expect.stringMatching(/\/campaigns\/camp-b\/divergence$/),
        ]);
    });

    it('is dropped by cancelPendingSaves (a backup restore replaces the files)', async () => {
        useAppStore.getState().editDivergenceFact('f1', 'discarded');
        cancelPendingSaves();
        await vi.advanceTimersByTimeAsync(2000);
        expect(puts()).toEqual([]);
    });

    it('still saves campaign state when message fact links change', async () => {
        useAppStore.setState({ messages: [{ id: 'm1', role: 'assistant', content: 'x', timestamp: 0 }] } as Partial<AppState>);
        useAppStore.getState().updateMessageDivergence('m1', ['f1']);
        await vi.advanceTimersByTimeAsync(1000);
        expect(puts().map(p => p.url)).toEqual([expect.stringMatching(/\/campaigns\/camp-a\/state$/)]);
    });
});
