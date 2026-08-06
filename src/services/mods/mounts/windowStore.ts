/**
 * Phase 4.5 — the floating window manager store.
 *
 * `MOUNTS.md` §2.7 / §4.4 / §8.7: a floating window layer that mods claim.
 * The host owns the chrome (title bar, drag, resize, z-order, focus, close,
 * minimize, bounds clamping); the mod owns the interior. A mod may not
 * render its own title bar and may not set its own z-index — this is what
 * makes §1's "no convincing fake dialog" claim structurally true.
 *
 * The store is module-level singleton, in the same shape as `mountRegistry`:
 * `useSyncExternalStore` is the React read primitive; mutations notify every
 * listener. State is **never mutated in place** — every mutation produces a
 * new snapshot so React's referential equality holds.
 *
 * Three concerns live here:
 *
 *   1. **Declarations** — a mod declares a window once via
 *      `ctx.mounts.window(decl)`. The declaration is the static contract:
 *      id, title, default size, min size, resizable. A declaration is keyed
 *      `mod.<modId>.<windowId>`.
 *   2. **Runtime state** — which declared windows are currently open, plus
 *      their geometry (x, y, width, height), z-order, focus, and minimized
 *      flag. Geometry is clamped to the viewport (§4.5 §3 "bounds clamp on
 *      window resize of the app itself, or windows get stranded off-canvas").
 *   3. **Persistence** — open/closed state plus geometry survive reload, keyed
 *      `mod.<modId>.<windowId>` per `MOUNTS.md` §8.7. A mod disabled and
 *      re-enabled therefore finds its own geometry.
 *
 * Teardown is host-owned (§8.5), same as every other region: `disableModMounts`
 * removes every declaration the mod registered and closes every open window
 * belonging to it — no orphan chrome. The mod is never trusted to call
 * `remove()` or `close()` itself.
 */

import type { WindowDeclaration } from './mountTypes';

/** A minimum below which a window is unusable; respected unless the declaration is smaller. */
export const WINDOW_DEFAULT_MIN_SIZE = Object.freeze({ width: 160, height: 100 });
/** A hard floor on the viewport so a window cannot be dragged fully off-canvas. */
export const WINDOW_KEEP_VISIBLE = 32;
/** Base z-index for the window layer. Focus stacks above this. */
export const WINDOW_Z_BASE = 200;

/**
 * The static shape of a declared window. Built from the mod's
 * `WindowDeclaration` plus its resolved sort key (so the layer can render in
 * declaration order when two windows open in the same tick — §4.4).
 */
export interface DeclaredWindow {
    /** The fully-qualified id: `mod.<modId>.<windowId>`. */
    readonly qualifiedId: string;
    readonly entryId: string;
    readonly modId: string;
    readonly modName: string;
    readonly loadIndex: number;
    readonly withinModIndex: number;
    readonly declaration: WindowDeclaration;
    readonly context: unknown;
    /** Effective minimum size — the declaration's `minSize` or the default floor. */
    readonly minSize: { readonly width: number; readonly height: number };
    /** Effective `resizable` flag — the declaration's value, defaulting to true. */
    readonly resizable: boolean;
}

/**
 * The runtime geometry + focus state of an open window. Stored separately
 * from the declaration so closing and reopening a window can preserve
 * geometry across the close (and across reloads, via persistence).
 */
export interface WindowRuntime {
    readonly qualifiedId: string;
    /** Top-left position in viewport pixels. Clamped to keep `WINDOW_KEEP_VISIBLE` on-screen. */
    readonly x: number;
    readonly y: number;
    /** Current size; never below `DeclaredWindow.minSize`. */
    readonly width: number;
    readonly height: number;
    /** Monotonic z counter; higher means on top. The host is the only thing that sets this. */
    readonly z: number;
    /** True when the window is iconified to a title bar only. */
    readonly minimized: boolean;
    /** True when this window holds focus (top of the z stack and not minimized). */
    readonly focused: boolean;
}

/** The persisted shape per `MOUNTS.md` §8.7 — geometry + open/closed. */
interface PersistedWindow {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
    readonly open: boolean;
    readonly minimized: boolean;
}

