/**
 * Project 2 / WO-P2-04 — the mod file contract, client side.
 *
 * Mirrors what `server/lib/modLoader.js` validates and returns. The server is the authority:
 * anything typed here has already been checked on disk, so the adapter can read it without
 * re-validating — but it still reads defensively, because these objects arrive over HTTP.
 *
 * Data contributions remain the original v1 surface. Compute mods are a separate, explicitly
 * declared surface; their source is carried as text and runs only in the browser sandbox.
 */

/**
 * Facts about the current scene that mod conditions and templates may read.
 *
 * Supplied on `FinalUserModuleInput` by the payload builder. Every field is optional and the
 * adapter reads all of them defensively — a condition that references a fact the app did not
 * supply evaluates to NOT matching, never to "true by default".
 */
export interface ModFacts {
    onStageNpcNames?: string[];
    location?: string;
    inCombat?: boolean;
    sceneTags?: string[];
}

/**
 * A contribution's activation condition.
 *
 * Semantics: every key present must match (AND). Within a key, an array means any value may
 * match (OR). An absent `when` is always active.
 */
export interface ModWhen {
    /** Case-insensitive membership test against `facts.onStageNpcNames`. */
    npcPresent?: string | string[];
    /** Case-insensitive equality against `facts.location`. */
    location?: string | string[];
    /** Strict boolean equality against `facts.inCombat`. */
    inCombat?: boolean;
    /** Case-insensitive membership test against `facts.sceneTags`. */
    sceneTag?: string | string[];
}

/** One block of text a mod wants in the final user message. */
export interface ModContribution {
    /** Unique within the mod. Namespaced to `mod.<modId>.<id>` before it reaches the arbiter. */
    id: string;
    /** Sort key within the slot; ascending. Built-ins occupy 100, 200, … 800. */
    order: number;
    /** Token ceiling. Absent = the registry's `DEFAULT_MOD_CONTRIBUTION_BUDGET`. */
    budget?: number;
    /** The text, with optional `{{location}}` / `{{npcs}}` slots. */
    text: string;
    /** Activation condition. Absent = always active. */
    when?: ModWhen;
    /**
     * Built-in or mod contribution ids this contribution removes when it is active. Used
     * VERBATIM — targeting `gm.reminder` is a legitimate thing for a mod to do. The structural
     * ids in `PROTECTED_SUPPRESSION_IDS` are rejected at load time.
     */
    suppresses?: string[];
}

/**
 * A data table declared by a mod manifest. The app computes the file suffix,
 * routes, hydration and transfer from this declaration — the modder writes
 * no code (WO-P5-05).
 *
 * The modder NEVER supplies a path. There is no `fileSuffix` field here and
 * there must never be one (WO-P5-05 §2). The app derives
 * `.mod-<modId>-<name>.json` from `name` + the mod's `id`.
 *
 * `reads`/`writes` are declared relationships (plan §7). Nothing consumes them
 * yet; they are included now because adding them later would be a breaking
 * change to a manifest shape the app owes compatibility on.
 */
export interface ModTableDeclaration {
    /** Required. ID_REGEX (`/^[a-zA-Z0-9_-]+$/`). Unique within the mod. */
    name: string;
    /** Required. `"array"` (JSON array of records) or `"single-object"` (one JSON object). */
    recordShape: 'array' | 'single-object';
    /** Optional. Human-readable label, for UI later. */
    label?: string;
    /** Optional. Declared read relationships (plan §7). Not consumed yet. */
    reads?: string[];
    /** Optional. Declared write relationships (plan §7). Not consumed yet. */
    writes?: string[];
}

/** A validated table declaration. Same shape — the server has checked it. */
export interface ValidatedModTable {
    name: string;
    recordShape: 'array' | 'single-object';
    label?: string;
    reads?: string[];
    writes?: string[];
}

/** A `*.mod.json` file, as authored. */
export interface ModDefinition {
    id: string;
    name: string;
    version: string;
    /** `">=X.Y.Z"` or `"*"`. Absent = compatible with any app version. */
    appVersion?: string;
    description?: string;
    contributions: ModContribution[];
    compute?: ModCompute;
    /** Optional. Data tables the app provisions with zero mod code (WO-P5-05). */
    tables?: ModTableDeclaration[];
}

/** The code hook and capabilities declared by a compute mod. */
export interface ModCompute {
    file: string;
    hook: 'postTurn';
    capabilities: string[];
}

export interface ValidatedMod extends ModDefinition {
    description: string;
    /** Source filename inside the mods folder. Diagnostics and the extensions UI. */
    file: string;
    /** The sibling compute file, carried as text; the server never evaluates it. */
    computeSource?: string;
    /** Validated data tables (WO-P5-05). Same shape, server-checked. */
    tables: ValidatedModTable[];
}

/** A file that was rejected, and why. Shown to the user rather than swallowed. */
export interface ModFault {
    file: string;
    reason: string;
}

/** What `GET /api/mods` returns. */
export interface ModLoadResult {
    mods: ValidatedMod[];
    faults: ModFault[];
}

/**
 * Built-in contribution ids a mod may never suppress — the player's message, the world-state
 * block, the confirmed ask-GM handoff, and the player's own absolute command.
 *
 * The load-time rejection lives in `server/lib/modLoader.js` (same list). This copy exists for
 * the extensions UI and for tests; keep the two in step.
 */
export const PROTECTED_SUPPRESSION_IDS: readonly string[] = [
    'user.message',
    'volatile.block',
    'askgm.brief',
    'absolute.command',
];
