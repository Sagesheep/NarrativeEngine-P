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

    it('Phase 4.0: a subscriber and a fresh read agree on location (precedence aligned, API.md §8.6 item 7)', async () => {
        // The snapshot path (`modContext.ts:457-460`) prefers the injected
        // `locationState` over `context`. The reactive path
        // (`hostFacade.ts:354-361`) used to prefer `context` over the
        // injected state, so a subscriber and a fresh read disagreed. Phase
        // 4.0 aligned them: both prefer the injected state.
        //
        // This test sets up a campaign where `getFreshLocationState()`
        // returns a DIFFERENT `currentPlaceId` than `context.currentPlaceId`,
        // then verifies that `ctx.data.location` (the snapshot read) and a
        // `ctx.subscribe('location', …)` notification agree.
        const store = makeStore({
            activeCampaignId: 'campaign-a',
            messages: [],
            npcLedger: [],
            modTables: {},
            context: {
                currentPlaceId: 'context-place',
                currentFeature: 'context-feature',
                playerCharacter: null,
                characterProfileData: { name: 'Hero' },
                inventoryItems: [],
            } as unknown as TurnState['context'],
            locationLedger: [{ id: 'store-place', name: 'Store Place', broadLocation: 'Region', features: ['feature'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' }],
        });
        const state = makeState();
        // The injected state wins over context. The two must agree.
        const getFreshLocationState = () => ({
            activeCampaignId: 'campaign-a',
            locationLedger: [{ id: 'injected-place', name: 'Injected Place', broadLocation: 'Region', features: ['feature'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' as const }],
            context: { currentPlaceId: 'injected-place', currentFeature: 'injected-feature' } as TurnState['context'],
        });
        const callbacks = { ...makeCallbacks(), getFreshLocationState };
        // `HostFacadeBuildOptions.getLocationState` returns the shape the
        // reactive path reads (`{currentPlaceId, currentFeature, ledger}`),
        // not the `TurnCallbacks.getFreshLocationState` shape. Bridge here.
        const getLocationState = () => {
            const fresh = getFreshLocationState();
            return {
                currentPlaceId: fresh.context.currentPlaceId ?? null,
                currentFeature: fresh.context.currentFeature ?? null,
                ledger: fresh.locationLedger,
            };
        };
        const facade = buildHostFacade(state, callbacks, {
            reactiveStore: store,
            getLocationState,
        });
        const ctx = buildModContext({
            mod: { id: 'location-mod', name: 'Location Mod', version: '1.0.0' },
            facade,
            locationState: {
                currentPlaceId: 'injected-place',
                currentFeature: 'injected-feature',
                ledger: [{ id: 'injected-place', name: 'Injected Place', broadLocation: 'Region', features: ['feature'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' }],
            },
        });

        // The snapshot read prefers the injected state.
        expect(ctx.data.location.currentPlaceId).toBe('injected-place');
        expect(ctx.data.location.currentFeature).toBe('injected-feature');
        expect(ctx.data.location.ledger[0]).toMatchObject({ id: 'injected-place' });

        // The subscriber sees the same value the snapshot read returns.
        const values: unknown[] = [];
        ctx.subscribe('location', (value) => values.push(value));
        // Trigger an invalidation by setting locationLedger on the store.
        store.set({ locationLedger: [{ id: 'injected-place', name: 'Injected Place', broadLocation: 'Region', features: ['feature'], firstSeenScene: '001', lastSeenScene: '001', source: 'llm' }] });
        await tick();

        // The subscriber fired at least once (the initial value), and
        // every value the subscriber saw AGREES with the snapshot read.
        expect(values.length).toBeGreaterThanOrEqual(1);
        for (const value of values) {
            const loc = value as { currentPlaceId: string | null; currentFeature: string | null; ledger: { id: string }[] };
            expect(loc.currentPlaceId).toBe('injected-place');
            expect(loc.currentFeature).toBe('injected-feature');
            expect(loc.ledger[0]).toMatchObject({ id: 'injected-place' });
        }

        disposeModSubscriptions('location-mod');
    });
});