interface WindowStoreState {
    /** Static declarations, keyed by qualifiedId. Ordered by (loadIndex, withinModIndex). */
    readonly declared: ReadonlyMap<string, DeclaredWindow>;
    /** Runtime state for currently-open windows, keyed by qualifiedId. */
    readonly open: ReadonlyMap<string, WindowRuntime>;
    /** Monotonic z counter — the last z handed out. */
    readonly zCounter: number;
    /** The currently-focused window's qualifiedId, or null. */
    readonly focusedId: string | null;
}

const listeners = new Set<() => void>();

function notify(): void {
    for (const listener of [...listeners]) {
        try { listener(); } catch { /* a render listener must not break a mutation */ }
    }
}

let state: WindowStoreState = {
    declared: new Map(),
    open: new Map(),
    zCounter: WINDOW_Z_BASE,
    focusedId: null,
};

/**
 * Read the current snapshot. Referential identity is stable across mutations
 * only when the caller-relevant slice actually changed (every mutation builds
 * a new state object; React's `useSyncExternalStore` re-renders on identity
 * change).
 */
export function readWindowState(): WindowStoreState {
    return state;
}

function compareDeclared(a: DeclaredWindow, b: DeclaredWindow): number {
    if (a.loadIndex !== b.loadIndex) return a.loadIndex - b.loadIndex;
    return a.withinModIndex - b.withinModIndex;
}

/** Read only the declared windows in `(loadIndex, withinModIndex)` order. */
export function readDeclaredWindows(): readonly DeclaredWindow[] {
    return [...state.declared.values()].sort(compareDeclared);
}

/**
 * The cached derived "open windows" snapshot. `useSyncExternalStore` requires
 * a referentially-stable return from `getSnapshot` — `readOpenWindows` would
 * otherwise build a new array on every call and trigger an infinite re-render.
 * The cache is invalidated whenever `state` identity changes (every mutation
 * builds a new state object), so the cached array is always consistent with
 * the state the caller would read. Same pattern any derived selector for
 * `useSyncExternalStore` needs.
 */
let openWindowsCache: { forState: WindowStoreState; value: readonly DeclaredWindow[] } | null = null;

/** Read only the open windows in `(loadIndex, withinModIndex)` order. */
export function readOpenWindows(): readonly DeclaredWindow[] {
    if (!openWindowsCache || openWindowsCache.forState !== state) {
        openWindowsCache = {
            forState: state,
            value: [...state.declared.values()]
                .filter((w) => state.open.has(w.qualifiedId))
                .sort(compareDeclared),
        };
    }
    return openWindowsCache.value;
}

/** Subscribe to the store — React uses this from `useSyncExternalStore`. */
export function subscribeToWindows(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

// ─── Persistence ───────────────────────────────────────────────────────────
//
// Per `MOUNTS.md` §8.7: geometry and open/closed are keyed
// `mod.<modId>.<windowId>`. The persistence namespace is fixed here so a key
// outlives the phase that chose the store; the storage backend is localStorage
// to match `ChatRightRail`'s `nn_chat_rail` (4.3's ruling: match what the app
// already does). Best-effort — a private window or a full quota does not
// prevent the session from working.

const PERSIST_PREFIX = 'nn_mod_window.';

function persistKey(qualifiedId: string): string {
    return PERSIST_PREFIX + qualifiedId;
}

function readPersisted(qualifiedId: string): PersistedWindow | null {
    if (typeof window === 'undefined') return null;
    try {
        const raw = window.localStorage.getItem(persistKey(qualifiedId));
        if (!raw) return null;
        const parsed = JSON.parse(raw) as Partial<PersistedWindow>;
        if (
            typeof parsed.x !== 'number' || !Number.isFinite(parsed.x) ||
            typeof parsed.y !== 'number' || !Number.isFinite(parsed.y) ||
            typeof parsed.width !== 'number' || !Number.isFinite(parsed.width) ||
            typeof parsed.height !== 'number' || !Number.isFinite(parsed.height)
        ) return null;
        return {
            x: parsed.x,
            y: parsed.y,
            width: parsed.width,
            height: parsed.height,
            open: parsed.open === true,
            minimized: parsed.minimized === true,
        };
    } catch {
        return null;
    }
}

function writePersisted(qualifiedId: string, persisted: PersistedWindow): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(persistKey(qualifiedId), JSON.stringify(persisted));
    } catch {
        // Storage may be unavailable (private window, quota). The session
        // remains usable; persistence is best-effort.
    }
}

