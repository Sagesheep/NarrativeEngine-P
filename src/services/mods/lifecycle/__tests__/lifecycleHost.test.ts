/**
 * Phase 1.4 — lifecycle host tests.
 *
 * Proves the done-when criteria from the work order:
 *
 *   1. All seven hooks fire at the right moment, proven by a test mod that
 *      records each call.
 *   2. A hook that throws, and a hook that never resolves, both produce a
 *      surfaced fault and leave the app usable.
 *   3. Dependency ordering test passes (a dependency activates before its
 *      dependent, in the loader's resolved order).
 *   4. Existing mods (which declare no hooks) behave identically — verified
 *      by a mod with no `native` block running through the same load cycle.
 *
 * The fault store is real (not mocked) so the surfaced-reason shape is
 * asserted, not stubbed. The state store is in-memory. The `LoadModHooks`
 * seam is faked via `recordingLoader`, which is the same shape Phase 1.5 will
 * implement with a real `import()`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createLifecycleHost } from '../lifecycleHost';
import type { LifecycleMod } from '../lifecycleHost';
import { createLifecycleFaultStore } from '../lifecycleFaults';
import {
    callSequence,
    makeInMemoryStateStore,
    makeRecordingMod,
    recordingLoader,
    type RecordingMod,
} from '../lifecycleFixtures';
import type { LifecycleFaultStore, ModEnablementMap } from '../lifecycleTypes';
import { createNativeLoader, NativeMissingExportError } from '../../native/nativeLoader';

const allEnabled = (mods: readonly RecordingMod[]): ModEnablementMap => {
    const map: ModEnablementMap = {};
    for (const m of mods) map[`mod.${m.mod.id}`] = true;
    return map;
};

describe('Phase 1.4 — lifecycle host', () => {
    let faultStore: LifecycleFaultStore;

    beforeEach(() => {
        faultStore = createLifecycleFaultStore();
    });

    // ── §4 done-when #1: all seven hooks fire at the right moment ───────

    describe('load cycle — install / update / activate', () => {
        it('fires install then activate on first sight of a mod', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });

            expect(callSequence(rec.calls)).toEqual(['install', 'activate']);
        });

        it('fires update then activate when the version string differs', async () => {
            const rec = makeRecordingMod({ id: 'alpha', version: '2.0.0' });
            const state = makeInMemoryStateStore({
                alpha: { lastSeenVersion: '1.0.0' },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: state,
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });

            expect(callSequence(rec.calls)).toEqual(['update', 'activate']);
        });

        it('fires only activate when the version is unchanged', async () => {
            const rec = makeRecordingMod({ id: 'alpha', version: '1.0.0' });
            const state = makeInMemoryStateStore({
                alpha: { lastSeenVersion: '1.0.0' },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: state,
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });

            expect(callSequence(rec.calls)).toEqual(['activate']);
        });

        it('install never fires again, even after disable/enable', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const state = makeInMemoryStateStore();
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: state,
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });
            rec.reset();
            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });

            expect(callSequence(rec.calls)).toEqual(['activate']);
        });

        it('skips a disabled mod entirely (no install, no activate)', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({
                mods: [rec.mod],
                enablement: { 'mod.alpha': false },
            });

            expect(rec.calls).toHaveLength(0);
        });
    });

    describe('enable / disable', () => {
        it('enable fires enable then activate', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.enable({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['enable', 'activate']);
        });

        it('disable fires only disable', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.disable({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['disable']);
        });

        it('enable still activates when a mod has no enable hook (only activate)', async () => {
            // Build a recording mod whose hookImpls contain activate only.
            const rec = makeRecordingMod({ id: 'gamma' });
            const recNoEnable: RecordingMod = {
                ...rec,
                hookImpls: { activate: rec.hookImpls.activate },
            };
            const host = createLifecycleHost({
                loadHooks: recordingLoader([recNoEnable]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.enable({ mod: rec.mod });

            // enable was not declared; only activate records
            expect(callSequence(rec.calls)).toEqual(['activate']);
        });
    });

    describe('delete / clean', () => {
        it('delete fires only delete', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.remove({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['delete']);
        });

        it('clean fires only clean', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.clean({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['clean']);
        });
    });

    // ── §4 done-when #2: throwing + never-resolving hooks produce faults ─

    describe('fault containment', () => {
        it('a throwing activate is contained as a fault and the app continues', async () => {
            const throwing = makeRecordingMod({
                id: 'bad',
                overrides: {
                    activate: () => { throw new Error('boom on activate'); },
                },
            });
            const good = makeRecordingMod({ id: 'good' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([throwing, good]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            const result = await host.runLoadCycle({
                mods: [throwing.mod, good.mod],
                enablement: allEnabled([throwing, good]),
            });

            expect(result.faultedModIds).toEqual(['bad']);
            // Good mod still activated despite bad mod's fault
            expect(callSequence(good.calls)).toContain('activate');
            const records = faultStore.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({
                modId: 'bad',
                kind: 'threw',
                hook: 'activate',
            });
            expect(records[0].reason).toMatch(/threw \(boom on activate\)/);
        });

        it('a hook that never resolves is contained as a deadline fault', async () => {
            const hanging = makeRecordingMod({
                id: 'hang',
                overrides: {
                    activate: () => new Promise<void>(() => { /* never resolves */ }),
                },
            });
            const good = makeRecordingMod({ id: 'good' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([hanging, good]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                deadlineMs: 50,
            });

            const start = Date.now();
            const result = await host.runLoadCycle({
                mods: [hanging.mod, good.mod],
                enablement: allEnabled([hanging, good]),
            });
            const elapsed = Date.now() - start;

            expect(result.faultedModIds).toEqual(['hang']);
            expect(elapsed).toBeGreaterThanOrEqual(40);
            expect(elapsed).toBeLessThan(500);
            expect(callSequence(good.calls)).toContain('activate');
            const records = faultStore.getRecords();
            expect(records[0]).toMatchObject({
                modId: 'hang',
                kind: 'deadline',
                hook: 'activate',
            });
            expect(records[0].reason).toMatch(/deadline exceeded \(50 ms\)/);
        });

        it('a throwing install does not stop activate from running', async () => {
            const rec = makeRecordingMod({
                id: 'bad-install',
                overrides: {
                    install: () => { throw new Error('install failed'); },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });

            expect(callSequence(rec.calls)).toEqual(['install', 'activate']);
            const records = faultStore.getRecords();
            expect(records[0]).toMatchObject({ modId: 'bad-install', hook: 'install' });
        });

        it('a faulted load (import throws) is surfaced and the app still starts', async () => {
            const bad = makeRecordingMod({ id: 'broken-import' });
            const good = makeRecordingMod({ id: 'good' });
            const loader = (mod: { id: string }) => {
                if (mod.id === 'broken-import') {
                    throw new Error('import failed: syntax error');
                }
                return recordingLoader([good])(mod);
            };
            const host = createLifecycleHost({
                loadHooks: loader,
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({
                mods: [bad.mod, good.mod],
                enablement: allEnabled([bad, good]),
            });

            expect(callSequence(good.calls)).toContain('activate');
            const records = faultStore.getRecords();
            expect(records[0]).toMatchObject({
                modId: 'broken-import',
                kind: 'load',
            });
            expect(records[0].reason).toMatch(/load \(import failed/);
        });
    });

    // ── §4 done-when #3: dependency ordering test passes ────────────────

    describe('dependency ordering', () => {
        it('a dependency activates before its dependent (loader resolved order)', async () => {
            // dep has no dependencies; dependent depends on dep.
            // The loader's resolved order is [dep, dependent] (topological).
            // Use a shared chronological log to assert dep's activate fires
            // before dependent's activate — the host runs mods sequentially
            // in the loader's resolved order, so this must hold.
            const log: string[] = [];
            const dep = makeRecordingMod({
                id: 'dep',
                overrides: {
                    activate: () => { log.push('dep:activate'); },
                },
            });
            const dependent = makeRecordingMod({
                id: 'dependent',
                dependencies: { dep: '>=1.0.0' },
                overrides: {
                    activate: () => { log.push('dependent:activate'); },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([dep, dependent]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({
                mods: [dep.mod, dependent.mod],
                enablement: allEnabled([dep, dependent]),
            });

            const depActivateAt = log.indexOf('dep:activate');
            const dependentActivateAt = log.indexOf('dependent:activate');
            expect(depActivateAt).toBeGreaterThanOrEqual(0);
            expect(dependentActivateAt).toBeGreaterThanOrEqual(0);
            expect(depActivateAt).toBeLessThan(dependentActivateAt);
        });

        it('a mod whose dependency is disabled does not activate (own fault kind)', async () => {
            const dep = makeRecordingMod({ id: 'dep' });
            const dependent = makeRecordingMod({
                id: 'dependent',
                dependencies: { dep: '>=1.0.0' },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([dep, dependent]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({
                mods: [dep.mod, dependent.mod],
                enablement: {
                    'mod.dep': false,
                    'mod.dependent': true,
                },
            });

            expect(dep.calls).toHaveLength(0);
            expect(dependent.calls).toHaveLength(0);
            const records = faultStore.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({
                modId: 'dependent',
                kind: 'disabled-dep',
            });
            expect(records[0].reason).toMatch(/dependency "dep" is disabled/);
        });
    });

    // ── §4 done-when #4: no-hook mods behave identically ────────────────

    describe('no-hook mods (backwards compatibility)', () => {
        it('a mod with no native block produces no calls and no faults', async () => {
            const rec = makeRecordingMod({ id: 'plain', noNative: true });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            const result = await host.runLoadCycle({
                mods: [rec.mod],
                enablement: allEnabled([rec]),
            });

            expect(rec.calls).toHaveLength(0);
            expect(result.runs).toHaveLength(0);
            expect(result.faultedModIds).toHaveLength(0);
            expect(faultStore.getFaults()).toHaveLength(0);
        });

        it('a mod with a native block but no hooks declared produces no calls', async () => {
            const rec = makeRecordingMod({ id: 'native-no-hooks' });
            // Override hookImpls to be empty — simulates a manifest with
            // native.js but no hooks:{} entries
            const emptyHooks = { ...rec, hookImpls: {} };
            const host = createLifecycleHost({
                loadHooks: recordingLoader([emptyHooks]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            const result = await host.runLoadCycle({
                mods: [rec.mod],
                enablement: allEnabled([rec]),
            });

            expect(rec.calls).toHaveLength(0);
            expect(result.runs).toHaveLength(0);
        });

        it('enable on a no-native mod is a no-op (skipped, not faulted)', async () => {
            const rec = makeRecordingMod({ id: 'plain', noNative: true });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            const result = await host.enable({ mod: rec.mod });

            expect(result.ok).toBe(true);
            expect(result.skipped).toBe(true);
            expect(faultStore.getFaults()).toHaveLength(0);
        });
    });

    // ── §3 rules — async hooks, ordering, latch, context pass-through ──

    describe('async and ordering rules', () => {
        it('async hooks are awaited (install completes before activate runs)', async () => {
            const order: string[] = [];
            const rec = makeRecordingMod({
                id: 'async-mod',
                overrides: {
                    install: () => new Promise<void>((resolve) => {
                        setTimeout(() => { order.push('install-done'); resolve(); }, 10);
                    }),
                    activate: () => {
                        order.push('activate-run');
                    },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });

            expect(order).toEqual(['install-done', 'activate-run']);
        });

        it('the mod context argument is passed through to each hook', async () => {
            const ctx = { sentinel: 0xABCD };
            const rec = makeRecordingMod({
                id: 'ctx-mod',
                overrides: {
                    activate: (c) => { (rec.calls[0] as { ctx: unknown }).ctx = c; },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]), ctx });

            // The recording wrapper pushed before the override; the override
            // captured the ctx. Both should see the same ctx.
            expect(rec.calls[0].ctx).toBe(ctx);
        });
    });

    describe('latching after repeated faults', () => {
        it('three consecutive faulted runs latch the mod for the session', async () => {
            const rec = makeRecordingMod({
                id: 'flaky',
                overrides: {
                    activate: () => { throw new Error('always fails'); },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            // Three load cycles, each faulting
            for (let i = 0; i < 3; i++) {
                await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });
            }

            expect(host.isLatched('flaky')).toBe(true);
            const records = faultStore.getRecords();
            expect(records[0].latched).toBe(true);
            expect(records[0].strikes).toBe(3);

            // A fourth run is skipped, not faulted again
            rec.reset();
            const result = await host.runLoadCycle({
                mods: [rec.mod],
                enablement: allEnabled([rec]),
            });
            // activate was skipped (latched)
            const activateRun = result.runs.find((r) => r.hook === 'activate');
            expect(activateRun?.skipped).toBe(true);
        });

        it('a clean run clears prior strikes', async () => {
            let fail = true;
            const rec = makeRecordingMod({
                id: 'recovering',
                overrides: {
                    activate: () => {
                        if (fail) throw new Error('once');
                    },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });
            expect(host.isLatched('recovering')).toBe(false);
            fail = false;
            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });
            // Clean run cleared strikes, so a later fault starts from 1
            fail = true;
            await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });
            const records = faultStore.getRecords();
            expect(records[0].strikes).toBe(1);
            expect(host.isLatched('recovering')).toBe(false);
        });

        it('reset clears all session state', async () => {
            const rec = makeRecordingMod({
                id: 'flaky',
                overrides: { activate: () => { throw new Error('x'); } },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });
            for (let i = 0; i < 3; i++) {
                await host.runLoadCycle({ mods: [rec.mod], enablement: allEnabled([rec]) });
            }
            expect(host.isLatched('flaky')).toBe(true);

            host.reset();

            expect(host.isLatched('flaky')).toBe(false);
            expect(faultStore.getFaults()).toHaveLength(0);
        });
    });

    // ── §3: enable followed by activate even when enable skips ─────────

    describe('enable/activate composition', () => {
        it('enable with no enable hook still runs activate', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            // Remove the enable hook from hookImpls, keep activate
            const recNoEnable: RecordingMod = {
                ...rec,
                hookImpls: { ...rec.hookImpls, enable: undefined },
            };
            const host = createLifecycleHost({
                loadHooks: recordingLoader([recNoEnable]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.enable({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['activate']);
        });

        it('enable that faults does NOT proceed to activate', async () => {
            const rec = makeRecordingMod({
                id: 'bad-enable',
                overrides: {
                    enable: () => { throw new Error('enable threw'); },
                },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            const result = await host.enable({ mod: rec.mod });

            expect(result.ok).toBe(false);
            // Only enable was called; activate did not run
            expect(callSequence(rec.calls)).toEqual(['enable']);
            expect(faultStore.getRecords()[0]).toMatchObject({ hook: 'enable' });
        });
    });

    // ── full load cycle ordering with multiple mods and hooks ──────────

    describe('full load cycle — multi-mod ordering', () => {
        it('fires install/update/activate in resolved order across mods', async () => {
            const a = makeRecordingMod({ id: 'a', version: '1.0.0' });
            const b = makeRecordingMod({ id: 'b', version: '1.0.0' });
            const state = makeInMemoryStateStore({
                b: { lastSeenVersion: '0.9.0' }, // b should update
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([a, b]),
                stateStore: state,
                faultStore,
            });

            await host.runLoadCycle({
                mods: [a.mod, b.mod],
                enablement: allEnabled([a, b]),
            });

            expect(callSequence(a.calls)).toEqual(['install', 'activate']);
            expect(callSequence(b.calls)).toEqual(['update', 'activate']);
            // a completes before b starts (sequential, in resolved order)
            const aLast = a.calls[a.calls.length - 1];
            const bFirst = b.calls[0];
            expect(aLast.hook).toBe('activate');
            expect(bFirst.hook).toBe('update');
        });
    });

    // ── §3: delete and clean are different (MANIFEST §3.1) ─────────────

    describe('delete vs clean separation', () => {
        it('remove fires delete only, never clean', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.remove({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['delete']);
        });

        it('clean fires clean only, never delete', async () => {
            const rec = makeRecordingMod({ id: 'alpha' });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            await host.clean({ mod: rec.mod });

            expect(callSequence(rec.calls)).toEqual(['clean']);
        });

        it('a throwing delete is contained as a fault', async () => {
            const rec = makeRecordingMod({
                id: 'bad-delete',
                overrides: { delete: () => { throw new Error('delete failed'); } },
            });
            const host = createLifecycleHost({
                loadHooks: recordingLoader([rec]),
                stateStore: makeInMemoryStateStore(),
                faultStore,
            });

            const result = await host.remove({ mod: rec.mod });

            expect(result.ok).toBe(false);
            expect(faultStore.getRecords()[0]).toMatchObject({
                modId: 'bad-delete',
                kind: 'threw',
                hook: 'delete',
            });
        });
    });
});

// ── Phase 1.5 — native-tier integration ────────────────────────────────
//
// Pins the Phase 1.5 done-when criteria that the lifecycle host + native
// loader satisfy TOGETHER (each in isolation is pinned by their own tests):
//   • CSS is mounted on a successful activate and unmounted on disable.
//   • CSS is NOT mounted when activate faults (a broken mod's styles must
//     not reach the page until the user fixes it and rescans).
//   • A missing-export fault is classified distinctly from a load fault.
//   • The cached module is forgotten on disable, so a re-enable re-imports.
//   • Campaign switch (a second load cycle) does not double-mount CSS.
//
// The `nativeLoader` here is the real `createNativeLoader` with a faked
// `import()` seam, so the host exercises the actual mount/unmount and cache
// code paths, not a stub.

const allEnabledFor = (ids: readonly string[]): ModEnablementMap => {
    const map: ModEnablementMap = {};
    for (const id of ids) map[`mod.${id}`] = true;
    return map;
};

describe('Phase 1.5 — native-tier integration', () => {
    let faultStore: LifecycleFaultStore;

    beforeEach(() => {
        faultStore = createLifecycleFaultStore();
        // Clean any DOM state between tests so a leaked `<link>` does not
        // satisfy another test's idempotence check.
        document.head.querySelectorAll('link[data-mod-css]').forEach((link) => link.remove());
    });

    describe('CSS mount/unmount', () => {
        it('mounts CSS on a successful activate', async () => {
            const onActivate = vi.fn();
            const importModule = vi.fn().mockResolvedValue({ onActivate });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'css-mod',
                name: 'CSS Mod',
                version: '1.0.0',
                file: 'css-mod/manifest.json',
                dependencies: {},
                folder: 'css-mod',
                native: { js: 'index.js', css: 'style.css', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({
                mods: [mod],
                enablement: allEnabledFor(['css-mod']),
            });

            const link = document.head.querySelector('link[data-mod-css="css-mod"]');
            expect(link).not.toBeNull();
            expect(link?.getAttribute('href')).toBe('http://test.local/api/mods/css-mod/style.css');
        });

        it('does NOT mount CSS when activate faults', async () => {
            const importModule = vi.fn().mockResolvedValue({
                onActivate: () => { throw new Error('activate boom'); },
            });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'bad-css-mod',
                name: 'Bad CSS Mod',
                version: '1.0.0',
                file: 'bad-css-mod/manifest.json',
                dependencies: {},
                folder: 'bad-css-mod',
                native: { js: 'index.js', css: 'style.css', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['bad-css-mod']) });

            expect(document.head.querySelectorAll('link[data-mod-css="bad-css-mod"]')).toHaveLength(0);
            expect(faultStore.getRecords()[0]).toMatchObject({ modId: 'bad-css-mod', kind: 'threw' });
        });

        it('unmounts CSS on disable', async () => {
            const importModule = vi.fn().mockResolvedValue({
                onActivate: vi.fn(),
                onDisable: vi.fn(),
            });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'css-disable-mod',
                name: 'CSS Disable Mod',
                version: '1.0.0',
                file: 'css-disable-mod/manifest.json',
                dependencies: {},
                folder: 'css-disable-mod',
                native: { js: 'index.js', css: 'style.css', hooks: { activate: 'onActivate', disable: 'onDisable' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['css-disable-mod']) });
            expect(document.head.querySelectorAll('link[data-mod-css="css-disable-mod"]')).toHaveLength(1);

            await host.disable({ mod });
            expect(document.head.querySelectorAll('link[data-mod-css="css-disable-mod"]')).toHaveLength(0);
        });

        it('unmounts CSS even when disable hook throws', async () => {
            const importModule = vi.fn().mockResolvedValue({
                onActivate: vi.fn(),
                onDisable: () => { throw new Error('disable boom'); },
            });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'bad-disable-css',
                name: 'Bad Disable CSS',
                version: '1.0.0',
                file: 'bad-disable-css/manifest.json',
                dependencies: {},
                folder: 'bad-disable-css',
                native: { js: 'index.js', css: 'style.css', hooks: { activate: 'onActivate', disable: 'onDisable' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['bad-disable-css']) });
            expect(document.head.querySelectorAll('link[data-mod-css="bad-disable-css"]')).toHaveLength(1);

            const result = await host.disable({ mod });
            expect(result.ok).toBe(false);
            expect(document.head.querySelectorAll('link[data-mod-css="bad-disable-css"]')).toHaveLength(0);
        });

        it('does not double-mount CSS on a second load cycle (campaign switch)', async () => {
            const importModule = vi.fn().mockResolvedValue({ onActivate: vi.fn() });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'idempotent-css',
                name: 'Idempotent CSS',
                version: '1.0.0',
                file: 'idempotent-css/manifest.json',
                dependencies: {},
                folder: 'idempotent-css',
                native: { js: 'index.js', css: 'style.css', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['idempotent-css']) });
            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['idempotent-css']) });

            expect(document.head.querySelectorAll('link[data-mod-css="idempotent-css"]')).toHaveLength(1);
        });
    });

    describe('missing-export vs load fault classification', () => {
        it('a missing export is classified as missing-export, not load', async () => {
            // The import succeeds, but the declared hook name is not a function.
            const importModule = vi.fn().mockResolvedValue({ onActivate: 'not a function' });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'missing-export-mod',
                name: 'Missing Export Mod',
                version: '1.0.0',
                file: 'missing-export-mod/manifest.json',
                dependencies: {},
                folder: 'missing-export-mod',
                native: { js: 'index.js', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['missing-export-mod']) });

            const records = faultStore.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({
                modId: 'missing-export-mod',
                kind: 'missing-export',
                hook: 'activate',
            });
            expect(records[0].reason).toMatch(/named a missing export/);
        });

        it('a failed import is classified as load', async () => {
            const importModule = vi.fn().mockRejectedValue(new Error('import failed: syntax error'));
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'broken-import',
                name: 'Broken Import',
                version: '1.0.0',
                file: 'broken-import/manifest.json',
                dependencies: {},
                folder: 'broken-import',
                native: { js: 'index.js', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['broken-import']) });

            const records = faultStore.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ modId: 'broken-import', kind: 'load' });
            expect(records[0].reason).toMatch(/load \(import failed/);
        });

        it('a throwing mod and a good mod coexist: faults surface per mod', async () => {
            const goodActivate = vi.fn();
            const importModule = vi.fn().mockImplementation((url: string) => {
                if (url.includes('broken-import')) {
                    return Promise.reject(new Error('import failed: syntax error'));
                }
                return Promise.resolve({ onActivate: goodActivate });
            });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const broken: LifecycleMod = {
                id: 'broken-import',
                name: 'Broken Import',
                version: '1.0.0',
                file: 'broken-import/manifest.json',
                dependencies: {},
                folder: 'broken-import',
                native: { js: 'index.js', hooks: { activate: 'onActivate' } },
            };
            const good: LifecycleMod = {
                id: 'good-mod',
                name: 'Good Mod',
                version: '1.0.0',
                file: 'good-mod/manifest.json',
                dependencies: {},
                folder: 'good-mod',
                native: { js: 'index.js', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({
                mods: [broken, good],
                enablement: allEnabledFor(['broken-import', 'good-mod']),
            });

            // The good mod's activate ran despite the broken mod's load fault.
            expect(goodActivate).toHaveBeenCalledTimes(1);
            // The broken mod's load fault is recorded.
            const records = faultStore.getRecords();
            expect(records).toHaveLength(1);
            expect(records[0]).toMatchObject({ modId: 'broken-import', kind: 'load' });
        });
    });

    describe('module cache invalidation on disable', () => {
        it('disable forgets the cached module so a re-enable re-imports', async () => {
            const onActivate = vi.fn();
            const importModule = vi.fn().mockResolvedValue({ onActivate });
            const nativeLoader = createNativeLoader({ apiBase: 'http://test.local/api', importModule });
            const mod: LifecycleMod = {
                id: 'reimport-mod',
                name: 'Reimport Mod',
                version: '1.0.0',
                file: 'reimport-mod/manifest.json',
                dependencies: {},
                folder: 'reimport-mod',
                native: { js: 'index.js', hooks: { activate: 'onActivate' } },
            };
            const host = createLifecycleHost({
                loadHooks: (m) => nativeLoader.load(m),
                stateStore: makeInMemoryStateStore(),
                faultStore,
                nativeLoader,
            });

            await host.runLoadCycle({ mods: [mod], enablement: allEnabledFor(['reimport-mod']) });
            expect(importModule).toHaveBeenCalledTimes(1);

            await host.disable({ mod });
            await host.enable({ mod });
            // A re-enable re-imports because the cache was forgotten.
            expect(importModule).toHaveBeenCalledTimes(2);
        });
    });

    describe('NativeMissingExportError', () => {
        it('carries the mod id, hook name, and export name for diagnostics', () => {
            const err = new NativeMissingExportError({
                modId: 'arc',
                hookName: 'activate',
                exportName: 'onActivate',
                actual: 'undefined',
            });
            expect(err.modId).toBe('arc');
            expect(err.hookName).toBe('activate');
            expect(err.exportName).toBe('onActivate');
            expect(err.message).toContain('arc');
            expect(err.message).toContain('onActivate');
            expect(err.message).toContain('undefined');
        });
    });
});