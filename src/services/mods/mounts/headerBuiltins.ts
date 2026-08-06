/**
 * Phase 4.2 — register the header's built-in action buttons with the mount
 * registry (`MOUNTS.md` §2.2).
 *
 * The right-hand action group at `src/components/Header.tsx:83` is the
 * `header.actions` region. Eleven buttons live there today: manual backup,
 * backups, PC panel, NPC ledger, enemies, places, block view, AI tier,
 * pinned, settings, exit. Plus `<BackgroundControl />` at `:84`, which is
 * not a button and stays outside the registry (it is a host-rendered
 * component that lives in the row, not a chrome entry).
 *
 * The trailing group is `settings` + `exit` (§3.3): leaving the campaign is
 * the last thing in the row; a mod button after "Exit" reads as an accident.
 * Mod entries insert *before* the trailing group.
 *
 * Each built-in keeps its bespoke renderer (§8.2) — forcing eleven bespoke
 * buttons through one generic renderer is how the zero-mod pixel-identity
 * rule gets lost. `Header.tsx` reads the registry's ordered ids and renders
 * each built-in with its existing markup; mod entries render through the
 * generic chrome renderer in `HeaderActions.tsx`.
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
 * `background` is NOT in this list — `<BackgroundControl />` is a host
 * component that renders at the start of the row, not a chrome entry. It
 * stays in `Header.tsx`'s JSX, outside the region's render loop, so the
 * zero-mod DOM is byte-identical.
 */
export const HEADER_BUILTIN_IDS = Object.freeze([
    'backup',
    'backups',
    'character',
    'npcLedger',
    'enemies',
    'places',
    'blockView',
    'aiTier',
    'pinned',
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