// ─── Geometry helpers ──────────────────────────────────────────────────────

function clampGeometries(
    viewport: { width: number; height: number },
    declared: DeclaredWindow,
    runtime: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
    // Size first: clamp to the declaration's effective min, and to the viewport.
    const minW = Math.min(declared.minSize.width, viewport.width);
    const minH = Math.min(declared.minSize.height, viewport.height);
    const width = Math.max(minW, Math.min(runtime.width, viewport.width));
    const height = Math.max(minH, Math.min(runtime.height, viewport.height));
    // Position: keep at least `WINDOW_KEEP_VISIBLE` pixels of the window
    // visible on each axis so it cannot be dragged fully off-canvas and
    // lost. The window's left edge may go as far negative as
    // `WINDOW_KEEP_VISIBLE - width` (most of the window off-screen to the
    // left, but `WINDOW_KEEP_VISIBLE` still visible on the right edge), and
    // as far positive as `viewport.width - WINDOW_KEEP_VISIBLE` (most of
    // the window off-screen to the right, but `WINDOW_KEEP_VISIBLE` still
    // visible on the left edge). Symmetric on Y, but the top is pinned to
    // >= 0 so a window cannot slide under the header.
    const lowerX = WINDOW_KEEP_VISIBLE - width;
    const upperX = viewport.width - WINDOW_KEEP_VISIBLE;
    const x = Math.max(lowerX, Math.min(runtime.x, upperX));
    const upperY = Math.max(0, viewport.height - WINDOW_KEEP_VISIBLE);
    const y = Math.max(0, Math.min(runtime.y, upperY));
    return {
        x: Math.round(x),
        y: Math.round(y),
        width: Math.round(width),
        height: Math.round(height),
    };
}

/** Re-clamp every open window against the current viewport. Used on app resize. */
export function reclampAllWindows(viewport: { width: number; height: number }): void {
    if (state.open.size === 0) return;
    const nextOpen = new Map<string, WindowRuntime>();
    let changed = false;
    for (const [id, runtime] of state.open) {
        const declared = state.declared.get(id);
        if (!declared) continue;
        const clamped = clampGeometries(viewport, declared, runtime);
        if (
            clamped.x !== runtime.x || clamped.y !== runtime.y ||
            clamped.width !== runtime.width || clamped.height !== runtime.height
        ) changed = true;
        nextOpen.set(id, { ...runtime, ...clamped });
        writePersisted(id, {
            x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height,
            open: true, minimized: runtime.minimized,
        });
    }
    if (changed) {
        state = { ...state, open: nextOpen };
        notify();
    }
}

// ─── Mutations ─────────────────────────────────────────────────────────────

/**
 * Register a window declaration. Mirrors `registerModRail` /
 * `registerModMessageBelow` in `mountRegistry.ts`: enforces the per-mod
 * budget (declared windows, not open ones — §5), the duplicate-id check, and
 * the revoked-lease check. Never throws; over-budget / duplicate / revoked
 * return `null` and the caller (the `ctx.mounts.window` shim) returns a no-op
 * handle.
 *
 * Auto-opens the window if the persisted state says it was open last session
 * (`MOUNTS.md` §8.7 — "geometry and open/closed survive reload"). A declared
 * but never-opened window is not in the open map; `WindowHandle.open()` puts
 * it there.
 */
