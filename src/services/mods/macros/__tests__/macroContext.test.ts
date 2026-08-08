/**
 * Phase 5.1 — `ctx.macros` integration tests.
 *
 * Mirrors `mountContext.test.ts` (Phase 4.2). Proves:
 *   • `buildModContext` exposes `ctx.macros` with the `register` method.
 *   • A mod's `activate` can register a macro through `ctx.macros.register`.
 *   • The registered macro is resolved by `renderTemplate` for that mod's
 *     contributions.
 *   • Shadowing a built-in slot through `ctx.macros.register` is rejected.
 *   • The lifecycle host's `disable` removes the mod's macros (host-owned
 *     teardown, §3) and `enable` clears the revoked lease.
 */
import { describe, expect, it, beforeEach, vi } from 'vitest';
import { buildHostFacade } from '../../../turn/hostFacade';
import { buildModContext, type ModContext } from '../../modContext';
import { createLifecycleHost } from '../../lifecycle/lifecycleHost';
import { createLifecycleFaultStore } from '../../lifecycle/lifecycleFaults';
import {
    clearAllModMacros,
    hasModMacro,
    isModMacrosRevoked,
    listMacros,
} from '../macroRegistry';
import { macroFaultStore } from '../macroFaults';
import { renderTemplate } from '../../modAdapter';
import type { AppSettings, TurnCallbacks, TurnState } from '../../../../types';

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
    clearAllModMacros();
});

describe('Phase 5.1 — ctx.macros surface', () => {
    it('buildModContext exposes ctx.macros with a register method', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: buildHostFacade(makeState(), makeCallbacks()),
        });
        expect(typeof ctx.macros).toBe('object');
        expect(typeof ctx.macros.register).toBe('function');
    });

    it('a mod registers a macro through ctx.macros.register and it resolves in renderTemplate', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: buildHostFacade(makeState(), makeCallbacks()),
        });
        ctx.macros.register('greeting', () => 'hello from ctx.macros');
        expect(hasModMacro('m', 'greeting')).toBe(true);
        expect(renderTemplate('{{greeting}}', undefined, 'm')).toBe('hello from ctx.macros');
    });

    it('ctx.macros.register returns an unregister function that removes the macro', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: buildHostFacade(makeState(), makeCallbacks()),
        });
        const unregister = ctx.macros.register('temp', () => 't');
        expect(hasModMacro('m', 'temp')).toBe(true);
        unregister();
        expect(hasModMacro('m', 'temp')).toBe(false);
    });

    it('shadowing a built-in slot through ctx.macros.register is rejected with a fault', () => {
        const ctx = buildModContext({
            mod: { id: 'm', name: 'M', version: '1.0.0' },
            facade: buildHostFacade(makeState(), makeCallbacks()),
        });
        ctx.macros.register('location', () => 'shadow');
        expect(hasModMacro('m', 'location')).toBe(false);
        const faults = macroFaultStore.getRecords();
        expect(faults.some((f) => f.modId === 'm' && f.kind === 'shadow' && f.name === 'location')).toBe(true);
    });
});

describe('Phase 5.1 — ctx.macros: host-owned teardown on disable', () => {
    it('lifecycle host disable removes the mod macros and revokes the lease', async () => {
        const faultStore = createLifecycleFaultStore();
        const host = createLifecycleHost({
            loadHooks: () => ({ activate: async (ctx: ModContext) => {
                // The mod registers two macros in its activate hook.
                ctx.macros.register('one', () => '1');
                ctx.macros.register('two', () => '2');
            } }),
            stateStore: {
                get: async () => undefined,
                set: async () => undefined,
                clear: async () => undefined,
            },
            faultStore,
        });

        const mod = {
            id: 'macro-mod',
            name: 'Macro Mod',
            version: '1.0.0',
            file: 'macro.mod.json',
            dependencies: {} as Record<string, string>,
        };

        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctxFactory = () => buildModContext({
            mod: { id: mod.id, name: mod.name, version: mod.version },
            facade,
        });

        // Run the load cycle (install + activate).
        await host.runLoadCycle({ mods: [mod], enablement: {}, ctxForMod: ctxFactory });
        expect(hasModMacro('macro-mod', 'one')).toBe(true);
        expect(hasModMacro('macro-mod', 'two')).toBe(true);
        expect(listMacros().length).toBe(2);

        // Disable the mod. The host removes every macro it registered.
        await host.disable({ mod, ctxForMod: ctxFactory });
        expect(hasModMacro('macro-mod', 'one')).toBe(false);
        expect(hasModMacro('macro-mod', 'two')).toBe(false);
        expect(isModMacrosRevoked('macro-mod')).toBe(true);

        // A stale closure calling register after disable is a no-op + fault.
        const staleCtx = ctxFactory();
        staleCtx.macros.register('three', () => '3');
        expect(hasModMacro('macro-mod', 'three')).toBe(false);
        const faults = macroFaultStore.getRecords();
        expect(faults.some((f) => f.modId === 'macro-mod' && f.kind === 'revoked')).toBe(true);
    });

    it('enable clears the revoked lease so the mod can register again', async () => {
        const faultStore = createLifecycleFaultStore();
        const host = createLifecycleHost({
            loadHooks: () => ({ activate: async (ctx: ModContext) => {
                ctx.macros.register('one', () => '1');
            } }),
            stateStore: {
                get: async () => undefined,
                set: async () => undefined,
                clear: async () => undefined,
            },
            faultStore,
        });

        const mod = {
            id: 'macro-mod-2',
            name: 'Macro Mod 2',
            version: '1.0.0',
            file: 'macro2.mod.json',
            dependencies: {} as Record<string, string>,
        };

        const facade = buildHostFacade(makeState(), makeCallbacks());
        const ctxFactory = () => buildModContext({
            mod: { id: mod.id, name: mod.name, version: mod.version },
            facade,
        });

        await host.runLoadCycle({ mods: [mod], enablement: {}, ctxForMod: ctxFactory });
        await host.disable({ mod, ctxForMod: ctxFactory });
        expect(isModMacrosRevoked('macro-mod-2')).toBe(true);

        // Re-enable. The host clears the revoked lease, then fires activate.
        await host.enable({ mod, ctxForMod: ctxFactory });
        expect(isModMacrosRevoked('macro-mod-2')).toBe(false);
        // activate re-ran and re-registered the macro.
        expect(hasModMacro('macro-mod-2', 'one')).toBe(true);
    });
});