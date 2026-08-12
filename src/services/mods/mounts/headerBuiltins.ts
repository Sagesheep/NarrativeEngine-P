/**
 * Phase 4.2 — register the header's built-in action buttons with the mount
 * registry (`MOUNTS.md` §2.2).
 *
 * The right-hand action group at `src/components/Header.tsx` is the
 * `header.actions` region. The header keeps only the AI tier control and the
 * trailing settings/exit controls. Campaign editors and mod launchers are
 * reached from the docked context drawer; background control lives in Global
 * settings.
 *
 * The trailing group is `settings` + `exit` (§3.3): leaving the campaign is
 * the last thing in the row; a mod button after "Exit" reads as an accident.
 * Mod entries insert *before* the trailing group.
 *
 * Each built-in keeps its bespoke renderer (§8.2). `Header.tsx` reads the
 * registry's ordered ids and renders each built-in with its existing markup;
 * mod status entries render through the generic chrome renderer.
 *
 * Registered ONCE at module load, before any mod's `activate` runs. The
 * `registerBuiltin` call is idempotent on a second import (the registry
 * keeps the first), so a hot-reload does not double-register.
 */
import { registerBuiltin, __registerBuiltinGuardReset } from './mountRegistry';

/**
 * The built-in header action ids, in the order they must render. This is
 * the single source of truth for the order; the registry preserves it. The
 * trailing group (`settings`, `exit`) is recorded in the registry's region
 * store and sorts last within the built-ins (§3.3).
 *
 * `background` is not a header entry. It is rendered by the Global settings
 * tab, where campaign-wide visual preferences belong.
 */
export const HEADER_BUILTIN_IDS = Object.freeze([
    'aiTier',
    'settings',
    'exit',
] as const);

let registered = false;

/**
 * Register the header's built-in actions. Idempotent: a second call is a
 * no-op (the registry keeps the first registration, so a hot-reload does
 * not double-register). Safe to call at module load.
 */
export function registerHeaderBuiltins(): void {
    if (registered) return;
    registered = true;
    for (const id of HEADER_BUILTIN_IDS) {
        registerBuiltin('header.actions', id, 'builtin');
    }
}

/** Test helper: reset the registration guard so the next call re-registers. */
export function __resetHeaderBuiltinGuard(): void {
    registered = false;
}

// Wire the guard reset into the registry's test-reset helper.
__registerBuiltinGuardReset(() => {
    registered = false;
});

/** The set of built-in header ids, for an O(1) `isBuiltin` check in the renderer. */
export const HEADER_BUILTIN_ID_SET: ReadonlySet<string> = new Set(HEADER_BUILTIN_IDS);

/**
 * The trailing group (§3.3), as a set the row renderer can test against.
 *
 * The registry already sorts these last within the built-ins, so reading the
 * region in order gives the right sequence. `Header.tsx` needs them named
 * separately for a different reason: it renders mod entries as ONE group (see
 * `HeaderModGroup`), which means it has to place that group between the leading
 * built-ins and this trailing pair rather than emitting the region as a flat
 * list. Duplicating the two ids in the component would be a second source of
 * truth for §3.3, so they live here beside the order that defines them.
 */
export const HEADER_TRAILING_ID_SET: ReadonlySet<string> = new Set(['settings', 'exit']);