export function registerWindowDeclaration(
    modId: string,
    modName: string,
    declaration: WindowDeclaration,
    loadIndex: number,
    context: unknown,
    options: {
        withinModIndex?: number;
        /** Caller-supplied budget gate — the registry tracks per-mod counts. */
        declaredCount?: number;
        budget?: number;
        revoked?: boolean;
        faultFile?: string;
    } = {},
): DeclaredWindow | null {
    if (options.revoked === true) return null;
    const budget = options.budget ?? Infinity;
    if ((options.declaredCount ?? 0) >= budget) return null;

    const qualifiedId = `mod.${modId}.${declaration.id}`;
    if (state.declared.has(qualifiedId)) return null;

    const minSize = declaration.minSize ?? WINDOW_DEFAULT_MIN_SIZE;
    const resizable = declaration.resizable !== false;
    const withinModIndex = options.withinModIndex ?? state.declared.size;
    const declared: DeclaredWindow = Object.freeze({
        qualifiedId,
        entryId: declaration.id,
        modId,
        modName,
        loadIndex,
        withinModIndex,
        declaration,
        context,
        minSize: Object.freeze({ width: minSize.width, height: minSize.height }),
        resizable,
    });

    const nextDeclared = new Map(state.declared);
    nextDeclared.set(qualifiedId, declared);

    // Auto-open if persisted state says the window was open last session.
    // The geometry comes from the persisted record, clamped to the viewport.
    const nextOpen = new Map(state.open);
    const persisted = readPersisted(qualifiedId);
    let nextZ = state.zCounter;
    let nextFocusedId = state.focusedId;
    if (persisted?.open) {
        const viewport = currentViewport();
        const geometry = clampGeometries(viewport, declared, persisted);
        nextZ += 1;
        nextOpen.set(qualifiedId, {
            qualifiedId,
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            z: nextZ,
            minimized: persisted.minimized,
            focused: true,
        });
        // Defocus everything else — only one window is focused at a time.
        for (const [id, runtime] of nextOpen) {
            if (id !== qualifiedId && runtime.focused) {
                nextOpen.set(id, { ...runtime, focused: false });
            }
        }
        nextFocusedId = qualifiedId;
    }

    state = {
        declared: nextDeclared,
        open: nextOpen,
        zCounter: nextZ,
        focusedId: nextFocusedId,
    };
    notify();
    return declared;
}

function currentViewport(): { width: number; height: number } {
    if (typeof window === 'undefined') return { width: 1024, height: 768 };
    return { width: window.innerWidth, height: window.innerHeight };
}

/** Remove a declaration. Also closes its window if open. */
export function unregisterWindowDeclaration(qualifiedId: string): void {
    if (!state.declared.has(qualifiedId)) return;
    const nextDeclared = new Map(state.declared);
    nextDeclared.delete(qualifiedId);
    const nextOpen = new Map(state.open);
    nextOpen.delete(qualifiedId);
    let nextFocusedId = state.focusedId;
    if (nextFocusedId === qualifiedId) nextFocusedId = null;
    state = {
        declared: nextDeclared,
        open: nextOpen,
        zCounter: state.zCounter,
        focusedId: nextFocusedId,
    };
    notify();
}

/** Open a declared window. If already open, focuses it. */
export function openWindow(qualifiedId: string): void {
    const declared = state.declared.get(qualifiedId);
    if (!declared) return;
    const existing = state.open.get(qualifiedId);
    const nextOpen = new Map(state.open);
    const nextZ = state.zCounter + 1;

    if (existing) {
        // Already open: just focus + un-minimize.
        const updated: WindowRuntime = {
            ...existing,
            z: nextZ,
            minimized: false,
            focused: true,
        };
        nextOpen.set(qualifiedId, updated);
        writePersisted(qualifiedId, {
            x: existing.x, y: existing.y, width: existing.width, height: existing.height,
            open: true, minimized: false,
        });
    } else {
        // First open: use persisted geometry or default, clamped to viewport.
        const persisted = readPersisted(qualifiedId);
        const viewport = currentViewport();
        const startGeometry = persisted
            ? { x: persisted.x, y: persisted.y, width: persisted.width, height: persisted.height }
            : defaultGeometryFor(declared, viewport);
        const geometry = clampGeometries(viewport, declared, startGeometry);
        const opened: WindowRuntime = {
            qualifiedId,
            x: geometry.x,
            y: geometry.y,
            width: geometry.width,
            height: geometry.height,
            z: nextZ,
            minimized: false,
            focused: true,
        };
        nextOpen.set(qualifiedId, opened);
        writePersisted(qualifiedId, {
            x: geometry.x, y: geometry.y, width: geometry.width, height: geometry.height,
            open: true, minimized: false,
        });
    }

    // Defocus every other window.
    for (const [id, runtime] of nextOpen) {
        if (id !== qualifiedId && runtime.focused) {
            nextOpen.set(id, { ...runtime, focused: false });
        }
    }

    state = {
        declared: state.declared,
        open: nextOpen,
        zCounter: nextZ,
        focusedId: qualifiedId,
    };
    notify();
}

