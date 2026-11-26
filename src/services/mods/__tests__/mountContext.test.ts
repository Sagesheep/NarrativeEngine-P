/**
 * Phase 4.2 — `ctx.mounts` integration tests.
 *
 * Proves:
 *   • `buildModContext` exposes `ctx.mounts` with the six named methods.
 *   • A mod's `activate` can register a header entry through `ctx.mounts.header`.
 *   • The registered entry sorts between the leading built-ins and the
 *     trailing group (the registry's ordering rule, MOUNTS.md §3.3).
 *   • The sandbox binding throws "native-tier only" for `ctx.mounts`
 *     (mirrors `subscribe`/`events`).
 *   • The lifecycle host's `disable` removes the mod's mounts (host-owned
 *     teardown, §8.5) and `enable` clears the revoked lease.
 */

import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { buildHostFacade } from '../../turn/hostFacade';
import { buildModContext, type ModContext } from '../modContext';
import { createLifecycleHost } from '../lifecycle/lifecycleHost';
import { createLifecycleFaultStore } from '../lifecycle/lifecycleFaults';
import {
    readRegion,
    resetMountRegistryForTests,
    getModEntryCount,
    isModMountsRevoked,
    readRailPanels,
    readMessageBelowSlots,
} from '../mounts/mountRegistry';
import { mountFaultStore } from '../mounts/mountFaults';
import { emitCoreEvent, modEventBus } from '../events';
import { registerHeaderBuiltins } from '../mounts/headerBuiltins';
import { registerComposerBuiltins } from '../mounts/composerBuiltins';
import { readWindowState } from '../mounts/windowStore';
import { buildWorkerSource } from '../sandbox/workerPrelude';
import type { AppSettings } from '../../../types';
import type { TurnCallbacks, TurnState } from '../../turn/turnOrchestrator';

const makeState = (): TurnState => ({
    input: 'hello',
    displayInput: 'hello',
    settings: { aiTier: 'max' } as unknown as AppSettings,
    context: {} as TurnState['context'],
    messages: [],
    condenser: { condensedUpToIndex: 0 } as TurnState['condenser'],
    loreChunks: [],
    npcLedger: [],
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
});

