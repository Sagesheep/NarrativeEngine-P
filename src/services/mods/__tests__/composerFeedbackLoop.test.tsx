/**
 * The `composer.actions` feedback loop — the two defects that made the Arc
 * Engine's "Inject Arc" button look dead while its `onSelect` ran fine.
 *
 *   1. **`handle.update()` is a mod's only repaint.** The generic chrome
 *      renderer reads `state()` at render time, and the row re-renders only
 *      when the region's listeners are woken. A mod that mutates its own phase
 *      without calling `update()` on the handle `mounts.composer()` returned
 *      changes nothing on screen — and since `ModContext` carries no toast
 *      surface, that leaves NO feedback channel: success, rejection and thrown
 *      error are all equally invisible. `mods/arc/index.js` discarded its
 *      handle; `anno-mark` and `ability-compendium` never did.
 *
 *   2. **The §8.8 drain must precede the Phase 9.2 refresh.** The drain writes
 *      the committed turn into `archiveIndex` / `chapters` / the NPC ledger.
 *      Refreshing the mod's context first hands it a snapshot of the state the
 *      commit was about to replace — which is precisely the staleness §8.8
 *      exists to prevent. `ChatActionStrip` used to drain inside a wrapped
 *      `onSelect`, i.e. after the renderer had already refreshed.
 *
 * Both are asserted through the REAL registry and the REAL renderer. A test
 * that only checks `onSelect` ran would pass against both bugs — the whole
 * suite did.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { useSyncExternalStore } from 'react';
import { render, cleanup, screen, fireEvent, act } from '@testing-library/react';
import {
    registerModChrome,
    readRegion,
    resetMountRegistryForTests,
    subscribeToRegion,
    type RegisteredChromeEntry,
} from '../mounts/mountRegistry';
import { renderComposerModEntry } from '../mounts/chromeRenderers';
import type { ChromeState, MountRegistryMod } from '../mounts/mountTypes';

const MOD: MountRegistryMod = { id: 'probe', name: 'Probe' };
const t = (key: string) => key;
const lastGood = () => ({ current: undefined as ChromeState | undefined });

const only = (): RegisteredChromeEntry =>
    readRegion('composer.actions').find((e) => e.renderer === 'generic') as RegisteredChromeEntry;

beforeEach(() => {
    resetMountRegistryForTests();
});

afterEach(() => {
    cleanup();
    resetMountRegistryForTests();
});

describe('the arc mod repaints its own button', () => {
    /**
     * Drives the REAL `mods/arc/index.js`, not a stand-in. A test that asserts
     * `handle.update()` wakes the region would pass against the shipped bug —
     * the registry was never broken; the mod discarded the handle. So the
     * assertion has to be made against the mod's own `onActivate`/`onSelect`.
     */
    it('every phase transition reaches the mount handle', async () => {
        const updates: Array<string | undefined> = [];
        let entry: { onSelect: (ctx: unknown) => Promise<void>; state: () => ChromeState } | undefined;

        const handle = {
            // Record what the row WOULD render at each repaint, which is the
            // thing the user was not seeing.
            update: () => { updates.push(entry?.state().label); },
            remove: () => undefined,
        };

        // The mod keeps its press state at module scope, so a shared instance
        // carries another case's state into this one. Reset so this press
        // starts from a clean mod.
        vi.resetModules();
        const { onActivate } = await import('../../../../mods/arc/index.js');
        await onActivate({
            mounts: {
                composer: (e: typeof entry) => { entry = e; return handle; },
            },
        });
        expect(entry).toBeDefined();

        const written: Array<{ name: string; rows: unknown }> = [];
        await entry!.onSelect({
            table: {
                read: async () => [],
                write: async (name: string, rows: unknown) => { written.push({ name, rows }); },
            },
            data: {
                chapters: [],
                archiveIndex: [{ sceneId: '012' }],
                npcLedger: [],
                messages: [{ role: 'assistant', content: 'The harbour tolls have doubled again.' }],
            },
            model: {
                call: async () => ({
                    content: JSON.stringify({
                        title: 'Harbour squeeze',
                        type: 'economic',
                        seed: 'The harbour levy is being farmed out to a syndicate.',
                        ladder: [
                            { label: 'rung 0', surface: 'ambient' },
                            { label: 'rung 1', surface: 'ambient' },
                            { label: 'rung 2', surface: 'rumor' },
                            { label: 'rung 3', surface: 'rumor' },
                            { label: 'rung 4', surface: 'direct' },
                        ],
                    }),
                }),
            },
            log: () => undefined,
        });

        // The arc landed in the mod's own table…
        expect(written).toHaveLength(1);
        expect(written[0].name).toBe('arcs');
        expect((written[0].rows as unknown[])).toHaveLength(1);

        // …and, crucially, the button said so. Before the fix this array was
        // empty: the phases were set, nothing repainted, and a successful
        // injection was indistinguishable from a dead button.
        expect(updates).toEqual(['INJECTING…', 'INJECTED']);
    });
});

