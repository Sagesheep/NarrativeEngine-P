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

import type { PanelInputControl } from '@narrative/engine';

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

/**
 * WO-P5-16 — a mod-declared panel field. The serializable subset of
 * `PanelField` from `@narrative/engine`: every control EXCEPT `computed`
 * (R3 — mod panels declare no logic in v1; `computed` would require a
 * function, and a `*.mod.json` file cannot supply one). `min`/`max` come
 * from G1; `options` from `select`; all other fields are plain strings.
 */
export interface ModPanelField {
    /** Store-field path relative to a row of the bound table. */
    key: string;
    /** Optional human-readable label. The renderer never infers behavior from it. */
    label?: string;
    /** Optional help text for a host renderer. */
    description?: string;
    /** Input hint used by text-like controls. */
    placeholder?: string;
    /** Options used by a select control. Required when `control === 'select'`. */
    options?: ModPanelOption[];
    control: Exclude<PanelInputControl, 'computed'>;
    /** WO-P5-16 G1 — inclusive bounds for a `number` control. */
    min?: number;
    max?: number;
}

export interface ModPanelOption {
    value: string;
    label: string;
}

/**
 * The sort spec a mod may declare. Mirrors `SortSpec` from
 * `@narrative/engine` so the manifest stays a plain-JSON shape (no TS-only
 * type re-exported across the wire).
 */
export interface ModPanelSort {
    field: string;
    direction?: 'asc' | 'desc';
}

/**
 * WO-P5-17 — a screen declared in a `*.mod.json` manifest.
 *
 * A screen is a mod's OWN UI code, rendering where it cannot touch the app
 * (10_PANEL_LIMITS.md §10.2; WORKORDER-P5-17 §1). The frame is an
 * `<iframe srcdoc=…>` with `sandbox="allow-scripts"`; `allow-same-origin` is
 * FORBIDDEN and test-enforced (R1).
 *
 *   R2 — `file` is a sibling source file, read as text and carried on
 *        `ValidatedMod.screenSource[]` in the same position as the screen
 *        declaration. The server NEVER evaluates it (the same rule as
 *        `computeSource`). The server holds the vault; mod code never runs
 *        on the machine with the keys.
 *   R4 — one frame per screen, created on mount, destroyed on unmount. No
 *        pooling, no reuse (the manifest carries one declaration per
 *        screen; the host maps that to one frame).
 *   R6 — no host API in 5.1. There is no `capabilities` field and no
 *        message channel declared here. A 5.1 screen is useless on purpose.
 *
 * There is no `launch` field — R4 of WO-P5-16 already ruled that mod UI
 * lives nested in Extensions, and a screen does not change that. There are
 * no `capabilities` — there is no API to grant yet (R6).
 */
export interface ModScreenDeclaration {
    /** Required. ID_REGEX (`/^[a-zA-Z0-9_-]+$/`). Unique within the mod. */
    id: string;
    /** Required. A plain filename inside the mods directory (same rules as `compute.file`). */
    file: string;
    /** Optional. Human-readable label, for the host chrome above the frame. */
    label?: string;
}

/** A validated screen declaration. Same shape, server-checked, plus the loaded source text (R2). */
export interface ValidatedModScreen {
    id: string;
    file: string;
    label?: string;
}

/**
 * WO-P5-16 — a panel declared in a `*.mod.json` manifest.
 *
 * A mod panel is a DECLARATION, never code (08_PANELS.md §1). The manifest
 * shape is the serializable subset of `PanelDescriptor`:
 *   - `bindsTo` names one of the mod's OWN declared `tables[].name` (R1),
 *     never a host store field.
 *   - `reads`, if present, names only the mod's own tables (R2).
 *   - `hooks` is REJECTED at load time (R3) — v1 defers panel logic; a mod's
 *     first panel is a CRUD editor over its own table and needs none of it.
 *   - `launch` is always `'nested'` (R4) — a mod panel lands inside the
 *     Extensions tab, under the mod that declared it. Prime navigation
 *     (header buttons, top-level tabs) is the app's.
 *   - `layout` follows `recordShape` (R5): `single-object` -> `'form'`;
 *     `array` -> `'list'` or `'list-detail'`. Any other pairing is a
 *     load-time rejection.
 *
 * There is no `writes` field: a mod panel writes only to `bindsTo`, via the
 * CRUD affordances the renderer renders from `crud` (G2). Cross-table
 * writes are a hook kind, which R3 defers.
 *
 * There is no `id` collision with the host: the host resolves `bindsTo`
 * against the store, the mod path against the mod's table, and the renderer
 * cannot tell the two apart (§4).
 */
