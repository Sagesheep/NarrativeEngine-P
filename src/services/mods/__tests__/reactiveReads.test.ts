import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildHostFacade } from '../../turn/hostFacade';
import type { TurnCallbacks, TurnState } from '../../../types';
import { buildModContext } from '../modContext';
import {
    disposeAllModSubscriptions,
    disposeModSubscriptions,
    getTrackedModSubscriptionCount,
    type ReactiveStoreLike,
} from '../reactiveReads';
import { reactiveFaultStore } from '../reactiveFaults';

const makeState = (): TurnState => ({
    input: 'input',
    displayInput: 'input',
    settings: { contextLimit: 4096 } as TurnState['settings'],
    context: {
        currentPlaceId: 'place-a',
        currentFeature: null,
        playerCharacter: null,
        characterProfileData: { name: 'Hero' },
        inventoryItems: [],
    } as unknown as TurnState['context'],
    messages: [{ id: 'm1', role: 'user', content: 'hello' }],
    condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
    loreChunks: [],
    npcLedger: [{ id: 'n1', name: 'Nadia' }],
    enemyCompendium: [],
    enemyCombatConfig: undefined,
    archiveIndex: [],
    activeCampaignId: 'campaign-a',
    provider: undefined,
    getMessages: () => [],
    onStageNpcIds: [],
    timeline: [],
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    setChapters: vi.fn(),
    incrementBookkeepingTurnCounter: vi.fn(() => 1),
    resetBookkeepingTurnCounter: vi.fn(),
    autoBookkeepingInterval: 5,
    divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    semanticFacts: [],
} as unknown as TurnState);

const makeCallbacks = (): TurnCallbacks => ({
    onCheckingNotes: vi.fn(),
    addMessage: vi.fn(),
    updateLastAssistant: vi.fn(),
    updateLastMessage: vi.fn(),
    updateLastAssistantMessage: vi.fn(),
    updateContext: vi.fn(),
    getFreshLocationState: vi.fn(() => ({
        activeCampaignId: 'campaign-a',
        locationLedger: [],
        context: {} as TurnState['context'],
    })),
    setCharacterProfileData: vi.fn(),
    setInventoryItems: vi.fn(),
    setLocationLedger: vi.fn(),
    addLocationSuggestions: vi.fn(),
    setArchiveIndex: vi.fn(),
    updateNPC: vi.fn(),
    addNPC: vi.fn(),
    setCondensed: vi.fn(),
    setStreaming: vi.fn(),
    archiveNPC: vi.fn(),
    restoreNPC: vi.fn(),
});

type FakeState = Record<string, unknown> & {
    activeCampaignId: string | null;
    messages: unknown[];
    npcLedger: unknown[];
    modTables: Record<string, unknown>;
};

