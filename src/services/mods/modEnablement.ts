/**
 * The single place the mod enablement rule lives.
 *
 * Before this module there were four independent readers of
 * `settings.moduleEnabled` — `lifecycleHost`, `modBootstrap`, `modAdapter`'s
 * push into the payload registry, and `ExtensionsTab`'s checkbox — each
 * spelling the predicate inline as `enablement[id] !== false`. Four copies of
 * one rule is three chances to disagree, and the checkbox disagreeing with the
 * prompt is the specific bug `ExtensionsTab`'s header warns about. So: one
 * function, imported by all four.
 *
 * THE RULE, in two halves:
 *
 *  1. ABSENT MEANS ENABLED, for a normal mod. Installing a mod is the act of
 *     enabling it; nobody drops a folder in `mods/` and then goes looking for a
 *     switch. The map holds exceptions, not the roster.
 *
 *  2. ABSENT MEANS DISABLED, for a `dev` mod. A fixture exists to exercise the
 *     API — it writes debug rows under every message, claims header buttons,
 *     and pushes probe records into campaign tables. That is correct behaviour
 *     for a test and inexcusable in a player's chat log. Requiring an explicit
 *     opt-in lets the fixtures stay in the repo (they are the cross-phase mount
 *     regression suite) without shipping their output to anyone who never asked
 *     for it.
 *
 * Both halves key off `mod.<id>` in the same map, so nothing about persistence,
 * migration, or the settings shape changes — only which absence means what.
 */

import type { ValidatedMod } from './modTypes';

/** The enablement map — `settings.moduleEnabled`, keyed by `mod.<id>`. */
export type ModEnablementMap = Record<string, boolean>;

/**
 * The subset of a mod this rule needs. Taking a structural type rather than a
 * full `ValidatedMod` keeps the tests (and the settings UI's row objects) from
 * having to build a whole mod to ask one question.
 */
export interface ModEnablementSubject {
    id: string;
    dev?: boolean;
}

/** The settings key a mod's switch is stored under. */
export function modEnablementKey(modId: string): string {
    return `mod.${modId}`;
}

/**
 * Is this mod enabled, given the map?
 *
 * This is the predicate. `payloadBuilder` still applies its own
 * `moduleEnabled?.[id] !== false` to contribution modules by bare id — it has
 * no idea what a mod is, deliberately (see `extensions.ts` on dependency
 * direction). `modBootstrap` therefore filters dev mods out of the push rather
 * than relying on the payload layer to know the second half of the rule.
 */
export function isModEnabled(
    mod: ModEnablementSubject,
    enablement: ModEnablementMap | undefined,
): boolean {
    const explicit = enablement?.[modEnablementKey(mod.id)];
    return mod.dev ? explicit === true : explicit !== false;
}

/**
 * What this mod's switch reads with nothing written — the position "Reset to
 * defaults" returns it to, and the one `ExtensionsTab` compares against to
 * decide whether the reset button has anything to do.
 */
export function modDefaultEnabled(mod: ModEnablementSubject): boolean {
    return !mod.dev;
}

/** Filter to the enabled mods, preserving the loader's resolved order. */
export function enabledMods(
    mods: readonly ValidatedMod[],
    enablement: ModEnablementMap | undefined,
): ValidatedMod[] {
    return mods.filter((mod) => isModEnabled(mod, enablement));
}
