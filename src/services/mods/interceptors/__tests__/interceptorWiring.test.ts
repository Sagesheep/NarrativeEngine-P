/**
 * Phase 5.2 — the wiring: `native.generateInterceptor` in a manifest becomes a
 * registered interceptor, and disabling the mod takes it away again.
 *
 * The registry tests register a function directly, which is the right unit for
 * them but leaves the interesting seam untested: nothing in them proves that a
 * manifest field ever reaches the registry. This file drives the REAL
 * `createNativeLoader` (with the `import()` seam faked, as Phase 1.5's own
 * tests do) and the REAL `createLifecycleHost`, so the path a shipped mod
 * actually takes is the path under test.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createNativeLoader } from '../../native/nativeLoader';
import { createLifecycleHost } from '../../lifecycle/lifecycleHost';
import { createLifecycleFaultStore } from '../../lifecycle/lifecycleFaults';
import type { LifecycleMod } from '../../lifecycle/lifecycleHost';
import type { LifecycleStateStore } from '../../lifecycle/lifecycleTypes';
import {
    clearAllModInterceptors,
    hasPromptInterceptors,
    listPromptInterceptors,
    runPromptInterceptors,
} from '../interceptorRegistry';
import type { PromptInterceptorInput } from '../interceptorTypes';

const apiBase = 'http://test.local/api';

const INPUT: PromptInterceptorInput = Object.freeze({
    turnId: 'turn_1',
    campaignId: 'campaign-1',
    tier: 'pro',
    playerInput: 'I listen.',
    hasDirectorBrief: false,
    hasWatchdogNudge: false,
    hasAbsoluteCommand: false,
});

/** An in-memory `LifecycleStateStore`; the mod is always "already seen". */
function makeStateStore(): LifecycleStateStore {
    const seen = new Map<string, { lastSeenVersion: string }>();
    return {
        get: async (modId) => seen.get(modId),
        set: async (modId, record) => { seen.set(modId, record); },
        clear: async () => { seen.clear(); },
    };
}

const mod = (overrides: Partial<LifecycleMod> = {}): LifecycleMod => ({
    id: 'interceptor-mod',
    name: 'Interceptor Mod',
    version: '1.0.0',
    file: 'interceptor-mod/manifest.json',
    dependencies: {},
    folder: 'interceptor-mod',
    native: {
        js: 'index.js',
        hooks: { activate: 'onActivate' },
        generateInterceptor: 'interceptPrompt',
    },
    loadIndex: 7,
    ...overrides,
});

/** Build a host whose `import()` returns the supplied module namespace. */
function makeHost(exports: Record<string, unknown>, options: { importThrows?: boolean } = {}) {
    const importModule = vi.fn(async () => {
        if (options.importThrows) throw new Error('network 404');
        return exports;
    });
    const nativeLoader = createNativeLoader({ apiBase, importModule });
    const faultStore = createLifecycleFaultStore();
    const host = createLifecycleHost({
        loadHooks: (m) => nativeLoader.load(m),
        stateStore: makeStateStore(),
        faultStore,
        nativeLoader,
    });
    return { host, faultStore, importModule };
}

beforeEach(() => {
    clearAllModInterceptors();
});