function makeStore(initial: FakeState): ReactiveStoreLike & {
    set(patch: Partial<FakeState>): void;
};
function makeStore(initial: FakeState) {
    const listeners = new Set<() => void>();
    let state = initial;
    const set = (patch: Partial<FakeState>): void => {
        state = { ...state, ...patch };
        for (const listener of [...listeners]) listener();
    };
    const setModTable = (name: string, data: unknown): void => {
        set({ modTables: { ...state.modTables, [name]: data } });
    };
    state = { ...state, setModTable };
    return {
        getState: () => state,
        subscribe(listener: () => void) {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        set,
    };
}


async function tick(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function makeContext(store: ReturnType<typeof makeStore>, modId = 'reactive-mod') {
    const state = makeState();
    const facade = buildHostFacade(state, makeCallbacks(), { reactiveStore: store });
    return buildModContext({
        mod: { id: modId, name: 'Reactive Mod', version: '1.0.0' },
        facade,
    });
}

afterEach(() => {
    disposeAllModSubscriptions();
    reactiveFaultStore.clear();
});

describe('Phase 2.4 reactive reads', () => {
    it('coalesces host changes, only emits changed frozen snapshots, and tracks teardown', async () => {
        const store = makeStore({
            activeCampaignId: 'campaign-a',
            messages: [{ id: 'm1', content: 'one' }],
            npcLedger: [{ id: 'n1', name: 'Nadia' }],
            modTables: {},
        });
        const ctx = makeContext(store);
        const values: unknown[] = [];
        const unsubscribe = ctx.subscribe('npcLedger', (value) => values.push(value));

        store.set({ npcLedger: [{ id: 'n1', name: 'Nadia' }, { id: 'n2', name: 'Rin' }] });
        store.set({ npcLedger: [{ id: 'n1', name: 'Nadia' }, { id: 'n2', name: 'Rin' }] });
        await tick();

        expect(values).toHaveLength(1);
        expect(values[0]).toEqual([{ id: 'n1', name: 'Nadia' }, { id: 'n2', name: 'Rin' }]);
        expect(Object.isFrozen(values[0])).toBe(true);
        expect(Object.isFrozen((values[0] as unknown[])[0])).toBe(true);
        expect(getTrackedModSubscriptionCount('reactive-mod')).toBe(1);

        unsubscribe();
        expect(getTrackedModSubscriptionCount('reactive-mod')).toBe(0);
    });

    it('observes own table writes made through the context during a turn', async () => {
        const store = makeStore({ activeCampaignId: 'campaign-a', messages: [], npcLedger: [], modTables: {} });
        const ctx = makeContext(store, 'arc');
        const values: unknown[] = [];
        ctx.table.subscribe('arcs', (rows) => values.push(rows));

        await ctx.table.write('arcs', [{ id: 'arc-1', title: 'Arrival' }]);
        await tick();

        expect(values).toEqual([[{ id: 'arc-1', title: 'Arrival' }]]);
        expect(Object.isFrozen(values[0])).toBe(true);
    });

    it('campaign changes tear down subscriptions before stale values can arrive', async () => {
        const store = makeStore({ activeCampaignId: 'campaign-a', messages: [], npcLedger: [], modTables: {} });
        const ctx = makeContext(store);
        const listener = vi.fn();
        ctx.subscribe('messages', listener);

        store.set({ activeCampaignId: 'campaign-b', messages: [{ id: 'new', content: 'new campaign' }] });
        await tick();

        expect(listener).not.toHaveBeenCalled();
        expect(getTrackedModSubscriptionCount('reactive-mod')).toBe(0);
        store.set({ messages: [{ id: 'later', content: 'still new campaign' }] });
        await tick();
        expect(listener).not.toHaveBeenCalled();
    });

    it('contains throwing subscribers, records a named fault, and keeps other listeners alive', async () => {
        const store = makeStore({ activeCampaignId: 'campaign-a', messages: [], npcLedger: [], modTables: {} });
        const ctx = makeContext(store);
        const received = vi.fn();
        ctx.subscribe('messages', () => { throw new Error('boom'); });
        ctx.subscribe('messages', received);

        store.set({ messages: [{ id: 'm2', content: 'next' }] });
        await tick();

        expect(received).toHaveBeenCalledTimes(1);
        expect(reactiveFaultStore.getRecords()).toEqual([
            expect.objectContaining({
                modId: 'reactive-mod',
                key: 'messages',
                kind: 'threw',
                reason: 'Reactive Mod: subscription "messages" threw (boom)',
            }),
        ]);
    });

    it('host-enforced mod disposal prevents callbacks after disable', async () => {
        const store = makeStore({ activeCampaignId: 'campaign-a', messages: [], npcLedger: [], modTables: {} });
        const ctx = makeContext(store, 'disabled-mod');
        const listener = vi.fn();
        ctx.subscribe('messages', listener);
        disposeModSubscriptions('disabled-mod');

        store.set({ messages: [{ id: 'm2', content: 'ignored' }] });
        await tick();
        expect(listener).not.toHaveBeenCalled();
        expect(getTrackedModSubscriptionCount('disabled-mod')).toBe(0);
    });
});