/**
 * Pick a sensible default position for a freshly-opened window. Cascades
 * windows opened in sequence so they don't stack exactly on top of each
 * other (which would make the title bar of the one below unreachable).
 */
function defaultGeometryFor(
    declared: DeclaredWindow,
    viewport: { width: number; height: number },
): { x: number; y: number; width: number; height: number } {
    const width = Math.min(declared.declaration.defaultSize.width, viewport.width);
    const height = Math.min(declared.declaration.defaultSize.height, viewport.height);
    // Cascade by open count, modulo a small offset, so windows opened in
    // sequence are each offset by 24px rather than perfectly stacked.
    const cascade = (state.open.size % 6) * 24;
    const x = Math.max(0, Math.min(viewport.width - width, cascade + 40));
    const y = Math.max(0, Math.min(viewport.height - height, cascade + 40));
    return { x, y, width, height };
}

/** Close a window. Persisted as closed; the geometry is retained so a reopen is where it was. */
export function closeWindow(qualifiedId: string): void {
    const runtime = state.open.get(qualifiedId);
    if (!runtime) return;
    const nextOpen = new Map(state.open);
    nextOpen.delete(qualifiedId);
    writePersisted(qualifiedId, {
        x: runtime.x, y: runtime.y, width: runtime.width, height: runtime.height,
        open: false, minimized: runtime.minimized,
    });
    let nextFocusedId = state.focusedId;
    if (nextFocusedId === qualifiedId) {
        // Focus the next-highest-z remaining window, if any.
        let best: WindowRuntime | null = null;
        for (const remaining of nextOpen.values()) {
            if (!best || remaining.z > best.z) best = remaining;
        }
        if (best) {
            nextOpen.set(best.qualifiedId, { ...best, focused: true });
            nextFocusedId = best.qualifiedId;
        } else {
            nextFocusedId = null;
        }
    }
    state = {
        declared: state.declared,
        open: nextOpen,
        zCounter: state.zCounter,
        focusedId: nextFocusedId,
    };
    notify();
}

/** Focus a window (raise it to the top of the z stack). No-op if not open. */
export function focusWindow(qualifiedId: string): void {
    const runtime = state.open.get(qualifiedId);
    if (!runtime) return;
    if (runtime.focused && state.focusedId === qualifiedId) return;
    const nextZ = state.zCounter + 1;
    const nextOpen = new Map(state.open);
    for (const [id, r] of nextOpen) {
        if (id === qualifiedId) {
            nextOpen.set(id, { ...r, z: nextZ, focused: true });
        } else if (r.focused) {
            nextOpen.set(id, { ...r, focused: false });
        }
    }
    state = {
        declared: state.declared,
        open: nextOpen,
        zCounter: nextZ,
        focusedId: qualifiedId,
    };
    notify();
}

/** Toggle or set the minimized flag. A minimized window keeps its z but is rendered as a bar only. */
export function setMinimized(qualifiedId: string, minimized: boolean): void {
    const runtime = state.open.get(qualifiedId);
    if (!runtime) return;
    if (runtime.minimized === minimized) return;
    const nextOpen = new Map(state.open);
    nextOpen.set(qualifiedId, { ...runtime, minimized });
    writePersisted(qualifiedId, {
        x: runtime.x, y: runtime.y, width: runtime.width, height: runtime.height,
        open: true, minimized,
    });
    state = {
        declared: state.declared,
        open: nextOpen,
        zCounter: state.zCounter,
        focusedId: state.focusedId,
    };
    notify();
}

