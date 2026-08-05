/**
 * Phase 3.3 — `ctx.events` tests.
 *
 * Proves the done-when criteria from Phase 3.3 work order:
 *
 *   1. A fixture mod subscribes to three core events, emits one custom event, and a second
 *      fixture mod receives it.
 *   2. Disabling either mod removes its subscriptions with no `off` call in the mod's own code.
 *   3. An attempt to emit a core event name is rejected with a reason.
 *   4. `.d.ts` gives completion on event names (verified by type checking narrative-mod-api.d.ts).
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { buildHostFacade } from '../../turn/hostFacade';
import { buildModContext } from '../modContext';
import { modEventBus, ModEventNameRejected } from '../events';
import { createLifecycleHost, noNativeHooks } from '../lifecycle/lifecycleHost';
import type { AppSettings, TurnCallbacks, TurnState } from '../../../types';

const makeState = (): TurnState => ({
    input: 'hello',
    displayInput: 'hello',
    settings: { aiTier: 'max' } as unknown as AppSettings,
    context: {} as TurnState['context'],
    messages: [],
    condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
    loreChunks: [],
    npcLedger: [],
    enemyCompendium: [],
    enemyCombatConfig: {} as TurnState['enemyCombatConfig'],
    archiveIndex: [],
    activeCampaignId: 'campaign-1',
    provider: { endpoint: 'http://test', apiKey: 'k', modelName: 'm' },
    getMessages: () => [],
    getFreshProvider: () => ({ endpoint: 'http://test', apiKey: 'k', modelName: 'm' }),
    getUtilityEndpoint: () => ({ endpoint: 'http://test', apiKey: 'k', modelName: 'm' }),
    getFreshAuxiliaryProvider: () => ({ endpoint: 'http://test', apiKey: 'k', modelName: 'm' }),
    getRawAuxiliaryProvider: () => ({ endpoint: 'http://test', apiKey: 'k', modelName: 'm' }),
    getRawSummariserProvider: () => ({ endpoint: 'http://test', apiKey: 'k', modelName: 'm' }),
    onStageNpcIds: [],
    timeline: [],
    chapters: [],
    pinnedChapterIds: [],
    clearPinnedChapters: vi.fn(),
    setChapters: vi.fn(),
    incrementBookkeepingTurnCounter: vi.fn(() => 1),
    resetBookkeepingTurnCounter: vi.fn(),
    autoBookkeepingInterval: 5,
    getFreshContext: () => ({} as TurnState['context']),
    divergenceRegister: { entries: [], chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 },
    semanticFacts: [],
});

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

describe('Phase 3.3 — ctx.events', () => {
    beforeEach(() => {
        modEventBus.reset();
    });

    describe('surface shape & basic functionality', () => {
        it('exposes on, off, once, emit on ctx.events', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());
            const ctx = buildModContext({
                mod: { id: 'test-mod', name: 'Test Mod', version: '1.0.0' },
                facade,
            });

            expect(typeof ctx.events.on).toBe('function');
            expect(typeof ctx.events.off).toBe('function');
            expect(typeof ctx.events.once).toBe('function');
            expect(typeof ctx.events.emit).toBe('function');
        });

        it('subscribes and receives core events', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());
            const ctx = buildModContext({
                mod: { id: 'test-mod', name: 'Test Mod', version: '1.0.0' },
                facade,
            });

            const received: unknown[] = [];
            ctx.events.on('turn.start', (payload) => {
                received.push(payload);
            });

            modEventBus.emit('turn.start', {
                turnId: 't1',
                campaignId: 'c1',
                playerInput: 'attack',
                tier: 'max',
            });

            expect(received).toHaveLength(1);
            expect(received[0]).toEqual({
                turnId: 't1',
                campaignId: 'c1',
                playerInput: 'attack',
                tier: 'max',
            });
        });

        it('supports once subscription for single invocation', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());
            const ctx = buildModContext({
                mod: { id: 'test-mod', name: 'Test Mod', version: '1.0.0' },
                facade,
            });

            const received: unknown[] = [];
            ctx.events.once('turn.start', (payload) => {
                received.push(payload);
            });

            modEventBus.emit('turn.start', { turnId: 't1', campaignId: 'c1', playerInput: 'a', tier: 'max' });
            modEventBus.emit('turn.start', { turnId: 't2', campaignId: 'c1', playerInput: 'b', tier: 'max' });

            expect(received).toHaveLength(1);
        });

        it('allows unsubscribing a once listener manually via off', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());
            const ctx = buildModContext({
                mod: { id: 'test-mod', name: 'Test Mod', version: '1.0.0' },
                facade,
            });

            const listener = vi.fn();
            ctx.events.once('turn.start', listener);
            ctx.events.off('turn.start', listener);

            modEventBus.emit('turn.start', { turnId: 't1', campaignId: 'c1', playerInput: 'a', tier: 'max' });
            expect(listener).not.toHaveBeenCalled();
        });
    });

    describe('inter-mod communication (Done-when 1)', () => {
        it('fixture Mod A subscribes to 3 core events, emits custom event, Mod B receives it', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());

            const ctxA = buildModContext({
                mod: { id: 'modA', name: 'Mod A', version: '1.0.0' },
                facade,
            });

            const ctxB = buildModContext({
                mod: { id: 'modB', name: 'Mod B', version: '1.0.0' },
                facade,
            });

            const modAEventsReceived: string[] = [];
            ctxA.events.on('turn.start', () => modAEventsReceived.push('turn.start'));
            ctxA.events.on('campaign.opened', () => modAEventsReceived.push('campaign.opened'));
            ctxA.events.on('app.ready', () => modAEventsReceived.push('app.ready'));

            const modBEventsReceived: unknown[] = [];
            ctxB.events.on('mod.modA.ping', (payload) => {
                modBEventsReceived.push(payload);
            });

            // Emit core events
            modEventBus.emit('turn.start', { turnId: 't1', campaignId: 'c1', playerInput: 'go', tier: 'max' });
            modEventBus.emit('campaign.opened', { campaignId: 'c1' });
            modEventBus.emit('app.ready', { modIds: ['modA', 'modB'], faultCount: 0 });

            expect(modAEventsReceived).toEqual(['turn.start', 'campaign.opened', 'app.ready']);

            // Mod A emits custom event
            ctxA.events.emit('ping', { message: 'hello from A' });

            expect(modBEventsReceived).toHaveLength(1);
            expect(modBEventsReceived[0]).toEqual({ message: 'hello from A' });
        });
    });

    describe('teardown on disable without explicit off (Done-when 2)', () => {
        it('disabling a mod removes all subscriptions registered by its context', async () => {
            const host = createLifecycleHost({
                loadHooks: noNativeHooks,
                stateStore: { get: async () => undefined, set: async () => {} },
            });

            const facade = buildHostFacade(makeState(), makeCallbacks());
            const modA = { id: 'modA', name: 'Mod A', version: '1.0.0', file: 'modA/manifest.json', dependencies: {} };
            const modB = { id: 'modB', name: 'Mod B', version: '1.0.0', file: 'modB/manifest.json', dependencies: {} };

            const ctxA = buildModContext({ mod: modA, facade });
            const ctxB = buildModContext({ mod: modB, facade });

            const modAReceived: string[] = [];
            ctxA.events.on('turn.start', () => modAReceived.push('turn.start'));
            ctxA.events.on('campaign.opened', () => modAReceived.push('campaign.opened'));
            ctxA.events.on('app.ready', () => modAReceived.push('app.ready'));

            const modBReceived: unknown[] = [];
            ctxB.events.on('mod.modA.ping', (payload) => modBReceived.push(payload));

            expect(modEventBus.getListenerCount()).toBe(4);

            // Disable Mod A
            await host.disable({ mod: modA, ctx: ctxA });

            // Subscriptions owned by Mod A should be removed automatically
            expect(modEventBus.getListenerCount('turn.start')).toBe(0);
            expect(modEventBus.getListenerCount('campaign.opened')).toBe(0);
            expect(modEventBus.getListenerCount('app.ready')).toBe(0);

            // Mod B's subscription remains
            expect(modEventBus.getListenerCount('mod.modA.ping')).toBe(1);

            // Disable Mod B
            await host.disable({ mod: modB, ctx: ctxB });

            expect(modEventBus.getListenerCount()).toBe(0);
        });
    });

    describe('core event impersonation check (Done-when 3)', () => {
        it('rejects attempt to emit a core event name with ModEventNameRejected', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());
            const ctx = buildModContext({
                mod: { id: 'rogue-mod', name: 'Rogue Mod', version: '1.0.0' },
                facade,
            });

            expect(() => {
                ctx.events.emit('turn.start', { turnId: '1' } as any);
            }).toThrow(ModEventNameRejected);

            expect(() => {
                ctx.events.emit('turn.start', { turnId: '1' } as any);
            }).toThrow(/Rogue Mod: cannot emit "turn\.start" — a core event name may only be emitted by the host/);
        });

        it('rejects attempt to emit under another mod namespace', () => {
            const facade = buildHostFacade(makeState(), makeCallbacks());
            const ctx = buildModContext({
                mod: { id: 'modA', name: 'Mod A', version: '1.0.0' },
                facade,
            });

            expect(() => {
                ctx.events.emit('mod.modB.hack', { data: 123 });
            }).toThrow(ModEventNameRejected);

            expect(() => {
                ctx.events.emit('mod.modB.hack', { data: 123 });
            }).toThrow(/Mod A: cannot emit "mod\.modB\.hack" — a mod may only emit under its own "mod\.modA\." prefix/);
        });
    });
});