describe('composer.actions — the region wakes its subscribers on update()', () => {
    it('handle.update() wakes the region so the next render reads the new state()', () => {
        let phase: 'idle' | 'loading' = 'idle';

        const handle = registerModChrome('composer.actions', MOD, {
            id: 'injectProbe',
            icon: 'Syringe',
            label: 'INJECT',
            onSelect: () => { phase = 'loading'; },
            state: () => (phase === 'loading'
                ? { icon: 'Loader2', label: 'INJECTING', busy: true, disabled: true }
                : { label: 'INJECT' }),
        }, 0, {});

        // A subscriber standing in for the row's `useSyncExternalStore`.
        let wakeups = 0;
        const unsubscribe = subscribeToRegion('composer.actions', () => { wakeups += 1; });

        render(<>{renderComposerModEntry(only(), t, lastGood())}</>);
        expect(screen.getByRole('button')).toHaveTextContent('INJECT');

        // Mutating phase alone is invisible — no wakeup, so no re-render.
        phase = 'loading';
        expect(wakeups).toBe(0);

        handle.update();
        expect(wakeups).toBe(1);

        cleanup();
        render(<>{renderComposerModEntry(only(), t, lastGood())}</>);
        expect(screen.getByRole('button')).toHaveTextContent('INJECTING');

        unsubscribe();
    });

    /**
     * The same repaint, through the mechanism the app actually uses.
     *
     * The test above asserts the two halves — `update()` wakes the region, and a
     * FRESH render reads the new `state()` — and passed against a button that
     * never repainted in the running app, because it supplies the re-render
     * itself (`cleanup()` + `render()`). `ChatActionStrip` has no such luxury:
     * it subscribes with `useSyncExternalStore`, which re-renders only when the
     * snapshot's identity changes. `readRegion` returns `store.entries` by
     * reference, so a wake-up that left the array alone was compared against
     * itself and dropped — the listener fired, React shrugged, and every phase
     * the Arc Engine set was invisible.
     *
     * So this renders through the real hook and never re-renders by hand. It
     * fails on `INJECT` (the idle label, still on screen) if `notifyRegion`
     * stops republishing the snapshot.
     */
    it('repaints a subscribed row without a manual re-render', async () => {
        let phase: 'idle' | 'loading' = 'idle';

        const handle = registerModChrome('composer.actions', MOD, {
            id: 'injectProbe',
            icon: 'Syringe',
            label: 'INJECT',
            onSelect: () => undefined,
            state: () => (phase === 'loading'
                ? { icon: 'Loader2', label: 'INJECTING', busy: true, disabled: true }
                : { label: 'INJECT' }),
        }, 0, {});

        // The composer row, reduced to the subscription it is built on.
        function Row() {
            const entries = useSyncExternalStore(
                (listener) => subscribeToRegion('composer.actions', listener),
                () => readRegion('composer.actions'),
                () => readRegion('composer.actions'),
            );
            const ref = lastGood();
            return <>{entries.map((e) => renderComposerModEntry(e, t, ref))}</>;
        }

        render(<Row />);
        expect(screen.getByRole('button')).toHaveTextContent('INJECT');

        phase = 'loading';
        await act(async () => { handle.update(); });

        expect(screen.getByRole('button')).toHaveTextContent('INJECTING');
    });
});

describe('composer.actions — §8.8 drain ordering', () => {
    it('drains the pending commit BEFORE refreshing the mod context', async () => {
        const order: string[] = [];

        // A context whose `refresh()` resolves to a distinct object, so the
        // test can tell which one `onSelect` was handed as well as when it was
        // built.
        const refreshed = { generation: 'post-drain' };
        const registered = {
            generation: 'activate-time',
            refresh: () => {
                order.push('refresh');
                return Promise.resolve(refreshed);
            },
        };

        let seen: unknown;
        registerModChrome('composer.actions', MOD, {
            id: 'injectProbe',
            icon: 'Syringe',
            label: 'INJECT',
            onSelect: (ctx) => {
                order.push('onSelect');
                seen = ctx;
            },
        }, 0, registered);

        const drain = () => {
            order.push('drain');
            return Promise.resolve();
        };

        render(<>{renderComposerModEntry(only(), t, lastGood(), drain)}</>);
        fireEvent.click(screen.getByRole('button'));

        // drain → refresh → onSelect, each a microtask behind the last.
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();
        await Promise.resolve();

        expect(order).toEqual(['drain', 'refresh', 'onSelect']);
        expect(seen).toBe(refreshed);
    });

    it('still dispatches when no drain is injected', () => {
        let calls = 0;
        registerModChrome('composer.actions', MOD, {
            id: 'injectProbe',
            icon: 'Syringe',
            label: 'INJECT',
            onSelect: () => { calls += 1; },
        }, 0, {});

        render(<>{renderComposerModEntry(only(), t, lastGood())}</>);
        fireEvent.click(screen.getByRole('button'));

        // No drain and no `refresh` on the context: dispatch stays synchronous,
        // which is the identity contract `phase92ChromeIdentity` pins.
        expect(calls).toBe(1);
    });
});
