import { createFinalUserRegistry } from './builtins';
import type { FinalUserModuleInput } from './builtins';
import type { ContributionModule, ContributionRegistry } from './registry';

/**
 * Project 2 — the registration point for non-built-in contribution modules.
 *
 * DEPENDENCY DIRECTION, deliberately: the mod layer PUSHES modules in here; the payload layer
 * never imports `services/mods`. `payloadBuilder` therefore has no idea what a mod is — it asks
 * for a registry and assembles whatever comes back. That is the same discipline as the arbiter's
 * no-feature-names rule, applied one level up.
 *
 * This module holds process-wide state, which the rest of Project 1/2 works hard to avoid. The
 * distinction is deliberate: this is *configuration* (which files are installed on disk), not
 * per-turn or per-campaign *state*. Nothing here changes during a turn, and the registry itself
 * is still constructed fresh on every call so no mutable registry is ever shared.
 */

let extraModules: readonly ContributionModule<FinalUserModuleInput>[] = [];

/**
 * Replace the set of non-built-in modules. Idempotent — call it again after a mod is installed,
 * removed, or edited. Passing `[]` returns the app to built-ins only.
 */
export function setExtensionModules(
    modules: readonly ContributionModule<FinalUserModuleInput>[],
): void {
    // Defensive copy: the caller must not be able to mutate what the next turn will assemble.
    extraModules = [...modules];
}

/** The currently registered non-built-in modules. For the extensions screen. */
export function getExtensionModules(): readonly ContributionModule<FinalUserModuleInput>[] {
    return extraModules;
}

/**
 * A fresh registry containing the built-ins plus whatever extensions are installed.
 *
 * This is `buildPayload`'s default. With nothing installed it is exactly `createFinalUserRegistry()`,
 * which is what makes "mods off = today's app" true by construction rather than by testing.
 *
 * A module whose id collides with a built-in is SKIPPED rather than allowed to throw — a bad mod
 * must never be able to break the turn loop. Ids are already namespaced `mod.<id>` by the adapter,
 * so a collision means something is badly wrong and the safe response is to ignore it.
 */
export function createFinalUserRegistryWithExtensions(): ContributionRegistry<FinalUserModuleInput> {
    const registry = createFinalUserRegistry();
    for (const module of extraModules) {
        if (registry.get(module.id)) continue;
        registry.register(module);
    }
    return registry;
}
