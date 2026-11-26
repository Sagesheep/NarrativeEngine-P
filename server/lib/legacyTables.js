// The retired-table registry — Phase 8.5.
//
// ┌─ WHAT THIS IS ───────────────────────────────────────────────────────────┐
// │ Campaign files the app USED to own and no longer serves. A feature that   │
// │ leaves core takes its logic, its UI and its routes with it — but not its  │
// │ files. Those sit in `data/campaigns/` holding a year of somebody's work,  │
// │ written by a version of the app that no longer exists.                    │
// │                                                                           │
// │ This list is the app's memory of them. It is DATA, not behaviour: nothing │
// │ here knows what an enemy is, only that five filenames were once ours and  │
// │ are now nobody's until a mod adopts them.                                 │
// └───────────────────────────────────────────────────────────────────────────┘
//
// It is read by exactly four places, and each reads it for one reason:
//
//   1. `fileStore.js`      — these suffixes stay in the campaign file set, so
//                            backup, restore, delete and the campaign hash keep
//                            covering them. A retired file is still user data.
//   2. `modLoader.js`      — the closed vocabulary a mod's `tables[].migrateFrom`
//                            may name. THE SECURITY RULE: a mod never supplies a
//                            path or a suffix of its own invention; it picks a
//                            name out of this list or its manifest is rejected.
//                            Without that gate a declarative mod could declare
//                            `migrateFrom: ".json"` and have the host copy the
//                            campaign record into a table it can read.
//   3. `legacyAdoption.js` — belt-and-braces: the same membership check again at
//                            the moment a file is actually read.
//   4. `transfer.js`       — export must still be able to PRODUCE these keys and
//                            import to consume them, or a campaign exported
//                            before the extraction loses its data on the way
//                            back in. The `bundleKey` is the key the pre-
//                            extraction bundle used, verbatim; changing one
//                            silently breaks every bundle already in the wild.
//
// ┌─ HOW THIS LIST CHANGES ──────────────────────────────────────────────────┐
// │ It GROWS when a feature leaves core (one row per file it used to write).  │
// │ It SHRINKS only when a release decides the legacy files are finally safe  │
// │ to stop carrying — which is a deliberate, announced act, because the      │
// │ files are the rollback path (`Phase 8.5` §3.4). Removing a row here does  │
// │ not delete anyone's file; it stops the app from backing it up, exporting  │
// │ it, or letting a mod adopt it. That is worse than leaving it, so leave it.│
// └───────────────────────────────────────────────────────────────────────────┘

/**
 * @typedef {object} RetiredTable
 * @property {string} fileSuffix   The campaign file suffix, e.g. `.enemies.json`.
 * @property {string} bundleKey    The export/import bundle key the app used
 *                                 BEFORE the feature left core. Verbatim — this
 *                                 is a compatibility promise to bundles that
 *                                 already exist on users' disks.
 * @property {'array' | 'single-object'} recordShape  The shape the file holds.
 * @property {string} retiredIn    The phase that retired it, for the reader who
 *                                 asks "why is this here?" three years from now.
 */

/**
 * The five enemy files. Core wrote these from the first release until Phase 8.2
 * deleted the routes and Phase 8.3/8.4 deleted the code that read them. The
 * `enemies` mod adopts all five (`public/bundled-mods/enemies/manifest.json`).
 *
 * `.enemy-suggestions.json` is deliberately absent: it never existed. The
 * discovery review queue was in-memory only in core (`ENEMY_SEAM.md` §3.5) and
 * is in-memory only in the mod (Phase 8.2 §4), so there is nothing to retire.
 *
 * @type {readonly RetiredTable[]}
 */
export const RETIRED_CAMPAIGN_TABLES = Object.freeze([
    Object.freeze({ fileSuffix: '.enemies.json', bundleKey: 'enemies', recordShape: 'array', retiredIn: '8.2' }),
    Object.freeze({ fileSuffix: '.enemy-instances.json', bundleKey: 'enemyInstances', recordShape: 'array', retiredIn: '8.2' }),
    Object.freeze({ fileSuffix: '.enemy-encounters.json', bundleKey: 'enemyEncounters', recordShape: 'array', retiredIn: '8.2' }),
    Object.freeze({ fileSuffix: '.enemy-resolutions.json', bundleKey: 'enemyResolutions', recordShape: 'array', retiredIn: '8.2' }),
    Object.freeze({ fileSuffix: '.enemy-combat.json', bundleKey: 'enemyCombatConfig', recordShape: 'single-object', retiredIn: '8.2' }),
]);

/** The suffixes alone, in declaration order. */
export const RETIRED_CAMPAIGN_FILE_SUFFIXES = Object.freeze(
    RETIRED_CAMPAIGN_TABLES.map((t) => t.fileSuffix),
);

/** Membership test for `migrateFrom` validation and the adoption guard. */
export function isRetiredCampaignFile(fileSuffix) {
    return RETIRED_CAMPAIGN_FILE_SUFFIXES.includes(fileSuffix);
}

/** The row for a suffix, or `undefined`. */
export function retiredTableFor(fileSuffix) {
    return RETIRED_CAMPAIGN_TABLES.find((t) => t.fileSuffix === fileSuffix);
}
