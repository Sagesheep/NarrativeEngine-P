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

import fs from 'fs';
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
 * Phase 6.4 / `DATA_POLICY.md` §4 — every mod-table file on disk for one
 * campaign, whether or not the owning mod is currently registered.
 *
 * ┌─ WHY THIS EXISTS (Phase 6.4 §0.6, the one open verification) ────────────┐
 * │ Export used to read the registry alone. The registry is populated as a   │
 * │ side effect of `GET /api/mods`, so a server that had never served that   │
 * │ route exported a bundle with EVERY mod table missing — silently, on the  │
 * │ path users treat as a backup. The policy says a disabled mod's data is   │
 * │ kept and returns intact; an export that drops it says otherwise. Two     │
 * │ answers about user data is how data gets lost, so export is now driven   │
 * │ by what is on disk, and the registry only refines the key.               │
 * └──────────────────────────────────────────────────────────────────────────┘
 *
 * The namespace IS the provenance (§0.3): a file named
 * `<campaignId>.mod-<modId>-<name>.json` is mod-owned by construction, and
 * nothing else can produce that shape (the `mod-` prefix is computed by
 * `modTableSuffix`, never supplied by a modder).
 *
 * Splitting `<modId>-<name>` back apart is ambiguous — both halves may contain
 * `-`. That ambiguity is harmless HERE and only here, because the round trip
 * is by *suffix*, not by split: import re-derives the filename from the key by
 * re-joining the two segments with `-`, so any split that re-joins to the same
 * string writes the same file. A registered descriptor with a matching
 * `fileSuffix` still wins, so an installed mod's key is always the real one.
 *
 * Returns `[{ bundleKey, fileSuffix }]`. Never throws: an unreadable directory
 * yields `[]`, because a failed scan must degrade to the old registry-only
 * behaviour rather than fail the export.
 */
export function scanModTableFiles(campaignsDir, campaignId, registry) {
    const prefix = `${campaignId}.mod-`;
    let filenames;
    try {
        filenames = fs.readdirSync(campaignsDir);
    } catch {
        return [];
    }
    const out = [];
    for (const filename of filenames) {
        if (!filename.startsWith(prefix) || !filename.endsWith('.json')) continue;
        const fileSuffix = filename.slice(campaignId.length);
        // A registered descriptor is the authority on how this suffix splits.
        const registered = registry
            ? registry.list().find((d) => d.fileSuffix === fileSuffix)
            : undefined;
        if (registered) {
            out.push({ bundleKey: registered.name, fileSuffix });
            continue;
        }
        // No descriptor: split at the first `-` after the `mod-` prefix. See
        // the ambiguity note above — the file round-trips regardless.
        const rest = filename.slice(prefix.length, filename.length - '.json'.length);
        const dash = rest.indexOf('-');
        if (dash <= 0 || dash === rest.length - 1) continue;
        const modId = rest.slice(0, dash);
        const name = rest.slice(dash + 1);
        if (!/^[a-zA-Z0-9_-]+$/.test(modId) || !/^[a-zA-Z0-9_-]+$/.test(name)) continue;
        out.push({ bundleKey: modTableName(modId, name), fileSuffix });
    }
    return out;
}

/**
 * Phase 6.4 — every mod-table file on disk belonging to ONE mod, for one
 * campaign. The delete path's whole implementation (`DATA_POLICY.md` §3):
 * *"delete the files with that prefix."*
 *
 * Prefix-matched rather than declaration-matched on purpose. `MANIFEST.md`
 * §7.2 says the host removes the mod's provisioned tables **unconditionally**,
 * and a table the mod declared in v1 and dropped in v2 is still the mod's data
 * — it has no owner but this mod, so leaving it behind would create exactly
 * the orphan the policy says cannot exist.
 *
 * ┌─ THE ONE PLACE THE SPLIT AMBIGUITY BITES ────────────────────────────────┐
 * │ `<modId>-<name>` may contain `-` on both sides, so cleaning mod `my`     │
 * │ would prefix-match `…mod-my-mod-powers.json`, which belongs to mod       │
 * │ `my-mod`. Harmless for export (the file round-trips either way);         │
 * │ NOT harmless here, where the file is deleted. So a prefix match is       │
 * │ dropped when it is a registered descriptor of a DIFFERENT mod — the      │
 * │ registry knows every installed mod's real suffixes.                      │
 * │ Residual gap, recorded in `DATA_POLICY.md` §3: an *undeclared leftover*  │
 * │ file of a longer-named mod that is not currently installed cannot be     │
 * │ told apart from this mod's own leftovers, and is removed with them.      │
 * └──────────────────────────────────────────────────────────────────────────┘
 */
export function scanModTableFilesForMod(campaignsDir, campaignId, modId, registry) {
    const prefix = `${campaignId}.mod-${modId}-`;
    let filenames;
    try {
        filenames = fs.readdirSync(campaignsDir);
    } catch {
        return [];
    }
    // Suffixes owned by some OTHER installed mod — never this mod's to remove.
    const foreign = new Set(
        (registry ? registry.list() : [])
            .filter((d) => typeof d.name === 'string'
                && d.name.startsWith('mod.')
                && d.name.slice('mod.'.length).split('.')[0] !== modId)
            .map((d) => d.fileSuffix),
    );
    return filenames.filter((f) => f.startsWith(prefix)
        && f.endsWith('.json')
        && !foreign.has(f.slice(campaignId.length)));
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