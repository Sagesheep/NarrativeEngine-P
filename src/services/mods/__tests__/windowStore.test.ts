/**
 * Phase 4.5 — the window manager store tests.
 *
 * Proves the contract in `MOUNTS.md` §2.7 / §4.4 / §5 / §8.5 / §8.7:
 *   • Declaration + budget (3 per mod, §5) + duplicate-id check (§4.1) +
 *     revoked-lease check (§8.5).
 *   • open / close / focus / minimize drive runtime state.
 *   • z-order is the host's: opening or focusing raises a window above
 *     others; only one window is focused at a time (§4.4 / §3).
 *   • Geometry is clamped to the viewport on open, on move/resize, and on
 *     app-window resize (4.5 §3 — bounds clamp).
 *   • Persistence: geometry + open/closed/minimized survive reload, keyed
 *     `mod.<modId>.<windowId>` (§8.7).
 *   • Host-owned teardown: `disableModWindows` removes every declaration and
 *     closes every open window for one mod; `clearAllWindowsWindows` clears
 *     all (§8.5).
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    clearAllWindowsWindows,
    closeWindow,
    disableModWindows,
    focusWindow,
    getModWindowCount,
    openWindow,
    readDeclaredWindow,
    readDeclaredWindows,
    readOpenWindows,
    readWindowRuntime,
    readWindowState,
    reclampAllWindows,
    registerWindowDeclaration,
    setMinimized,
    setWindowGeometry,
    subscribeToWindows,
    WINDOW_DEFAULT_MIN_SIZE,
    WINDOW_KEEP_VISIBLE,
    WINDOW_Z_BASE,
} from '../mounts/windowStore';
import type { WindowDeclaration } from '../mounts/mountTypes';

const MOD_A = { id: 'mod-a', name: 'Mod A' };
const MOD_B = { id: 'mod-b', name: 'Mod B' };

const noopDeclaration = (id: string): WindowDeclaration => ({
    id,
    title: id,
    defaultSize: { width: 320, height: 240 },
    mount: () => undefined,
});

const STORAGE_PREFIX = 'nn_mod_window.';

beforeEach(() => {
    clearAllWindowsWindows();
    localStorage.clear();
    // jsdom defaults to 1024x768 — pinned here so the clamp tests know the
    // viewport they are running against.
    if (typeof window !== 'undefined') {
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 1024 });
        Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 768 });
    }
});

afterEach(() => {
    clearAllWindowsWindows();
    localStorage.clear();
});

describe('Phase 4.5 — window store: declaration + budget + duplicate + revoked', () => {
    it('registers a declaration and exposes it through readDeclaredWindows', () => {
        const declared = registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        expect(declared).not.toBeNull();
        expect(declared?.qualifiedId).toBe('mod.mod-a.editor');
        expect(readDeclaredWindows().map((d) => d.qualifiedId)).toContain('mod.mod-a.editor');
        expect(getModWindowCount(MOD_A.id)).toBe(1);
    });

    it('enforces the per-mod budget of 3 (MOUNTS.md §5)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {}, { declaredCount: 0, budget: 3 });
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {}, { declaredCount: 1, budget: 3 });
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('c'), 0, {}, { declaredCount: 2, budget: 3 });
        const fourth = registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('d'), 0, {}, { declaredCount: 3, budget: 3 });
        expect(fourth).toBeNull();
        expect(getModWindowCount(MOD_A.id)).toBe(3);
    });

    it('rejects a duplicate qualified id (§4.1)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('dup'), 0, {});
        const second = registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('dup'), 0, {});
        expect(second).toBeNull();
        expect(getModWindowCount(MOD_A.id)).toBe(1);
    });

    it('two mods can declare the same entry id (namespacing prevents collision)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        registerWindowDeclaration(MOD_B.id, MOD_B.name, noopDeclaration('editor'), 1, {});
        const ids = readDeclaredWindows().map((d) => d.qualifiedId);
        expect(ids).toEqual(['mod.mod-a.editor', 'mod.mod-b.editor']);
    });

    it('declares windows sorted by (loadIndex, withinModIndex)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('late'), 5, {});
        registerWindowDeclaration(MOD_B.id, MOD_B.name, noopDeclaration('early'), 1, {});
        const ids = readDeclaredWindows().map((d) => d.qualifiedId);
        expect(ids).toEqual(['mod.mod-b.early', 'mod.mod-a.late']);
    });

    it('a revoked mod cannot declare a window (no-op + null)', () => {
        const declared = registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {}, { revoked: true });
        expect(declared).toBeNull();
        expect(getModWindowCount(MOD_A.id)).toBe(0);
    });

    it('effective minSize / resizable fall back to defaults when the declaration omits them', () => {
        const declared = registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        expect(declared?.minSize).toEqual(WINDOW_DEFAULT_MIN_SIZE);
        expect(declared?.resizable).toBe(true);
    });

    it('respects a declared minSize and resizable=false', () => {
        const declared = registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'editor',
            title: 'Editor',
            defaultSize: { width: 320, height: 240 },
            minSize: { width: 200, height: 150 },
            resizable: false,
            mount: () => undefined,
        }, 0, {});
        expect(declared?.minSize).toEqual({ width: 200, height: 150 });
        expect(declared?.resizable).toBe(false);
    });
});

describe('Phase 4.5 — window store: open / close / focus', () => {
    it('openWindow puts a window in the open map and focuses it', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        openWindow('mod.mod-a.editor');
        const runtime = readWindowRuntime('mod.mod-a.editor');
        expect(runtime).toBeDefined();
        expect(runtime?.focused).toBe(true);
        expect(readWindowState().focusedId).toBe('mod.mod-a.editor');
    });

    it('opening a second window defocuses the first; only one window is focused (§3)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-a.b');
        expect(readWindowRuntime('mod.mod-a.a')?.focused).toBe(false);
        expect(readWindowRuntime('mod.mod-a.b')?.focused).toBe(true);
        expect(readWindowState().focusedId).toBe('mod.mod-a.b');
    });

    it('the newer window has a strictly higher z than the older one', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-a.b');
        const za = readWindowRuntime('mod.mod-a.a')?.z ?? 0;
        const zb = readWindowRuntime('mod.mod-a.b')?.z ?? 0;
        expect(zb).toBeGreaterThan(za);
    });

    it('focusWindow raises an existing open window without re-opening it', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-a.b');
        // a was defocused when b opened. Focusing a again raises it above b.
        focusWindow('mod.mod-a.a');
        const za = readWindowRuntime('mod.mod-a.a')?.z ?? 0;
        const zb = readWindowRuntime('mod.mod-a.b')?.z ?? 0;
        expect(za).toBeGreaterThan(zb);
        expect(readWindowState().focusedId).toBe('mod.mod-a.a');
    });

    it('closeWindow removes the window from the open map and focuses the next-highest', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-a.b');
        closeWindow('mod.mod-a.b');
        expect(readWindowRuntime('mod.mod-a.b')).toBeUndefined();
        // a was defocused when b opened; closing b should re-focus a.
        expect(readWindowRuntime('mod.mod-a.a')?.focused).toBe(true);
        expect(readWindowState().focusedId).toBe('mod.mod-a.a');
    });

    it('closing the last window leaves focusedId null', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('solo'), 0, {});
        openWindow('mod.mod-a.solo');
        closeWindow('mod.mod-a.solo');
        expect(readWindowState().focusedId).toBeNull();
    });

    it('openWindow on an unknown id is a no-op', () => {
        openWindow('mod.mod-a.unknown');
        expect(readWindowState().open.size).toBe(0);
    });

    it('readOpenWindows filters by open state', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        const open = readOpenWindows().map((d) => d.qualifiedId);
        expect(open).toEqual(['mod.mod-a.a']);
    });

    it('opening an already-open window focuses + un-minimizes it without resetting geometry', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        openWindow('mod.mod-a.a');
        setWindowGeometry('mod.mod-a.a', { x: 100, y: 100 });
        setMinimized('mod.mod-a.a', true);
        // Re-open: should un-minimize and focus, keeping the geometry.
        openWindow('mod.mod-a.a');
        const runtime = readWindowRuntime('mod.mod-a.a');
        expect(runtime?.minimized).toBe(false);
        expect(runtime?.focused).toBe(true);
        expect(runtime?.x).toBe(100);
        expect(runtime?.y).toBe(100);
    });
});

describe('Phase 4.5 — window store: geometry + bounds clamp (4.5 §3)', () => {
    it('opening clamps the default geometry into the viewport', () => {
        // A window larger than the viewport is clamped to the viewport size.
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'huge',
            title: 'Huge',
            defaultSize: { width: 5000, height: 5000 },
            mount: () => undefined,
        }, 0, {});
        openWindow('mod.mod-a.huge');
        const runtime = readWindowRuntime('mod.mod-a.huge');
        expect(runtime?.width).toBeLessThanOrEqual(1024);
        expect(runtime?.height).toBeLessThanOrEqual(768);
    });

    it('a resize below the minSize is clamped to the min', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'win',
            title: 'Win',
            defaultSize: { width: 300, height: 200 },
            minSize: { width: 200, height: 150 },
            mount: () => undefined,
        }, 0, {});
        openWindow('mod.mod-a.win');
        setWindowGeometry('mod.mod-a.win', { width: 50, height: 30 });
        const runtime = readWindowRuntime('mod.mod-a.win');
        expect(runtime?.width).toBe(200);
        expect(runtime?.height).toBe(150);
    });

    it('dragging a window off the right edge keeps WINDOW_KEEP_VISIBLE visible', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('win'), 0, {});
        openWindow('mod.mod-a.win');
        const width = readWindowRuntime('mod.mod-a.win')!.width;
        setWindowGeometry('mod.mod-a.win', { x: 100000 });
        const runtime = readWindowRuntime('mod.mod-a.win');
        // The window's right edge must leave at least WINDOW_KEEP_VISIBLE on screen.
        // right edge = x + width; that must be <= viewport.width - 0 (i.e. visible)
        // Actually: at least WINDOW_KEEP_VISIBLE of the window visible on the LEFT
        // means x <= viewport.width - WINDOW_KEEP_VISIBLE.
        expect(runtime?.x).toBeLessThanOrEqual(1024 - WINDOW_KEEP_VISIBLE);
        // And the window's right edge can be off-screen, but not fully: at least
        // WINDOW_KEEP_VISIBLE must be visible on one side.
        const rightEdgeVisible = 1024 - (runtime!.x);
        const leftEdgeVisible = Math.min(width, Math.max(0, (runtime!.x + width)));
        // Either WINDOW_KEEP_VISIBLE is visible on the right or the window is mostly on-screen.
        expect(Math.max(rightEdgeVisible, leftEdgeVisible)).toBeGreaterThanOrEqual(WINDOW_KEEP_VISIBLE);
    });

    it('dragging a window above the top is clamped to y=0 (windows cannot go under the header)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('win'), 0, {});
        openWindow('mod.mod-a.win');
        setWindowGeometry('mod.mod-a.win', { y: -500 });
        expect(readWindowRuntime('mod.mod-a.win')?.y).toBe(0);
    });

    it('reclampAllWindows pulls stranded windows back into a shrunk viewport', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('win'), 0, {});
        openWindow('mod.mod-a.win');
        // Park the window at the right edge of a 1024-wide viewport.
        setWindowGeometry('mod.mod-a.win', { x: 100000 });
        const before = readWindowRuntime('mod.mod-a.win')!;
        expect(before.x).toBeLessThanOrEqual(1024 - WINDOW_KEEP_VISIBLE);
        // Shrink the viewport.
        Object.defineProperty(window, 'innerWidth', { writable: true, configurable: true, value: 400 });
        Object.defineProperty(window, 'innerHeight', { writable: true, configurable: true, value: 300 });
        reclampAllWindows({ width: 400, height: 300 });
        const after = readWindowRuntime('mod.mod-a.win')!;
        // After the shrink, the window must be re-clamped into the new viewport.
        expect(after.x).toBeLessThanOrEqual(400 - WINDOW_KEEP_VISIBLE);
        expect(after.width).toBeLessThanOrEqual(400);
        expect(after.height).toBeLessThanOrEqual(300);
    });

    it('reclampAllWindows is a no-op when no windows are open', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('win'), 0, {});
        // No window open; reclamp should not throw and not notify.
        expect(() => reclampAllWindows({ width: 100, height: 100 })).not.toThrow();
    });

    it('a non-resizable window still respects setWindowGeometry (the flag is enforced in the UI)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, {
            id: 'fixed',
            title: 'Fixed',
            defaultSize: { width: 200, height: 150 },
            resizable: false,
            mount: () => undefined,
        }, 0, {});
        openWindow('mod.mod-a.fixed');
        setWindowGeometry('mod.mod-a.fixed', { width: 600 });
        // The store does not enforce `resizable`; the React layer hides the
        // resize handles. A programmatic call still clamps + persists.
        expect(readWindowRuntime('mod.mod-a.fixed')?.width).toBe(600);
    });
});

describe('Phase 4.5 — window store: minimize', () => {
    it('setMinimized toggles the flag and persists', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('win'), 0, {});
        openWindow('mod.mod-a.win');
        setMinimized('mod.mod-a.win', true);
        expect(readWindowRuntime('mod.mod-a.win')?.minimized).toBe(true);
        setMinimized('mod.mod-a.win', false);
        expect(readWindowRuntime('mod.mod-a.win')?.minimized).toBe(false);
    });

    it('setMinimized on an unknown id is a no-op', () => {
        expect(() => setMinimized('mod.mod-a.unknown', true)).not.toThrow();
    });
});

describe('Phase 4.5 — window store: persistence (§8.7)', () => {
    it('opening a window persists geometry + open=true under mod.<modId>.<windowId>', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        openWindow('mod.mod-a.editor');
        const raw = localStorage.getItem(STORAGE_PREFIX + 'mod.mod-a.editor');
        expect(raw).not.toBeNull();
        const parsed = JSON.parse(raw!) as { open: boolean; x: number; y: number; width: number; height: number };
        expect(parsed.open).toBe(true);
        expect(typeof parsed.x).toBe('number');
        expect(typeof parsed.width).toBe('number');
    });

    it('closing a window persists open=false (geometry is retained)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        openWindow('mod.mod-a.editor');
        closeWindow('mod.mod-a.editor');
        const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'mod.mod-a.editor')!) as { open: boolean };
        expect(parsed.open).toBe(false);
    });

    it('minimize state is persisted', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        openWindow('mod.mod-a.editor');
        setMinimized('mod.mod-a.editor', true);
        const parsed = JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'mod.mod-a.editor')!) as { minimized: boolean };
        expect(parsed.minimized).toBe(true);
    });

    it('a declaration re-opened on next session auto-opens when persisted.open is true (§8.7)', () => {
        // Simulate a previous session that left the window open.
        localStorage.setItem(STORAGE_PREFIX + 'mod.mod-a.editor', JSON.stringify({
            x: 100, y: 100, width: 320, height: 240, open: true, minimized: false,
        }));
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        // The declaration should have auto-opened the window.
        expect(readWindowRuntime('mod.mod-a.editor')).toBeDefined();
        expect(readWindowState().open.has('mod.mod-a.editor')).toBe(true);
    });

    it('a declaration NOT open last session does not auto-open', () => {
        localStorage.setItem(STORAGE_PREFIX + 'mod.mod-a.editor', JSON.stringify({
            x: 100, y: 100, width: 320, height: 240, open: false, minimized: false,
        }));
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        expect(readWindowRuntime('mod.mod-a.editor')).toBeUndefined();
    });

    it('a corrupted persisted record is treated as absent (no fault, no auto-open)', () => {
        localStorage.setItem(STORAGE_PREFIX + 'mod.mod-a.editor', '{not json');
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        expect(readWindowRuntime('mod.mod-a.editor')).toBeUndefined();
    });

    it('a persisted record with non-finite numbers is treated as absent', () => {
        localStorage.setItem(STORAGE_PREFIX + 'mod.mod-a.editor', JSON.stringify({
            x: Number.NaN, y: 0, width: 320, height: 240, open: true, minimized: false,
        }));
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        expect(readWindowRuntime('mod.mod-a.editor')).toBeUndefined();
    });
});

describe('Phase 4.5 — window store: host-owned teardown (§8.5)', () => {
    it('disableModWindows removes every declaration + open window for one mod', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('b'), 0, {});
        registerWindowDeclaration(MOD_B.id, MOD_B.name, noopDeclaration('c'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-b.c');
        const removed = disableModWindows(MOD_A.id);
        expect(removed).toBe(2);
        expect(readDeclaredWindow('mod.mod-a.a')).toBeUndefined();
        expect(readDeclaredWindow('mod.mod-a.b')).toBeUndefined();
        expect(readDeclaredWindow('mod.mod-b.c')).toBeDefined();
        expect(readWindowRuntime('mod.mod-a.a')).toBeUndefined();
        expect(readWindowRuntime('mod.mod-b.c')).toBeDefined();
    });

    it('disableModWindows refocuses the next-highest remaining window', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_B.id, MOD_B.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-b.b');
        // b is focused (opened last). Disabling a leaves b focused.
        disableModWindows(MOD_A.id);
        expect(readWindowState().focusedId).toBe('mod.mod-b.b');
    });

    it('disableModWindows for an unknown mod is a no-op returning 0', () => {
        expect(disableModWindows('unknown')).toBe(0);
    });

    it('clearAllWindowsWindows clears every declaration + open window', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        registerWindowDeclaration(MOD_B.id, MOD_B.name, noopDeclaration('b'), 0, {});
        openWindow('mod.mod-a.a');
        openWindow('mod.mod-b.b');
        clearAllWindowsWindows();
        expect(readDeclaredWindows()).toHaveLength(0);
        expect(readWindowState().open.size).toBe(0);
        expect(readWindowState().focusedId).toBeNull();
    });

    it('disableModWindows does NOT clear persisted geometry (Phase 6.4 — disable=freeze)', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('editor'), 0, {});
        openWindow('mod.mod-a.editor');
        setWindowGeometry('mod.mod-a.editor', { x: 123, y: 45 });
        disableModWindows(MOD_A.id);
        // Persistence remains — a re-enable should find the old geometry.
        const persisted = JSON.parse(localStorage.getItem(STORAGE_PREFIX + 'mod.mod-a.editor')!) as { x: number; y: number };
        expect(persisted.x).toBe(123);
        expect(persisted.y).toBe(45);
    });
});

describe('Phase 4.5 — window store: subscription + z counter', () => {
    it('subscribeToWindows fires on open, close, and focus', () => {
        let notifications = 0;
        const unsubscribe = subscribeToWindows(() => { notifications += 1; });
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        openWindow('mod.mod-a.a');
        focusWindow('mod.mod-a.a');
        closeWindow('mod.mod-a.a');
        expect(notifications).toBeGreaterThan(0);
        unsubscribe();
    });

    it('the z counter starts at WINDOW_Z_BASE and only goes up', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        openWindow('mod.mod-a.a');
        const z1 = readWindowRuntime('mod.mod-a.a')!.z;
        expect(z1).toBeGreaterThan(WINDOW_Z_BASE);
        openWindow('mod.mod-a.a');
        const z2 = readWindowRuntime('mod.mod-a.a')!.z;
        expect(z2).toBeGreaterThan(z1);
    });

    it('a listener that throws does not break the notifier', () => {
        registerWindowDeclaration(MOD_A.id, MOD_A.name, noopDeclaration('a'), 0, {});
        subscribeToWindows(() => { throw new Error('boom'); });
        // The mutation must still complete; the throwing listener is contained.
        expect(() => openWindow('mod.mod-a.a')).not.toThrow();
        expect(readWindowRuntime('mod.mod-a.a')).toBeDefined();
    });
});