export interface ModPanelDeclaration {
    /** Required. ID_REGEX (`/^[a-zA-Z0-9_-]+$/`). Unique within the mod. */
    id: string;
    /** Required. Must be one of this mod's declared `tables[].name` (R1). */
    bindsTo: string;
    /** Required. Always `'nested'` for a mod panel (R4). */
    launch: 'nested';
    /** Required. Must follow the bound table's `recordShape` (R5). */
    layout: 'list' | 'list-detail' | 'form';
    /** Required. The serializable field set; `computed` is excluded (R3). */
    fields: ModPanelField[];
    /** CRUD capabilities. Omitted operations are not available. No `reorder` (08_PANELS.md §4.3). */
    crud: Partial<Record<'create' | 'read' | 'update' | 'delete' | 'bulk', boolean>>;
    /** Optional. Bare string = ascending (4.1 default); `{ field, direction }` for desc (G3). */
    sort?: string | ModPanelSort;
    /** Optional. Each name must be one of this mod's own tables (R2). */
    reads?: string[];
    /** Optional. A declared search toggle; the renderer renders a search box when true. */
    search?: boolean;
    /** Optional. A declared filter on a field with a static option list. */
    filter?: { field: string; options: ModPanelOption[]; label?: string };
}

/** A validated panel declaration. Same shape — the server has checked it. */
export interface ValidatedModPanel {
    id: string;
    bindsTo: string;
    launch: 'nested';
    layout: 'list' | 'list-detail' | 'form';
    fields: ModPanelField[];
    crud: Partial<Record<'create' | 'read' | 'update' | 'delete' | 'bulk', boolean>>;
    sort?: string | ModPanelSort;
    reads?: string[];
    search?: boolean;
    filter?: { field: string; options: ModPanelOption[]; label?: string };
}

/** A `*.mod.json` file, as authored. */
export interface ModDefinition {
    id: string;
    name: string;
    version: string;
    /** `">=X.Y.Z"` or `"*"`. Absent = compatible with any app version. */
    appVersion?: string;
    description?: string;
    /** Phase 1.1 / MANIFEST.md §2 — `TRUST.md` §D disclosure pair. Optional. */
    author?: string;
    /** Phase 1.1 / MANIFEST.md §2 — `http:`/`https:` URL. The app never auto-opens it. */
    homepage?: string;
    /**
     * Phase 1.1 / MANIFEST.md §6.3 — one integer an author controls. Default 0.
     * Negative is allowed. The RESOLVED load order is topological over
     * `dependencies` with `loadOrder` as the tie-break (§6.3); a dependency
     * therefore always precedes its dependent even when its `loadOrder` is
     * higher. Lower runs first.
     */
    loadOrder?: number;
    /**
     * Phase 1.1 / MANIFEST.md §6.4 — `{ modId: range }`. A missing dependency is
     * a fault on the dependent at load time (1.3). Self-dependency is a fault.
     * Optional dependencies are declined for v1 (§6.4).
     */
    dependencies?: Record<string, string>;
    /**
     * Phase 1.1 / MANIFEST.md §5 — locale → flat-JSON translation file. The
     * host namespaces every key as `mod.<modId>.<key>` on merge, so a mod can
     * never overwrite a host string. Locale codes are not restricted to the
     * host's six (§5).
     */
    i18n?: Record<string, string>;
    /**
     * Phase 1.1 / MANIFEST.md §7.5 — contributions is now OPTIONAL. A native-
     * only mod (enemies, Phase 8) or a panel/screen-only mod contributes no
     * prompt text. The "declares nothing" rule (§2) replaces the old required-
     * non-empty-array rule.
     */
    contributions?: ModContribution[];
    compute?: ModCompute;
    /** Optional. Data tables the app provisions with zero mod code (WO-P5-05). */
    tables?: ModTableDeclaration[];
    /** Optional. Declared panels over this mod's own tables (WO-P5-16). */
    panels?: ModPanelDeclaration[];
    /** Optional. Declared screens — a mod's own UI in an isolated frame (WO-P5-17). */
    screens?: ModScreenDeclaration[];
    /**
     * Phase 1.1 / MANIFEST.md §3 — the native tier. Its presence alone makes
     * the mod native-tier for trust and warning purposes (TRUST.md §B); Phase
     * 6.1 shows the verbatim warning before first enablement. `js`/`css` paths
     * are validated mod-relative; the server never evaluates native code (§4).
     * Phase 1.5 wires `import()`; Phase 1.4 wires the hooks.
     */
    native?: ModNative;
}