const makeCallbacks = (): TurnCallbacks => ({
    onCheckingNotes: vi.fn(),
    addMessage: vi.fn(),
    updateLastAssistant: vi.fn(),
    updateLastMessage: vi.fn(),
    updateLastAssistantMessage: vi.fn(),
    updateContext: vi.fn(),
    getFreshLocationState: vi.fn(() => ({
        activeCampaignId: 'campaign-1',
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

beforeEach(() => {
    resetMountRegistryForTests();
});

describe('Phase 4.2 — ctx.mounts surface', () => {
    it('buildModContext exposes ctx.mounts with six named methods', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx: ModContext = buildModContext({
            mod: { id: 'test-mod', name: 'Test', version: '1.0.0' },
            facade,
        });
        expect(typeof ctx.mounts).toBe('object');
        expect(typeof ctx.mounts.header).toBe('function');
        expect(typeof ctx.mounts.composer).toBe('function');
        expect(typeof ctx.mounts.messageAction).toBe('function');
        expect(typeof ctx.mounts.rail).toBe('function');
        expect(typeof ctx.mounts.messageBelow).toBe('function');
        expect(typeof ctx.mounts.window).toBe('function');
    });

    it('a mod registers a header entry through ctx.mounts.header', () => {
        registerHeaderBuiltins();
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'fixture-mod', name: 'Fixture', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        const handle = ctx.mounts.header({
            id: 'injectArc',
            icon: 'Syringe',
            label: 'Inject Arc',
            onSelect: () => undefined,
        });
        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(1);
        expect(handle.update).toBeInstanceOf(Function);
        expect(handle.remove).toBeInstanceOf(Function);
        // The qualified id is mod.fixture-mod.injectArc.
        const ids = readRegion('header.actions').map((e) => e.qualifiedId);
        expect(ids).toContain('mod.fixture-mod.injectArc');
    });

    it('the registered entry sorts between leading built-ins and the trailing group', () => {
        registerHeaderBuiltins();
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'fixture-mod', name: 'Fixture', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        ctx.mounts.header({
            id: 'injectArc',
            icon: 'Syringe',
            label: 'Inject Arc',
            onSelect: () => undefined,
        });
        const ids = readRegion('header.actions').map((e) => e.qualifiedId);
        const modIdx = ids.indexOf('mod.fixture-mod.injectArc');
        const lastLeading = ids.indexOf('pinned'); // last leading built-in
        const settingsIdx = ids.indexOf('settings'); // first trailing built-in
        expect(modIdx).toBeGreaterThan(lastLeading);
        expect(modIdx).toBeLessThan(settingsIdx);
    });

    it('registers a rail panel with the same live context handed to activate', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'rail-fixture', name: 'Rail Fixture', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        const handle = ctx.mounts.rail({ id: 'status', title: 'Status', mount: () => undefined });
        const rail = readRailPanels();
        expect(rail).toHaveLength(1);
        expect(rail[0].qualifiedId).toBe('mod.rail-fixture.status');
        expect(rail[0].context).toBe(ctx);
        expect(() => handle.update()).not.toThrow();
    });

    it('Phase 4.4 — registers a message.actions chrome entry through ctx.mounts.messageAction', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'msg-fixture', name: 'Msg Fixture', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        const handle = ctx.mounts.messageAction({
            id: 'tag',
            icon: 'Tag',
            label: 'Tag',
            onSelect: () => undefined,
        });
        expect(getModEntryCount('message.actions', 'msg-fixture')).toBe(1);
        const ids = readRegion('message.actions').map((e) => e.qualifiedId);
        expect(ids).toContain('mod.msg-fixture.tag');
        expect(typeof handle.update).toBe('function');
        expect(typeof handle.remove).toBe('function');
        handle.remove();
        expect(getModEntryCount('message.actions', 'msg-fixture')).toBe(0);
    });

    it('Phase 4.4 — registers a message.below content slot through ctx.mounts.messageBelow with the live context', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'below-fixture', name: 'Below Fixture', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        const handle = ctx.mounts.messageBelow({
            id: 'annotation',
            mount: () => undefined,
        });
        const slots = readMessageBelowSlots();
        expect(slots).toHaveLength(1);
        expect(slots[0].qualifiedId).toBe('mod.below-fixture.annotation');
        // The live ModContext is handed to the slot's `mount` at render time
        // — same discipline as the rail panel (the context is captured
        // lazily, so it is the real post-`contextRef.current` context, not
        // the undefined value at API build time).
        expect(slots[0].context).toBe(ctx);
        expect(() => handle.update()).not.toThrow();
        handle.remove();
        expect(readMessageBelowSlots()).toHaveLength(0);
    });

    it('ctx.mounts.window returns a WindowHandle that opens / closes / focuses a real window (Phase 4.5)', () => {
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'test-mod', name: 'Test', version: '1.0.0' },
            facade,
        });
        const handle = ctx.mounts.window({
            id: 'editor',
            title: 'Editor',
            defaultSize: { width: 600, height: 400 },
            mount: () => undefined,
        });
        // 4.5 returns a real WindowHandle with open/close/focus that drive
        // the host-owned window manager. The handle is no longer a no-op.
        expect(typeof handle.open).toBe('function');
        expect(typeof handle.close).toBe('function');
        expect(typeof handle.focus).toBe('function');
        // Opening the window puts it in the open map; closing removes it.
        handle.open();
        const openAfter = readWindowState().open;
        expect(openAfter.has('mod.test-mod.editor')).toBe(true);
        handle.close();
        expect(readWindowState().open.has('mod.test-mod.editor')).toBe(false);
        // No fault is recorded — the region is implemented in 4.5.
        mountFaultStore.clear();
        handle.open();
        expect(mountFaultStore.getRecords().some((f) => f.region === 'window.layer')).toBe(false);
        handle.close();
    });
});

