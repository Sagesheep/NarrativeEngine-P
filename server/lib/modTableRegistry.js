// Mod-declared table registration — Project 5 / WO-P5-05 Step 2.
//
// Turns validated mod `tables` declarations into TableDescriptors and registers
// them in the server table registry. A mod table gets: a file on disk, a generic
// GET/PUT route pair, hydration, and inclusion in campaign export/import —
// with ZERO mod code (WO-P5-05 §1).
//
// ┌─ THE SECURITY RULE (WO-P5-05 §2) ─────────────────────────────────────┐
// │ The modder NEVER supplies a path. The app computes the file suffix as   │
// │ `.mod-<modId>-<name>.json`. There is no `fileSuffix` field in the       │
// │ manifest and there must never be one. Three belt-and-braces defences:  │
// │   1. `name` validated against ID_REGEX in modLoader.js (no dots,       │
// │      slashes, "..").                                                     │
// │   2. The computed suffix is asserted not in the built-in set — the     │
// │      `mod-` prefix already makes this unreachable; we assert anyway.   │
// │   3. The generic route serves only registered names (Step 3).          │
// │ A mod supplies NO functions: no serverSchema, no clientSchema, no      │
// │ hooks. A mod table is data only.                                       │
// └────────────────────────────────────────────────────────────────────────┘

import { BUILTIN_CAMPAIGN_FILE_SUFFIXES } from './fileStore.js';

/**
 * Compute the namespaced table name: `mod.<modId>.<name>`.
 * Mirrors the contribution namespace `mod.<id>.<cid>` (modAdapter.ts).
 */
export function modTableName(modId, name) {
    return `mod.${modId}.${name}`;
}

/**
 * Compute the file suffix: `.mod-<modId>-<name>.json`.
 *
 * The `mod-` prefix makes collision with a built-in suffix (e.g. `.state.json`)
 * impossible by construction: no built-in suffix starts with `.mod-`. The
 * `<modId>` segment makes collision between two mods impossible: mod ids are
 * already unique (modLoader.js rejects duplicate ids).
 */
export function modTableSuffix(modId, name) {
    return `.mod-${modId}-${name}.json`;
}

/**
 * Build a TableDescriptor for a validated mod table declaration. Every
 * touchpoint is present EXCEPT serverSchema/clientSchema (§2 "Also
 * non-negotiable": a mod supplies no functions; a mod table is data only).
 *
 * The transfer bundleKey is `mod.<modId>.<name>` — the same as the descriptor
 * name. On import, unknown bundle keys are preserved (§5), so a mod table
 * whose mod is not installed round-trips intact.
 */
export function buildModTableDescriptor(modId, table) {
    const name = modTableName(modId, table.name);
    const fileSuffix = modTableSuffix(modId, table.name);

    // Defence #2 (belt-and-braces): assert the computed suffix is not in the
    // built-in set. The `mod-` prefix already makes this unreachable; we
    // assert anyway because the cost of being wrong here is a mod silently
    // overwriting a built-in campaign file.
    if (BUILTIN_CAMPAIGN_FILE_SUFFIXES.includes(fileSuffix)) {
        throw new Error(
            `[tables] mod table "${table.name}" in mod "${modId}" computed suffix ` +
            `"${fileSuffix}" collides with a built-in campaign file — ` +
            `the mod- prefix should make this impossible`,
        );
    }

    return {
        name,
        fileSuffix,
        recordShape: table.recordShape,
        serverRoutes: { present: true, value: { get: true, put: true } },
        transfer: { present: true, value: { bundleKey: name } },
        storeAccessor: { present: true, value: { read: true, write: true } },
        // hydrator + slice are wired client-side (Step 4); the server descriptor
        // does not carry function touchpoints.
    };
}

/**
 * The set of descriptor names currently registered from mods. Tracked so
 * `registerModTables` can clear the previous batch before registering the
 * next — the mods route reads disk on every request, and stale descriptors
 * from an uninstalled mod must not linger.
 */
const registeredModTableNames = new Set();

/**
 * Register all mod-declared tables into the server registry, clearing the
 * previous batch first. Called from the mods route after `loadMods`.
 *
 * NEVER THROWS. A build failure (the unreachable suffix-collision assert) is
 * caught here and logged — a single bad descriptor must not take down the
 * mods endpoint. This mirrors the loader's never-throw contract.
 *
 * @param {object} registry - the server table registry (serverTableRegistry)
 * @param {object[]} mods - validated mods from loadMods, each with a `tables` array
 */
export function registerModTables(registry, mods) {
    // Clear previously registered mod tables so an uninstalled mod's suffix
    // does not linger in the derived campaign-file set.
    for (const name of registeredModTableNames) {
        registry.unregister(name);
    }
    registeredModTableNames.clear();

    for (const mod of mods) {
        if (!Array.isArray(mod.tables) || mod.tables.length === 0) continue;
        for (const table of mod.tables) {
            try {
                const descriptor = buildModTableDescriptor(mod.id, table);
                if (registry.get(descriptor.name)) {
                    // Two mods somehow produced the same namespaced name. The
                    // loader enforces unique mod ids, so this should be
                    // unreachable. Belt-and-braces: skip rather than throw.
                    console.warn(`[tables] duplicate mod table descriptor "${descriptor.name}" — skipping`);
                    continue;
                }
                registry.register(descriptor);
                registeredModTableNames.add(descriptor.name);
            } catch (err) {
                console.error(`[tables] failed to register mod table "${table.name}" in mod "${mod.id}": ${err.message}`);
            }
        }
    }
}