/** Phase 1.1 / MANIFEST.md §3 — the native tier. */
export interface ModNative {
    /** Required. Mod-relative path to the ES module entry point. */
    js: string;
    /** Optional. Mod-relative path to a single CSS file, injected on activate. */
    css?: string;
    /**
     * Optional. `{ hookName: exportName }`. The seven hook names are
     * validated at load time (Phase 1.4 wires the firing). Values name
     * functions exported by `js`; existence is a Phase 1.5 runtime check.
     */
    hooks?: Record<string, string>;
    /** Optional. The name of a function exported by `js`, called by 5.2's hook. */
    generateInterceptor?: string;
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
    /**
     * Phase 1.3 / MANIFEST.md §6.6 — the mod's folder name (e.g. `arc`). Used
     * by Phase 1.5's asset route to serve files from the mod's own folder.
     * The manifest `id` is authoritative (§6.1); the folder is a path only.
     */
    folder: string;
    /**
     * Phase 1.3 / MANIFEST.md §6.6 — absolute path to the mod's folder, so
     * Phase 1.5's asset route can serve files without re-reading the manifest
     * or re-walking the directory. The loader must not read asset files
     * eagerly (§6.6); this is the path, not the contents.
     */
    folderPath: string;
    /**
     * Phase 1.1 / MANIFEST.md §6.3 — one integer. Always present on a validated
     * mod (default 0). The RESOLVED load order is topological over
     * `dependencies` with `loadOrder` as the tie-break, then `id` ascending
     * (§6.3). Callers MUST NOT re-sort `mods[]`; the loader returns them in
     * resolved order.
     */
    loadOrder: number;
    /**
     * Phase 1.1 / MANIFEST.md §6.4 — the validated dependency map. Always
     * present on a validated mod (default `{}`). The resolver uses this to
     * topologically sort mods before they reach the caller.
     */
    dependencies: Record<string, string>;
    /**
     * Phase 1.1 / MANIFEST.md §5 — locale → translation file declarations.
     * Always present on a validated mod (default `{}`). The parsed string
     * maps ship alongside in `i18nStrings`.
     */
    i18n: Record<string, string>;
    /**
     * Phase 1.1 / MANIFEST.md §5 — the parsed locale → string-map contents,
     * in the same keys as `i18n`. The host merges these on locale change
     * without re-reading disk.
     */
    i18nStrings: Record<string, Record<string, string>>;
    /** Phase 1.1 / MANIFEST.md §7.5 — contributions is now optional at authoring, default []. */
    contributions: ModContribution[];
    /** The sibling compute file, carried as text; the server never evaluates it. */
    computeSource?: string;
    /** Validated data tables (WO-P5-05). Same shape, server-checked. */
    tables: ValidatedModTable[];
    /** Validated panel declarations (WO-P5-16). Same shape, server-checked. */
    panels: ValidatedModPanel[];
    /**
     * Validated screen declarations (WO-P5-17). Same shape, server-checked.
     * The screen source text is carried in `screenSources` in the SAME ORDER
     * as `screens`, so the host pairs declaration `i` with source `i`. The
     * server never evaluates the source (R2) — it ships as text and runs
     * only in the browser frame.
     */
    screens: ValidatedModScreen[];
    /** The sibling screen source files, as text, in `screens[]` order (R2). */
    screenSources: string[];
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
