/**
 * Phase 4.2 — register the composer action strip's built-in buttons with
 * the mount registry (`MOUNTS.md` §2.3).
 *
 * The row above the composer at `src/components/chat/ChatActionStrip.tsx:48`
 * is the `composer.actions` region. Nine buttons live there today: Save,
 * Trim, Deep Search, Dice Me, Roll Loot, One-Shot, Absolute Command, Ask
 * GM, Archive.
 *
 * The trailing group is `archive` (§3.3): it is `ml-auto`-pinned
 * (`ChatActionStrip.tsx:164`), so anything after it renders right of a
 * right-aligned control and the row reads as broken. Mod entries insert
 * *before* the trailing group.
 *
 * Each built-in keeps its bespoke renderer (§8.2). `ChatActionStrip.tsx`
 * reads the registry's ordered ids and renders each built-in with its
 * existing markup; mod entries render through the generic chrome renderer.
 *
 * Registered ONCE at module load. Idempotent on a second import.
 */
import { registerBuiltin, __registerBuiltinGuardReset } from './mountRegistry';

/**
 * The built-in composer action ids, in the order they must render. The
 * trailing group (`archive`) is recorded in the registry's region store and
 * sorts last within the built-ins (§3.3).
 *
 * `travel` (WO 3.1) sits between `absoluteCommand` and `askGm` — it is the
 * app's central verb and belongs in the same row as the other "start a
 * structured action" buttons.
 *
 * The parked "Inject Arc" button is NOT in this list — it returns in 4.2 as
 * a mod-claimed `composer.actions` entry the arc mod registers from its
 * `activate` hook (MOUNTS.md §2.3, where `mods/arc/compute.js:14-20` always
 * said it belonged).
 */
export const COMPOSER_BUILTIN_IDS = Object.freeze([
    'save',
    'trim',
    'deepSearch',
    'diceMe',
    'rollLoot',
    'oneShot',
    'absoluteCommand',
    'travel',
    'askGm',
    'archive',
] as const);

let registered = false;

/**
 * Register the composer strip's built-in actions. Idempotent: a second call
 * is a no-op (the registry keeps the first registration). Safe to call at
 * module load.
 */
export function registerComposerBuiltins(): void {
    if (registered) return;
    registered = true;
    for (const id of COMPOSER_BUILTIN_IDS) {
        registerBuiltin('composer.actions', id, 'builtin');
    }
}

/** The set of built-in composer ids, for an O(1) `isBuiltin` check. */
export const COMPOSER_BUILTIN_ID_SET: ReadonlySet<string> = new Set(COMPOSER_BUILTIN_IDS);

// Wire the guard reset into the registry's test-reset helper.
__registerBuiltinGuardReset(() => {
    registered = false;
});