describe('Phase 4.2 — ctx.mounts: budget enforcement through the API', () => {
    it('exceeding the per-mod budget of 2 in header returns a no-op handle + fault', () => {
        registerHeaderBuiltins();
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'greedy-mod', name: 'Greedy', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        ctx.mounts.header({ id: 'a', icon: 'Swords', label: 'A', onSelect: () => undefined });
        ctx.mounts.header({ id: 'b', icon: 'Swords', label: 'B', onSelect: () => undefined });
        mountFaultStore.clear();
        const handle = ctx.mounts.header({ id: 'c', icon: 'Swords', label: 'C', onSelect: () => undefined });
        expect(getModEntryCount('header.actions', 'greedy-mod')).toBe(2);
        handle.remove(); // no-op
        expect(getModEntryCount('header.actions', 'greedy-mod')).toBe(2);
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'budget')).toBe(true);
    });
});

describe('Phase 4.2 — ctx.mounts: duplicate id through the API', () => {
    it('registering the same entry id twice in header faults on the second', () => {
        registerHeaderBuiltins();
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctx = buildModContext({
            mod: { id: 'dup-mod', name: 'Dup', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });
        ctx.mounts.header({ id: 'dup', icon: 'Swords', label: 'First', onSelect: () => undefined });
        mountFaultStore.clear();
        ctx.mounts.header({ id: 'dup', icon: 'Swords', label: 'Second', onSelect: () => undefined });
        const faults = mountFaultStore.getRecords();
        expect(faults.some((f) => f.kind === 'duplicate')).toBe(true);
    });
});

describe('Phase 4.2 — host-owned teardown through the lifecycle host', () => {
    it('disable removes the mod\'s mounts; enable clears the revoked lease', async () => {
        registerHeaderBuiltins();
        registerComposerBuiltins();
        // A fixture mod whose `activate` registers a header entry.
        const fixtureHooks = {
            activate: (ctx: ModContext | undefined) => {
                if (!ctx?.mounts) return;
                ctx.mounts.header({
                    id: 'fixture',
                    icon: 'Swords',
                    label: 'Fixture',
                    onSelect: () => undefined,
                });
            },
            disable: () => undefined,
        };
        const loadHooks = () => Promise.resolve(fixtureHooks);
        const faultStore = createLifecycleFaultStore();
        const host = createLifecycleHost({
            loadHooks,
            stateStore: { get: async () => undefined, set: async () => undefined, clear: async () => undefined },
            faultStore,
        });

        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctxFactory = () => buildModContext({
            mod: { id: 'fixture-mod', name: 'Fixture', version: '1.0.0' },
            facade,
            loadIndex: 0,
        });

        // Enable → activate → registers a header entry.
        await host.enable({
            mod: {
                id: 'fixture-mod', name: 'Fixture', version: '1.0.0', file: 'fixture',
                dependencies: {}, folder: 'fixture',
            },
            ctxForMod: ctxFactory as never,
        });
        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(1);

        // Disable → host removes the entry.
        await host.disable({
            mod: {
                id: 'fixture-mod', name: 'Fixture', version: '1.0.0', file: 'fixture',
                dependencies: {}, folder: 'fixture',
            },
            ctxForMod: ctxFactory as never,
        });
        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(0);
        expect(isModMountsRevoked('fixture-mod')).toBe(true);

        // Re-enable → lease cleared, can register again.
        await host.enable({
            mod: {
                id: 'fixture-mod', name: 'Fixture', version: '1.0.0', file: 'fixture',
                dependencies: {}, folder: 'fixture',
            },
            ctxForMod: ctxFactory as never,
        });
        expect(isModMountsRevoked('fixture-mod')).toBe(false);
        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(1);
    });
});

// Opening Settings → Extensions, pressing Rescan and changing the load order
// all run the load cycle again. It used to fire `activate` again for every mod
// already running: the mount registry rejected the second registration as a
// duplicate and handed back a no-op handle, which the Arc Engine kept, so its
// Inject Arc button stopped repainting; and every `events.on` listener doubled.
describe('a refresh does not re-activate a running mod', () => {
    const fixtureMod = {
        id: 'fixture-mod', name: 'Fixture', version: '1.0.0', file: 'fixture',
        dependencies: {}, folder: 'fixture', native: { js: 'index.js' },
    };
    const otherMod = { ...fixtureMod, id: 'other-mod', name: 'Other', file: 'other', folder: 'other' };

    function setup() {
        registerHeaderBuiltins();
        mountFaultStore.clear();
        const activations = { count: 0 };
        const turnsSeen = { count: 0 };
        const fixtureHooks = {
            activate: (ctx: ModContext | undefined) => {
                if (!ctx?.mounts) return;
                activations.count += 1;
                ctx.mounts.header({ id: 'fixture', icon: 'Swords', label: 'Fixture', onSelect: () => undefined });
                ctx.events.on('turn.committed', () => { turnsSeen.count += 1; });
            },
        };
        const loadHooks = (mod: { id: string }) => Promise.resolve(mod.id === fixtureMod.id ? fixtureHooks : {});
        const host = createLifecycleHost({
            loadHooks,
            stateStore: { get: async () => undefined, set: async () => undefined, clear: async () => undefined },
            faultStore: createLifecycleFaultStore(),
        });
        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctxForMod = ((mod: { id: string; name: string; version: string; loadIndex: number }) =>
            buildModContext({ mod, facade, loadIndex: mod.loadIndex })) as never;
        const emitTurn = () => emitCoreEvent('turn.committed', { turnId: null, campaignId: 'campaign-1', messageId: 'm', sceneId: '001' });
        return { host, ctxForMod, activations, turnsSeen, emitTurn };
    }

    afterEach(() => { modEventBus.reset(); });

    it('keeps the running mod as it is when nothing changed', async () => {
        const { host, ctxForMod, activations, turnsSeen, emitTurn } = setup();
        const cycle = () => host.runLoadCycle({ mods: [fixtureMod, otherMod], enablement: {}, ctxForMod });

        await cycle();
        await cycle();
        await cycle();

        expect(activations.count).toBe(1);
        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(1);
        expect(mountFaultStore.getRecords()).toEqual([]);
        emitTurn();
        expect(turnsSeen.count).toBe(1);
    });

    it('replays from a clean slate when the load order changes, with no duplicates', async () => {
        const { host, ctxForMod, activations, turnsSeen, emitTurn } = setup();

        await host.runLoadCycle({ mods: [fixtureMod, otherMod], enablement: {}, ctxForMod });
        await host.runLoadCycle({ mods: [otherMod, fixtureMod], enablement: {}, ctxForMod });

        expect(activations.count).toBe(2);
        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(1);
        expect(mountFaultStore.getRecords()).toEqual([]);
        emitTurn();
        expect(turnsSeen.count).toBe(1);
    });

    it('tears down a mod that is no longer enabled', async () => {
        const { host, ctxForMod, turnsSeen, emitTurn } = setup();

        await host.runLoadCycle({ mods: [fixtureMod], enablement: {}, ctxForMod });
        await host.runLoadCycle({ mods: [fixtureMod], enablement: { 'mod.fixture-mod': false }, ctxForMod });

        expect(getModEntryCount('header.actions', 'fixture-mod')).toBe(0);
        emitTurn();
        expect(turnsSeen.count).toBe(0);
    });

    it('does not re-activate a mod the user just enabled', async () => {
        const { host, ctxForMod, activations } = setup();

        await host.runLoadCycle({ mods: [fixtureMod], enablement: { 'mod.fixture-mod': false }, ctxForMod });
        await host.enable({ mod: { ...fixtureMod, loadIndex: 0 }, ctxForMod });
        await host.runLoadCycle({ mods: [fixtureMod], enablement: {}, ctxForMod });

        expect(activations.count).toBe(1);
        expect(mountFaultStore.getRecords()).toEqual([]);
    });
});

describe('Phase 4.2 — sandbox binding (ctx.mounts throws native-tier only)', () => {
    it('the worker prelude stubs ctx.mounts methods to throw native-tier only', () => {
        const source = buildWorkerSource('export default async function(ctx){}');
        expect(source).toContain('ctx.mounts.header');
        expect(source).toContain('ctx.mounts.composer');
        expect(source).toContain('ctx.mounts.window');
        expect(source).toContain('native-tier only');
    });
});