describe('manifest → registry', () => {
    it('registers the named export after a clean activate', async () => {
        const interceptPrompt = vi.fn(() => ({ contributions: [{ id: 'block', text: 'FROM THE MANIFEST' }] }));
        const { host } = makeHost({ onActivate: vi.fn(), interceptPrompt });

        await host.runLoadCycle({ mods: [mod()], enablement: {} });

        expect(hasPromptInterceptors()).toBe(true);
        expect(listPromptInterceptors()).toEqual(['interceptor-mod']);
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs[0]).toMatchObject({
            id: 'mod.interceptor-mod.block',
            text: 'FROM THE MANIFEST',
        });
        expect(interceptPrompt).toHaveBeenCalledTimes(1);
    });

    it('imports the module once for both the hooks and the interceptor', async () => {
        const { host, importModule } = makeHost({ onActivate: vi.fn(), interceptPrompt: vi.fn() });
        await host.runLoadCycle({ mods: [mod()], enablement: {} });
        expect(importModule).toHaveBeenCalledTimes(1);
    });

    it('registers a mod that declares an interceptor and no activate hook at all', async () => {
        // The gate is "activate did not fault", not "activate ran" — nothing
        // obliges a mod that only intercepts to register anything at runtime.
        const { host } = makeHost({ interceptPrompt: vi.fn(() => undefined) });
        await host.runLoadCycle({
            mods: [mod({ native: { js: 'index.js', generateInterceptor: 'interceptPrompt' } })],
            enablement: {},
        });
        expect(listPromptInterceptors()).toEqual(['interceptor-mod']);
    });

    it('does NOT register when the mod\'s activate faulted', async () => {
        // A mod in a broken state does not get code in the path that builds
        // the prompt.
        const { host, faultStore } = makeHost({
            onActivate: () => { throw new Error('activate blew up'); },
            interceptPrompt: vi.fn(),
        });
        await host.runLoadCycle({ mods: [mod()], enablement: {} });

        expect(hasPromptInterceptors()).toBe(false);
        expect(faultStore.getRecords().some((r) => r.kind === 'threw')).toBe(true);
    });

    it('does not register a disabled mod', async () => {
        const { host } = makeHost({ onActivate: vi.fn(), interceptPrompt: vi.fn() });
        await host.runLoadCycle({ mods: [mod()], enablement: { 'mod.interceptor-mod': false } });
        expect(hasPromptInterceptors()).toBe(false);
    });

    it('carries the resolved load index through, so run order is load order', async () => {
        const { host } = makeHost({ onActivate: vi.fn(), interceptPrompt: vi.fn(() => undefined) });
        await host.runLoadCycle({
            mods: [
                mod({ id: 'second', name: 'Second', file: 'second/manifest.json', folder: 'second' }),
                mod({ id: 'first', name: 'First', file: 'first/manifest.json', folder: 'first' }),
            ],
            enablement: {},
        });
        // The load cycle derives the index from the array position, so the
        // registry's order matches the loader's resolved order — not the ids'
        // alphabetical order.
        expect(listPromptInterceptors()).toEqual(['second', 'first']);
    });
});

describe('a manifest naming a missing export', () => {
    it('is a missing-export fault, and the mod simply has no interceptor', async () => {
        const { host, faultStore } = makeHost({ onActivate: vi.fn() /* no interceptPrompt */ });
        await host.runLoadCycle({ mods: [mod()], enablement: {} });

        expect(hasPromptInterceptors()).toBe(false);
        const record = faultStore.getRecords().find((r) => r.modId === 'interceptor-mod');
        expect(record?.kind).toBe('missing-export');
        expect(record?.reason).toContain('generateInterceptor');
        expect(record?.reason).toContain('interceptPrompt');
    });

    it('does not stop the mod, or the load cycle, from working', async () => {
        const onActivate = vi.fn();
        const { host } = makeHost({ onActivate });
        const result = await host.runLoadCycle({ mods: [mod()], enablement: {} });
        expect(onActivate).toHaveBeenCalledTimes(1);
        expect(result.runs.some((r) => r.hook === 'activate' && r.ok)).toBe(true);
    });
});

describe('host-owned teardown through the lifecycle host', () => {
    it('disable removes the interceptor even though the mod never unregisters it', async () => {
        const { host } = makeHost({ onActivate: vi.fn(), interceptPrompt: vi.fn(() => ({ contributions: [{ id: 'b', text: 'X' }] })) });
        await host.runLoadCycle({ mods: [mod()], enablement: {} });
        expect(hasPromptInterceptors()).toBe(true);

        await host.disable({ mod: mod() });
        expect(hasPromptInterceptors()).toBe(false);
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
    });

    it('enable puts it back, with no double registration across churn', async () => {
        const { host } = makeHost({ onActivate: vi.fn(), interceptPrompt: vi.fn(() => undefined) });
        await host.runLoadCycle({ mods: [mod()], enablement: {} });

        for (let i = 0; i < 5; i++) {
            await host.disable({ mod: mod() });
            expect(listPromptInterceptors()).toEqual([]);
            await host.enable({ mod: mod() });
            expect(listPromptInterceptors()).toEqual(['interceptor-mod']);
        }
    });

    it('reset drops every interceptor', async () => {
        const { host } = makeHost({ onActivate: vi.fn(), interceptPrompt: vi.fn() });
        await host.runLoadCycle({ mods: [mod()], enablement: {} });
        host.reset();
        expect(hasPromptInterceptors()).toBe(false);
    });
});