/** Update a window's geometry (from a drag or resize). Clamps to viewport + min size. */
export function setWindowGeometry(
    qualifiedId: string,
    next: { x?: number; y?: number; width?: number; height?: number },
): void {
    const runtime = state.open.get(qualifiedId);
    const declared = state.declared.get(qualifiedId);
    if (!runtime || !declared) return;
    const proposed = {
        x: next.x ?? runtime.x,
        y: next.y ?? runtime.y,
        width: next.width ?? runtime.width,
        height: next.height ?? runtime.height,
    };
    const viewport = currentViewport();
    const clamped = clampGeometries(viewport, declared, proposed);
    const nextOpen = new Map(state.open);
    nextOpen.set(qualifiedId, { ...runtime, ...clamped });
    writePersisted(qualifiedId, {
        x: clamped.x, y: clamped.y, width: clamped.width, height: clamped.height,
        open: true, minimized: runtime.minimized,
    });
    state = {
        declared: state.declared,
        open: nextOpen,
        zCounter: state.zCounter,
        focusedId: state.focusedId,
    };
    notify();
}

// ─── Teardown ──────────────────────────────────────────────────────────────

/**
 * `MOUNTS.md` §8.5 — host-owned teardown. `disableModMounts` calls this for
 * the window region. Removes every declaration the mod registered and closes
 * every open window belonging to it. No orphan chrome.
 *
 * Returns the number of declarations removed (so `disableModMounts`'s
 * existing bookkeeping can include this region in its count, matching the
 * shape it already has for chrome / rail / message.below).
 *
 * Does NOT clear persisted geometry — that is Phase 6.4's data-on-disable
 * policy decision ("disable = freeze", per the 6.4 ruling in PROGRESS.md).
 * A mod disabled and re-enabled therefore finds its own geometry.
 */
export function disableModWindows(modId: string): number {
    const toRemove: string[] = [];
    for (const declared of state.declared.values()) {
        if (declared.modId === modId) toRemove.push(declared.qualifiedId);
    }
    if (toRemove.length === 0) return 0;
    const nextDeclared = new Map(state.declared);
    const nextOpen = new Map(state.open);
    for (const id of toRemove) {
        nextDeclared.delete(id);
        nextOpen.delete(id);
    }
    let nextFocusedId = state.focusedId;
    if (nextFocusedId && !nextOpen.has(nextFocusedId)) {
        let best: WindowRuntime | null = null;
        for (const remaining of nextOpen.values()) {
            if (!best || remaining.z > best.z) best = remaining;
        }
        if (best) {
            nextOpen.set(best.qualifiedId, { ...best, focused: true });
            nextFocusedId = best.qualifiedId;
        } else {
            nextFocusedId = null;
        }
    }
    state = {
        declared: nextDeclared,
        open: nextOpen,
        zCounter: state.zCounter,
        focusedId: nextFocusedId,
    };
    notify();
    return toRemove.length;
}

/** Clear all declarations + open windows. Test/teardown only (mirrors `clearAllModMounts`). */
export function clearAllWindowsWindows(): void {
    if (state.declared.size === 0 && state.open.size === 0) return;
    state = {
        declared: new Map(),
        open: new Map(),
        zCounter: WINDOW_Z_BASE,
        focusedId: null,
    };
    notify();
}

/** Test helper: the number of declarations a mod has registered. */
export function getModWindowCount(modId: string): number {
    let count = 0;
    for (const declared of state.declared.values()) {
        if (declared.modId === modId) count += 1;
    }
    return count;
}

/** Test helper: read a declared window by qualified id. */
export function readDeclaredWindow(qualifiedId: string): DeclaredWindow | undefined {
    return state.declared.get(qualifiedId);
}

/** Test helper: read an open window's runtime by qualified id. */
export function readWindowRuntime(qualifiedId: string): WindowRuntime | undefined {
    return state.open.get(qualifiedId);
}
