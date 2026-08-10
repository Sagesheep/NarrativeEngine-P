import fs from 'fs';
import path from 'path';
import { ROLE_IDS } from '@narrative/engine/roles/roleIds';

/**
 * Project 2 / WO-P2-04 — the mod file loader + validator.
 *
 * Turns `mods/<anything>.mod.json` files on disk into validated mod definitions. The client
 * adapter (`src/services/mods/modAdapter.ts`) turns those into `ContributionModule`s that the
 * contribution registry can hold — so a file on disk and a built-in system reach the prompt
 * through exactly the same socket.
 *
 * ┌─ THE FAIL-SAFE RULE ───────────────────────────────────────────────────────────────────┐
 * │ `loadMods` MUST NEVER THROW. A malformed, unreadable, incompatible or hostile file      │
 * │ becomes a `{ file, reason }` fault and every other mod still loads. A missing `mods/`    │
 * │ directory is the normal case, not an error. A third-party file must never be able to    │
 * │ take down a campaign — that is acceptance criterion 5 of the Project 2 plan.            │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */

export const MOD_FILE_SUFFIX = '.mod.json';

/**
 * Built-in contribution ids a mod may NEVER suppress.
 *
 * These are structural, not features: the player's own message, the assembled world-state
 * block, the guidance the player confirmed out of character, and the binding one-turn
 * override the player armed themselves. A mod that could delete any of them could silently
 * erase the user's input from the prompt.
 *
 * Mirrors the `toggleable: false` built-ins in `src/services/payload/contributions/builtins.ts`
 * (`BUILTIN_IDS`). Duplicated rather than imported because this file is server-side ESM and
 * that one is TypeScript; `src/services/mods/modTypes.ts` carries the same list for the client
 * and `modLoader.test.js` pins both.
 */
export const PROTECTED_SUPPRESSION_IDS = Object.freeze([
    'user.message',
    'volatile.block',
    'askgm.brief',
    'absolute.command',
]);

/** Mod ids and contribution ids become dot-namespaced spec ids, so they may not contain dots. */
const ID_REGEX = /^[a-zA-Z0-9_-]+$/;

const WHEN_KEYS = ['npcPresent', 'location', 'inCombat', 'sceneTag'];
const WHEN_STRING_KEYS = ['npcPresent', 'location', 'sceneTag'];

const COMPUTE_WRITES = new Set([
    'updateContext',
    'updateNPC',
    'addMessage',
    'setDivergenceRegister',
    'addNpcSuggestions',
    'archiveNPC',
    'restoreNPC',
    'updatePlayerCharacter',
    'setCharacterSheet',
    'setInventory',
    'setLocationLedger',
    'addLocationSuggestions',
]);
const COMPUTE_TABLE_READS = new Set([]);
const COMPUTE_TABLE_WRITES = new Set([]);
const COMPUTE_MODEL_ROLES = new Set(['story', 'utility', 'auxiliary', 'summariser', 'raw-auxiliary', 'raw-summariser']);

/**
 * WO-P5-05 §2: the only two record shapes a mod table may declare. The app
 * uses this only to pick the right empty default (`[]` vs `null`).
 */
const TABLE_RECORD_SHAPES = new Set(['array', 'single-object']);

/** v1 supports exactly two forms: `">=X.Y.Z"` (Y and Z optional) and `"*"`. */
const APP_VERSION_REGEX = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * Phase 1.3 / MANIFEST.md §6.2 — manifest `version` is `X.Y.Z` with an optional
 * prerelease suffix. All three numeric components are required (unlike the
 * range grammar, where `>=1` is a legal floor). The prerelease is ignored for
 * range comparisons; it exists so `hooks.update` can fire on a `-rc.1` → `-rc.2`
 * bump and so authors can tag pre-release builds without losing the version
 * discipline.
 */
const MANIFEST_VERSION_REGEX = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * Phase 1.3 / MANIFEST.md §6.2 — range grammar shared by `appVersion` and every
 * `dependencies` value. Identical to `APP_VERSION_REGEX` but documented as the
 * shared grammar; `appVersion` keeps its own regex so its rejection reason
 * (which names `appVersion` specifically) is unchanged.
 */
const DEPENDENCY_RANGE_REGEX = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

/**
 * MANIFEST.md §6.4 / §11 — `dependencies` keys are mod ids, so they use the
 * same character set as `ID_REGEX`. Re-declared here so the dependency
 * validator is self-contained and the rejection reason matches the table.
 */
const DEPENDENCY_KEY_REGEX = ID_REGEX;

/**
 * MANIFEST.md §5 — locale codes are not restricted to the host's six. A mod
 * may ship `fr` before the app does; unknown codes load and are simply never
 * selected. The grammar is the common case: short ASCII, optionally dashed
 * (e.g. `pt-BR`). Disallowing digits and underscores matches BCP-47's
 * language subtag shape without over-validating.
 */
const LOCALE_CODE_REGEX = /^[a-z]{2,3}(-[a-z0-9]+)*$/i;

/**
 * Phase 1.4 / MANIFEST.md §3.1 — the seven lifecycle hook names. Phase 1.3
 * validates the names only; Phase 1.4 wires the firing. Declared here so a
 * typo in a manifest's `native.hooks` is a load-time rejection, not a silent
 * no-op that the user only discovers when a hook never fires.
 */
const NATIVE_HOOK_NAMES = new Set([
    'install', 'update', 'activate', 'enable', 'disable', 'delete', 'clean',
]);

/**
 * MANIFEST.md §2 — the complete top-level field set. Unknown keys are rejected
 * (§7.4), with targeted hints for the three ST spellings an author will reach
 * for from muscle memory and targeted messages for the four deliberately
 * declined names (`assets`, `permissions`, `settings`, `events`). Reserved keys
 * (`mounts`, `macros`, `facts`) point at the phase that
 * will define them, so an author using a future field gets a precise message
 * rather than a generic "unknown".
 */
const TOP_LEVEL_KEYS = new Set([
    'id', 'name', 'version', 'description', 'author', 'homepage', 'appVersion',
    'loadOrder', 'dependencies', 'i18n', 'contributions', 'tables', 'panels',
    'screens', 'compute', 'native', 'roles', 'tierEntries',
]);

/** ST spellings that get a "this app spells it X" hint, not a bare unknown-key. */
const ST_SPELLING_HINTS = {
    loading_order: 'loadOrder',
    display_name: 'name',
    minimum_client_version: 'appVersion',
};

/** Deliberately declined names with a message pointing at the MANIFEST row. */
const DECLINED_KEYS = {
    assets: 'unknown field "assets" — every file in the mod\'s folder is available to it; no declaration is needed',
    permissions: 'unknown field "permissions" — native code runs with the app\'s own access and a permission list would not constrain it',
    settings: 'unknown field "settings" — declare a single-object table and a form panel bound to it',
    // Phase 3.1 was the phase that would define `events`, and it declined the
    // key (`EVENTS.md` §9.1, `MANIFEST.md` §16): a declarative subscription list
    // needs a declarative handler name to point at, which is a second dispatch
    // mechanism beside the hooks §3.1 already declares. Moved from RESERVED_KEYS
    // to the targeted form, with the working alternative.
    events: 'events is not a manifest field — subscribe with ctx.events.on() from your activate hook. See EVENTS.md',
};

/**
 * Reserved for a later app version. An author who writes one of these expects
 * it to do something; rejecting with the phase that will define it is the
 * point, so a mod that loads while silently doing nothing is not the failure
 * mode (§9 "Reserved — declared now, defined later").
 */
const RESERVED_KEYS = {
    mounts: '4.1',
    macros: '5.1',
    facts: '5.4',
    // `events` moved to DECLINED_KEYS in Phase 3.2 — the phase that would have
    // defined it declined it instead. Should 5.4's facts registry later want
    // declared publishers it can be reintroduced additively (absent = no
    // declarations), exactly as MANIFEST.md §9 argues for `manifestVersion`.
};

/**
 * Top-level `hooks` or `generateInterceptor` belong inside `native` (§3). They
 * structurally require a native entry point; declaring one without the other
 * is a fault, not a silent pass.
 */
const NATIVE_ONLY_TOP_LEVEL_KEYS = new Set(['hooks', 'generateInterceptor']);

/** Internal control flow only — never escapes `loadMods`. */
class ModRejected extends Error {}

function reject(reason) {
    throw new ModRejected(reason);
}

function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requireNonEmptyString(value, label) {
    if (typeof value !== 'string' || value.trim() === '') {
        reject(`${label} must be a non-empty string`);
    }
    return value;
}

function parseVersion(raw) {
    if (typeof raw !== 'string') return null;
    const match = /^\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(raw);
    if (!match) return null;
    return [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
}

function compareVersions(a, b) {
    for (let i = 0; i < 3; i++) {
        if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
    }
    return 0;
}

/**
 * Enforce `appVersion`. Absent or `"*"` = always compatible. Anything that is not `">=X.Y.Z"`
 * or `"*"` is a fault rather than a silent pass: an unparsed range would otherwise be read as
 * "compatible with everything", which is the opposite of what the author asked for.
 */
function checkAppVersion(spec, appVersion) {
    if (spec === undefined || spec === null) return;
    requireNonEmptyString(spec, 'appVersion');
    const wanted = spec.trim();
    if (wanted === '*') return;

    const match = APP_VERSION_REGEX.exec(wanted);
    if (!match) {
        reject(`unsupported appVersion "${wanted}" — v1 supports only ">=X.Y.Z" and "*"`);
    }
    const required = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];

    const current = parseVersion(appVersion);
    // Unknown host version: we cannot judge, so we do not reject. Being unable to check is not
    // evidence of incompatibility.
    if (!current) return;

    if (compareVersions(current, required) < 0) {
        reject(`requires app version ${wanted}, but this app is ${appVersion}`);
    }
}

function validateWhen(raw, at) {
    if (!isPlainObject(raw)) reject(`${at}.when must be an object`);

    for (const key of Object.keys(raw)) {
        if (!WHEN_KEYS.includes(key)) {
            reject(`${at}.when has unknown key "${key}" (allowed: ${WHEN_KEYS.join(', ')})`);
        }
    }

    const when = {};
    for (const key of WHEN_STRING_KEYS) {
        if (raw[key] === undefined) continue;
        const values = Array.isArray(raw[key]) ? raw[key] : [raw[key]];
        // An empty array can never match anything, so it is a mistake, not a condition.
        if (values.length === 0) reject(`${at}.when.${key} must not be an empty array`);
        for (const value of values) {
            if (typeof value !== 'string' || value.trim() === '') {
                reject(`${at}.when.${key} must be a non-empty string or an array of non-empty strings`);
            }
        }
        when[key] = Array.isArray(raw[key]) ? [...raw[key]] : raw[key];
    }

    if (raw.inCombat !== undefined) {
        if (typeof raw.inCombat !== 'boolean') reject(`${at}.when.inCombat must be a boolean`);
        when.inCombat = raw.inCombat;
    }

    return when;
}

function validateSuppresses(raw, at) {
    if (!Array.isArray(raw)) reject(`${at}.suppresses must be an array of contribution ids`);
    for (const id of raw) {
        if (typeof id !== 'string' || id.trim() === '') {
            reject(`${at}.suppresses must contain only non-empty contribution ids`);
        }
        if (PROTECTED_SUPPRESSION_IDS.includes(id.trim().toLowerCase())) {
            reject(`${at}.suppresses may not target the structural built-in "${id.trim()}"`);
        }
    }
    return [...raw];
}

function validateComputeCapability(value, index, modId, ownTableNames) {
    const at = 'compute.capabilities[' + index + ']';
    if (typeof value !== 'string' || value.trim() === '') {
        reject(at + ' must be a non-empty capability string');
    }

    const modelMatch = /^model:([^:]+)$/.exec(value);
    if (modelMatch) {
        if (!COMPUTE_MODEL_ROLES.has(modelMatch[1])) {
            reject(at + ' names an unknown model role "' + modelMatch[1] + '"');
        }
        return value;
    }

    const writeMatch = /^write:([^:]+)$/.exec(value);
    if (writeMatch) {
        if (!COMPUTE_WRITES.has(writeMatch[1])) {
            reject(at + ' names an unknown write "' + writeMatch[1] + '"');
        }
        return value;
    }

    const tableMatch = /^table:(read|write):([^:]+)$/.exec(value);
    if (tableMatch) {
        const operation = tableMatch[1];
        const table = tableMatch[2];

        // A mod's OWN table, namespaced `mod.<modId>.<name>`. This is the same
        // rule panels (WO-P5-16 R1) and screens already enforce: a mod may
        // reach its own data and nothing else. Validated against this mod's
        // declared `tables[]`, so a typo is still a load-time rejection.
        //
        // Without this branch every compute mod that declared a table of its
        // own was rejected at startup — including `arc.mod.json`, the COMPUTE
        // gate's own artefact, from the day it shipped. `arc.test.ts` stayed
        // green because it exercises the compute logic directly and never
        // reaches this validator (12_PROJECT_GATE.md §6).
        const ownPrefix = 'mod.' + modId + '.';
        if (table.startsWith(ownPrefix)) {
            if (!ownTableNames.has(table.slice(ownPrefix.length))) {
                reject(at + ' names "' + table + '", which is not one of mod "' + modId + '"\'s own declared tables');
            }
            return value;
        }
        if (table.startsWith('mod.')) {
            reject(at + ' names "' + table + '" — a mod may not reach another mod\'s tables');
        }

        const allowed = operation === 'read' ? COMPUTE_TABLE_READS : COMPUTE_TABLE_WRITES;
        if (!allowed.has(table)) {
            reject(at + ' names an unavailable ' + operation + ' table "' + table + '"');
        }
        return value;
    }

    reject(at + ' must be write:<name> or table:<read|write>:<name>');
}

function validateCompute(raw, modDir, modId, ownTableNames) {
    if (!isPlainObject(raw)) reject('compute must be an object');

    requireNonEmptyString(raw.file, 'compute.file');
    if (raw.file.includes('\\') || raw.file.includes('..') || raw.file.startsWith('/')) {
        reject('compute.file must be a relative path using forward slashes inside the mod\'s own folder');
    }
    if (raw.hook !== 'postTurn') {
        reject('compute.hook must be "postTurn"');
    }

    const rawCapabilities = raw.capabilities === undefined ? [] : raw.capabilities;
    if (!Array.isArray(rawCapabilities)) {
        reject('compute.capabilities must be an array of capability strings');
    }
    const seen = new Set();
    const capabilities = rawCapabilities.map((value, index) => {
        const capability = validateComputeCapability(value, index, modId, ownTableNames);
        if (seen.has(capability)) reject('duplicate compute capability "' + capability + '"');
        seen.add(capability);
        return capability;
    });

    const modRoot = fs.realpathSync(modDir);
    const requestedPath = path.resolve(modRoot, raw.file);
    let sourcePath;
    try {
        sourcePath = fs.realpathSync(requestedPath);
    } catch (err) {
        reject('compute.file "' + raw.file + '" could not be read: ' + (err?.message ?? String(err)));
    }
    const relative = path.relative(modRoot, sourcePath);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        reject('compute.file must resolve to a file inside the mod\'s own folder');
    }

    let computeSource;
    try {
        computeSource = fs.readFileSync(sourcePath, 'utf-8');
    } catch (err) {
        reject('compute.file "' + raw.file + '" could not be read: ' + (err?.message ?? String(err)));
    }

    return {
        compute: { file: raw.file, hook: 'postTurn', capabilities },
        computeSource,
    };
}

function validateContribution(raw, index, seenIds) {
    const at = `contributions[${index}]`;
    if (!isPlainObject(raw)) reject(`${at} must be an object`);

    requireNonEmptyString(raw.id, `${at}.id`);
    if (!ID_REGEX.test(raw.id)) {
        reject(`${at}.id "${raw.id}" may contain only letters, digits, "_" and "-"`);
    }
    if (seenIds.has(raw.id)) reject(`duplicate contribution id "${raw.id}"`);
    seenIds.add(raw.id);

    if (typeof raw.order !== 'number' || !Number.isFinite(raw.order)) {
        reject(`${at}.order must be a finite number`);
    }
    requireNonEmptyString(raw.text, `${at}.text`);

    const contribution = { id: raw.id, order: raw.order, text: raw.text };

    // Optional. The registry applies DEFAULT_MOD_CONTRIBUTION_BUDGET when it is absent.
    if (raw.budget !== undefined) {
        if (typeof raw.budget !== 'number' || !Number.isFinite(raw.budget) || raw.budget <= 0) {
            reject(`${at}.budget must be a positive finite number`);
        }
        contribution.budget = raw.budget;
    }
    if (raw.when !== undefined) contribution.when = validateWhen(raw.when, at);
    if (raw.suppresses !== undefined) contribution.suppresses = validateSuppresses(raw.suppresses, at);

    return contribution;
}

/**
 * WO-P5-05 — validate a mod's declared `tables` array. A mod table is
 * DATA ONLY: a file on disk, a GET/PUT pair, hydration, export/import. No
 * mod code runs (§2 "Also non-negotiable"); that is phase COMPUTE.
 *
 * The modder NEVER supplies a path. There is no `fileSuffix` field accepted
 * and there must never be one (§2). The app derives `.mod-<modId>-<name>.json`
 * from the table `name` + the mod's `id`. Three belt-and-braces defences are
 * enforced here and again at registration:
 *
 *   1. `name` is validated against ID_REGEX (reused from line 159 of this
 *      file): no dots (would forge the namespace), no slashes, no `..`.
 *   2. The computed suffix is asserted not in the built-in set (Step 2).
 *      The `mod-` prefix already makes that unreachable; we assert anyway.
 *   3. The generic route serves only registered names; an unregistered name
 *      is a 404 before any path is built (Step 3).
 *
 * This step builds NO descriptor — Step 2 does. A malformed `tables` entry
 * rejects THIS mod, with a reason naming the mod, the table and the problem.
 * Other mods keep loading. Rejection happens at load, never mid-turn.
 */
function validateTables(raw, modId) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) reject('tables must be an array of table declarations');

    const seen = new Set();
    const tables = raw.map((entry, index) => {
        const at = `tables[${index}]`;
        if (!isPlainObject(entry)) reject(`${at} must be an object`);

        requireNonEmptyString(entry.name, `${at}.name`);
        // Defence #1: ID_REGEX rejects dots, slashes, "..", whitespace.
        // A dot would forge the namespace (".state.json"); a slash or ".."
        // would traverse out of the campaigns directory.
        if (!ID_REGEX.test(entry.name)) {
            reject(`${at}.name "${entry.name}" may contain only letters, digits, "_" and "-"`);
        }
        if (seen.has(entry.name)) reject(`${at}.name "${entry.name}" is declared more than once in mod "${modId}"`);
        seen.add(entry.name);

        requireNonEmptyString(entry.recordShape, `${at}.recordShape`);
        if (!TABLE_RECORD_SHAPES.has(entry.recordShape)) {
            reject(`${at}.recordShape "${entry.recordShape}" must be "array" or "single-object"`);
        }

        const table = { name: entry.name, recordShape: entry.recordShape };

        if (entry.label !== undefined) {
            if (typeof entry.label !== 'string') reject(`${at}.label must be a string`);
            table.label = entry.label;
        }

        // reads/writes are declared relationships (plan §7). Nothing consumes
        // them yet. Validated as string arrays so a typo is a fault, not a
        // silent miss, once a later phase does consume them.
        if (entry.reads !== undefined) {
            table.reads = validateStringArray(entry.reads, `${at}.reads`);
        }
        if (entry.writes !== undefined) {
            table.writes = validateStringArray(entry.writes, `${at}.writes`);
        }

        // §2: the manifest must NEVER accept a fileSuffix, a path, a schema,
        // or a function. Any of these fields present is a fault, not a pass —
        // a mod that supplies a path has just attempted to name any file in
        // the campaigns directory, and a mod that supplies a function has
        // just attempted to execute code outside the sandbox.
        const forbidden = ['fileSuffix', 'filePath', 'path', 'serverSchema', 'clientSchema', 'hooks', 'onRemove'];
        for (const key of forbidden) {
            if (entry[key] !== undefined) {
                reject(`${at}.${key} is not allowed — a mod table is data only; the app computes the ${key === 'fileSuffix' || key === 'filePath' || key === 'path' ? 'file suffix' : key}`);
            }
        }
        // Any other unknown key is a fault too: the manifest shape is a
        // permanent compatibility promise (WO-P5-05 §3), and an unknown key
        // is either a typo or a future field we have not promised yet.
        const allowed = new Set(['name', 'recordShape', 'label', 'reads', 'writes']);
        for (const key of Object.keys(entry)) {
            if (!allowed.has(key)) {
                reject(`${at} has unknown field "${key}" — only name, recordShape, label, reads, writes are allowed`);
            }
        }

        return table;
    });

    return tables;
}

/**
 * WO-P5-16 — validate a mod's declared `panels` array. A mod panel is a
 * DECLARATION, never code (08_PANELS.md §1). The rulings R1–R5 are decided
 * and load-time-enforced here, in the same shape as `validateTables`:
 * allow-listed keys, ID_REGEX on ids, reject with a ModFault rather than
 * fail silently.
 *
 *   R1 — `bindsTo` resolves against THIS MOD's declared `tables[]`, never
 *        the host store. A name not in `tables` is a rejection. This is the
 *        security ruling of the sub-phase: a mod panel that could bind to
 *        `settings` would render the API keys the vault work in COMPUTE
 *        protected. Same for `reads` (R2).
 *   R2 — `reads` may name only this mod's own tables.
 *   R3 — `hooks` is rejected at load time. v1 defers panel logic (computed
 *        fields are a field kind for OUR panels because 10 of 12 use them;
 *        a mod's first panel is a CRUD editor over its own table and needs
 *        none of it). The `computed` control is therefore also rejected —
 *        it would require a function, which a `*.mod.json` file cannot
 *        supply, but the field is forbidden explicitly so a future loader
 *        change cannot accidentally accept one.
 *   R4 — `launch` is always `'nested'`. A mod may not claim a header button
 *        or a top-level tab: prime navigation is the app's, the blast
 *        radius stays on one screen (ExtensionsTab), and a broken mod panel
 *        cannot make the app unreachable.
 *   R5 — `layout` follows `recordShape`: `single-object` -> `'form'`;
 *        `array` -> `'list'` or `'list-detail'`. Any other pairing is a
 *        rejection.
 *
 * No `writes` field is accepted: a mod panel writes only to `bindsTo`, via
 * the CRUD affordances the renderer renders from `crud` (G2). Cross-table
 * writes are a hook kind, which R3 defers. `newRow` is also forbidden — the
 * renderer derives an empty row from `fields` (G2), and a second way to say
 * what a field holds is a second thing to keep in step.
 */
const PANEL_INPUT_CONTROLS = new Set([
    'text', 'readonly', 'textarea', 'nested-object', 'number', 'tags',
    'select', 'checkbox', 'array', 'image',
]);
const PANEL_LAYOUTS = new Set(['list', 'list-detail', 'form']);

function validatePanelField(raw, at, tableNames) {
    if (!isPlainObject(raw)) reject(`${at} must be an object`);

    requireNonEmptyString(raw.key, `${at}.key`);
    requireNonEmptyString(raw.control, `${at}.control`);
    if (!PANEL_INPUT_CONTROLS.has(raw.control)) {
        // `computed` is deliberately excluded (R3): it would require a
        // function, which a manifest cannot supply, and v1 defers panel
        // logic. The explicit reject stops a future loader change from
        // accepting a `computed` field by accident.
        reject(`${at}.control "${raw.control}" is not a mod panel control (allowed: ${[...PANEL_INPUT_CONTROLS].join(', ')})`);
    }

    const field = { key: raw.key, control: raw.control };

    if (raw.label !== undefined) {
        if (typeof raw.label !== 'string') reject(`${at}.label must be a string`);
        field.label = raw.label;
    }
    if (raw.description !== undefined) {
        if (typeof raw.description !== 'string') reject(`${at}.description must be a string`);
        field.description = raw.description;
    }
    if (raw.placeholder !== undefined) {
        if (typeof raw.placeholder !== 'string') reject(`${at}.placeholder must be a string`);
        field.placeholder = raw.placeholder;
    }
    if (raw.min !== undefined) {
        if (typeof raw.min !== 'number' || !Number.isFinite(raw.min)) reject(`${at}.min must be a finite number`);
        field.min = raw.min;
    }
    if (raw.max !== undefined) {
        if (typeof raw.max !== 'number' || !Number.isFinite(raw.max)) reject(`${at}.max must be a finite number`);
        field.max = raw.max;
    }

    if (raw.control === 'select') {
        if (!Array.isArray(raw.options) || raw.options.length === 0) {
            reject(`${at}.options must be a non-empty array for a select control`);
        }
        field.options = raw.options.map((opt, i) => {
            const optAt = `${at}.options[${i}]`;
            if (!isPlainObject(opt)) reject(`${optAt} must be an object`);
            requireNonEmptyString(opt.value, `${optAt}.value`);
            requireNonEmptyString(opt.label, `${optAt}.label`);
            return { value: opt.value, label: opt.label };
        });
    }

    // Forbidden keys: anything that would carry code or a second row shape.
    // `compute` (the function field on a host `PanelComputedField`) is
    // rejected explicitly; `hooks` lives one level up on the panel.
    const forbidden = ['compute', 'newRow', 'hooks', 'fileSuffix', 'filePath', 'path'];
    for (const key of forbidden) {
        if (raw[key] !== undefined) {
            reject(`${at}.${key} is not allowed on a mod panel field — a mod panel is declared, not code`);
        }
    }
    const allowed = new Set(['key', 'control', 'label', 'description', 'placeholder', 'min', 'max', 'options']);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) {
            reject(`${at} has unknown field "${key}" — only ${[...allowed].join(', ')} are allowed`);
        }
    }

    return field;
}

function validatePanels(raw, modId, tables) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) reject('panels must be an array of panel declarations');

    const tableNames = new Set(tables.map((t) => t.name));
    const tableByShape = new Map(tables.map((t) => [t.name, t.recordShape]));

    const seen = new Set();
    const panels = raw.map((entry, index) => {
        const at = `panels[${index}]`;
        if (!isPlainObject(entry)) reject(`${at} must be an object`);

        requireNonEmptyString(entry.id, `${at}.id`);
        if (!ID_REGEX.test(entry.id)) {
            reject(`${at}.id "${entry.id}" may contain only letters, digits, "_" and "-"`);
        }
        if (seen.has(entry.id)) reject(`${at}.id "${entry.id}" is declared more than once in mod "${modId}"`);
        seen.add(entry.id);

        requireNonEmptyString(entry.bindsTo, `${at}.bindsTo`);
        // R1: bindsTo must name one of THIS MOD's own declared tables. The
        // host store (`settings`, `enemyInstances`, …) is never on this list.
        if (!tableNames.has(entry.bindsTo)) {
            const owned = [...tableNames].join(', ') || '(no tables declared)';
            reject(`${at}.bindsTo "${entry.bindsTo}" is not one of mod "${modId}"'s own tables (declared: ${owned})`);
        }

        requireNonEmptyString(entry.launch, `${at}.launch`);
        // R4: a mod panel launches `nested`, inside the Extensions tab, under
        // the mod that declared it. Any other launch is a rejection.
        if (entry.launch !== 'nested') {
            reject(`${at}.launch "${entry.launch}" is not allowed for a mod panel — only "nested" is permitted`);
        }

        requireNonEmptyString(entry.layout, `${at}.layout`);
        if (!PANEL_LAYOUTS.has(entry.layout)) {
            reject(`${at}.layout "${entry.layout}" must be one of ${[...PANEL_LAYOUTS].join(', ')}`);
        }
        // R5: layout follows recordShape. `single-object` -> `form`;
        // `array` -> `list` or `list-detail`. Any other pairing is a
        // rejection — a `list-detail` over a single-object table would render
        // a list pane with one row and a detail pane with the same row.
        const boundShape = tableByShape.get(entry.bindsTo);
        if (boundShape === 'single-object' && entry.layout !== 'form') {
            reject(`${at}.layout "${entry.layout}" is not valid for a single-object table — only "form" is permitted`);
        }
        if (boundShape === 'array' && entry.layout === 'form') {
            reject(`${at}.layout "form" is not valid for an array table — use "list" or "list-detail"`);
        }

        if (!Array.isArray(entry.fields) || entry.fields.length === 0) {
            reject(`${at}.fields must be a non-empty array`);
        }
        const fields = entry.fields.map((f, i) => validatePanelField(f, `${at}.fields[${i}]`, tableNames));

        if (!isPlainObject(entry.crud)) {
            reject(`${at}.crud must be an object`);
        }
        const allowedCrud = new Set(['create', 'read', 'update', 'delete', 'bulk']);
        const crud = {};
        for (const [key, value] of Object.entries(entry.crud)) {
            if (!allowedCrud.has(key)) {
                reject(`${at}.crud has unknown operation "${key}" — only ${[...allowedCrud].join(', ')} are allowed`);
            }
            if (typeof value !== 'boolean') reject(`${at}.crud.${key} must be a boolean`);
            crud[key] = value;
        }

        const panel = {
            id: entry.id,
            bindsTo: entry.bindsTo,
            launch: 'nested',
            layout: entry.layout,
            fields,
            crud,
        };

        if (entry.sort !== undefined) {
            if (typeof entry.sort === 'string') {
                panel.sort = entry.sort;
            } else if (isPlainObject(entry.sort)) {
                requireNonEmptyString(entry.sort.field, `${at}.sort.field`);
                if (entry.sort.direction !== undefined) {
                    if (entry.sort.direction !== 'asc' && entry.sort.direction !== 'desc') {
                        reject(`${at}.sort.direction "${entry.sort.direction}" must be "asc" or "desc"`);
                    }
                }
                panel.sort = {
                    field: entry.sort.field,
                    ...(entry.sort.direction !== undefined ? { direction: entry.sort.direction } : {}),
                };
            } else {
                reject(`${at}.sort must be a string or { field, direction? }`);
            }
        }

        if (entry.reads !== undefined) {
            // R2: reads may name only this mod's own tables. Same hole as R1,
            // one field over: 4.2's descriptor used `reads: ['enemyCompendium']`.
            panel.reads = validateStringArray(entry.reads, `${at}.reads`);
            for (const name of panel.reads) {
                if (!tableNames.has(name)) {
                    reject(`${at}.reads "${name}" is not one of mod "${modId}"'s own tables`);
                }
            }
        }

        if (entry.search !== undefined) {
            if (typeof entry.search !== 'boolean') reject(`${at}.search must be a boolean`);
            panel.search = entry.search;
        }

        if (entry.filter !== undefined) {
            if (!isPlainObject(entry.filter)) reject(`${at}.filter must be an object`);
            requireNonEmptyString(entry.filter.field, `${at}.filter.field`);
            if (!Array.isArray(entry.filter.options) || entry.filter.options.length === 0) {
                reject(`${at}.filter.options must be a non-empty array`);
            }
            const filterOptions = entry.filter.options.map((opt, i) => {
                const optAt = `${at}.filter.options[${i}]`;
                if (!isPlainObject(opt)) reject(`${optAt} must be an object`);
                requireNonEmptyString(opt.value, `${optAt}.value`);
                requireNonEmptyString(opt.label, `${optAt}.label`);
                return { value: opt.value, label: opt.label };
            });
            panel.filter = {
                field: entry.filter.field,
                options: filterOptions,
                ...(typeof entry.filter.label === 'string' ? { label: entry.filter.label } : {}),
            };
        }

        // R3: hooks is rejected at load time. v1 defers panel logic.
        if (entry.hooks !== undefined) {
            reject(`${at}.hooks is not allowed on a mod panel — v1 defers panel logic; declare fields and crud only`);
        }
        // Forbidden keys: writes (a mod panel writes via crud on bindsTo only),
        // newRow (the renderer derives an empty row from fields — G2), and the
        // usual path/namespace forge set.
        const panelForbidden = ['writes', 'newRow', 'fileSuffix', 'filePath', 'path', 'compute'];
        for (const key of panelForbidden) {
            if (entry[key] !== undefined) {
                reject(`${at}.${key} is not allowed on a mod panel — a mod panel is declared, not code`);
            }
        }
        const allowed = new Set(['id', 'bindsTo', 'launch', 'layout', 'fields', 'crud', 'sort', 'reads', 'search', 'filter']);
        for (const key of Object.keys(entry)) {
            if (!allowed.has(key)) {
                reject(`${at} has unknown field "${key}" — only ${[...allowed].join(', ')} are allowed`);
            }
        }

        return panel;
    });

    return panels;
}

/**
 * WO-P5-17 — validate a mod's declared `screens` array. A screen is a mod's
 * OWN UI code, rendering in an isolated `<iframe srcdoc=…>` where it cannot
 * touch the app (10_PANEL_LIMITS.md §10.2; WORKORDER-P5-17 §1). Isolation is
 * the entire deliverable; the rulings R1–R6 are decided and load-time-
 * enforced here, in the same shape as `validatePanels`/`validateTables`:
 * allow-listed keys, ID_REGEX on ids, reject with a ModFault rather than
 * fail silently.
 *
 *   R2 — `file` is a sibling source file, read with `readFileSync(...,
 *        'utf-8')` and carried as text on the returned mod, exactly as
 *        `computeSource` is at modLoader.js:252-261. THE SERVER NEVER
 *        EVALUATES IT. The server holds the vault; mod code never runs on
 *        the machine with the keys.
 *   R6 — there is no `capabilities` field and no message channel. A 5.1
 *        screen receives nothing and sends nothing — useless on purpose.
 *
 * Fields: `id` (ID_REGEX), `file` (the sibling source, same resolution rules
 * as `compute.file`), `label`. No `launch` — R4 of WO-P5-16 already ruled
 * that mod UI lives nested in Extensions, and a screen does not change
 * that. No `capabilities` — there is no API to grant yet (R6).
 *
 * Returns `{ screens, sources }` — `sources[i]` is the text of
 * `screens[i].file`, so the host pairs declaration with source by index.
 */
function validateScreens(raw, modId, modDir) {
    if (raw === undefined) return { screens: [], sources: [] };
    if (!Array.isArray(raw)) reject('screens must be an array of screen declarations');

    const modRoot = fs.realpathSync(modDir);
    const seen = new Set();
    const screens = [];
    const sources = [];

    raw.forEach((entry, index) => {
        const at = `screens[${index}]`;
        if (!isPlainObject(entry)) reject(`${at} must be an object`);

        requireNonEmptyString(entry.id, `${at}.id`);
        if (!ID_REGEX.test(entry.id)) {
            reject(`${at}.id "${entry.id}" may contain only letters, digits, "_" and "-"`);
        }
        if (seen.has(entry.id)) reject(`${at}.id "${entry.id}" is declared more than once in mod "${modId}"`);
        seen.add(entry.id);

        requireNonEmptyString(entry.file, `${at}.file`);
        if (entry.file.includes('\\') || entry.file.includes('..') || entry.file.startsWith('/')) {
            reject(`${at}.file must be a relative path using forward slashes inside the mod's own folder`);
        }

        const requestedPath = path.resolve(modRoot, entry.file);
        let sourcePath;
        try {
            sourcePath = fs.realpathSync(requestedPath);
        } catch (err) {
            reject(`${at}.file "${entry.file}" could not be read: ` + (err?.message ?? String(err)));
        }
        const relative = path.relative(modRoot, sourcePath);
        if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
            reject(`${at}.file must resolve to a file inside the mod's own folder`);
        }

        let sourceText;
        try {
            sourceText = fs.readFileSync(sourcePath, 'utf-8');
        } catch (err) {
            reject(`${at}.file "${entry.file}" could not be read: ` + (err?.message ?? String(err)));
        }

        const screen = { id: entry.id, file: entry.file };
        if (entry.label !== undefined) {
            if (typeof entry.label !== 'string') reject(`${at}.label must be a string`);
            screen.label = entry.label;
        }

        // R6: no capabilities, no message channel, no host API in 5.1. The
        // frame receives nothing and sends nothing. Any of these fields is
        // a fault, not a pass — a mod that declares a channel is asking for
        // 5.2, and adding it now would be a stop condition, not initiative.
        const forbidden = ['capabilities', 'channel', 'postMessage', 'api', 'launch', 'hooks', 'compute'];
        for (const key of forbidden) {
            if (entry[key] !== undefined) {
                reject(`${at}.${key} is not allowed on a mod screen — v1 ships isolation only; a host API is a later sub-phase`);
            }
        }
        const allowed = new Set(['id', 'file', 'label']);
        for (const key of Object.keys(entry)) {
            if (!allowed.has(key)) {
                reject(`${at} has unknown field "${key}" — only ${[...allowed].join(', ')} are allowed`);
            }
        }

        screens.push(screen);
        sources.push(sourceText);
    });

    return { screens, sources };
}

/**
 * Validate a `string[]` field on a table declaration (reads/writes). A
 * non-array, or an array with a non-string or empty string, is a fault.
 */
function validateStringArray(value, at) {
    if (!Array.isArray(value)) reject(`${at} must be an array of strings`);
    for (const item of value) {
        if (typeof item !== 'string' || item.trim() === '') {
            reject(`${at} must contain only non-empty strings`);
        }
    }
    return [...value];
}

/**
 * Phase 1.3 / MANIFEST.md §6.2 — range satisfaction, shared by `appVersion`
 * and `dependencies`. Returns `true` if `version` (a numeric triple) satisfies
 * `range` (one of `"*"`, `">=X"`, `">=X.Y"`, `">=X.Y.Z"`). The grammar is
 * stricter than full semver on purpose: no upper bound, no caret/tilde, no
 * compound ranges (§6.2 "No upper bound in v1").
 *
 * The prerelease suffix of `version` is ignored for comparison — recorded
 * here so nobody assumes full semver precedence is implemented.
 */
function satisfiesRange(version, range) {
    if (range === '*') return true;
    const match = DEPENDENCY_RANGE_REGEX.exec(range);
    if (!match) return false;
    const floor = [Number(match[1]), Number(match[2] || 0), Number(match[3] || 0)];
    return compareVersions(version, floor) >= 0;
}

/**
 * Phase 1.3 / MANIFEST.md §11 "Paths" — shared containment check for mod-relative
 * path fields (`native.js`, `native.css`, `i18n[locale]`). Mirrors the
 * `compute.file` and `screens[].file` discipline: forward slashes only, no
 * leading `/`, no `..`, no backslash, and the resolved real path must lie
 * inside the mod's own folder.
 *
 * Returns the file's text (read with `readFileSync(..., 'utf-8')`), so callers
 * that need the contents (i18n, native) get it without re-reading. Callers
 * that only need the path (native.js/css, which the browser fetches later)
 * ignore the return value.
 *
 * `readErrorLabel` overrides the label used in the "could not be read" reason.
 * The Paths table (§11) uses `<at> "<path>"` for all path fields, but the i18n
 * table specifically says `i18n["<locale>"] file "<path>"` — i18n passes
 * `at + ' file'` so its read error carries the word "file" per the spec.
 */
function readModRelativeFile(modDir, rawFile, at, readErrorLabel) {
    const readAt = readErrorLabel ?? at;
    requireNonEmptyString(rawFile, `${at} must be a non-empty string`);
    if (rawFile.includes('\\')) reject(`${at} "${rawFile}" must use forward slashes`);
    if (rawFile.startsWith('/') || rawFile.includes('..')) {
        reject(`${at} "${rawFile}" must be a relative path inside the mod's own folder`);
    }

    const modRoot = fs.realpathSync(modDir);
    const requestedPath = path.resolve(modRoot, rawFile);
    let sourcePath;
    try {
        sourcePath = fs.realpathSync(requestedPath);
    } catch (err) {
        reject(`${readAt} "${rawFile}" could not be read: ${err?.message ?? String(err)}`);
    }
    const relative = path.relative(modRoot, sourcePath);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        reject(`${at} must resolve to a file inside the mod's own folder`);
    }

    try {
        return fs.readFileSync(sourcePath, 'utf-8');
    } catch (err) {
        reject(`${readAt} "${rawFile}" could not be read: ${err?.message ?? String(err)}`);
    }
}

/**
 * Phase 1.3 / MANIFEST.md §3 — `native` tier validation. Names and shapes
 * only; Phase 1.5 wires `import()` and Phase 1.4 wires the hooks. The
 * `native` entry point's `js`/`css` paths are validated as mod-relative
 * (§6.5) but NOT read here — the server never evaluates native code (§4).
 * Reading the file now would be eager I/O the browser never asked for, and
 * §6.6 says the loader "must not read asset files eagerly"; native source is
 * the same category, served by 1.5's asset route.
 *
 * `hooks` values and `generateInterceptor` are validated as non-empty
 * strings only. They name exports of `js`; whether those exports actually
 * exist is a Phase 1.5 runtime check, not a load-time one (a manifest can
 * name an export before the module is on disk, and the loader does not run
 * mod code).
 */
function validateNative(raw, modDir) {
    if (!isPlainObject(raw)) reject('native must be an object');

    requireNonEmptyString(raw.js, 'native.js must be a non-empty string');
    readModRelativeFile(modDir, raw.js, 'native.js');

    if (raw.css !== undefined) {
        if (typeof raw.css !== 'string') reject('native.css must be a string');
        if (raw.css !== '') readModRelativeFile(modDir, raw.css, 'native.css');
    }

    if (raw.hooks !== undefined) {
        if (!isPlainObject(raw.hooks)) {
            reject('native.hooks must be an object mapping hook names to exported function names');
        }
        for (const [hookName, exportName] of Object.entries(raw.hooks)) {
            if (!NATIVE_HOOK_NAMES.has(hookName)) {
                reject(`native.hooks has unknown hook "${hookName}" (allowed: ${[...NATIVE_HOOK_NAMES].join(', ')})`);
            }
            if (typeof exportName !== 'string' || exportName.trim() === '') {
                reject(`native.hooks.${hookName} must name an exported function`);
            }
        }
    }

    if (raw.generateInterceptor !== undefined) {
        if (typeof raw.generateInterceptor !== 'string' || raw.generateInterceptor.trim() === '') {
            reject('native.generateInterceptor must name an exported function');
        }
    }

    const allowed = new Set(['js', 'css', 'hooks', 'generateInterceptor']);
    for (const key of Object.keys(raw)) {
        if (!allowed.has(key)) {
            reject(`native has unknown field "${key}" — only js, css, hooks, generateInterceptor are allowed`);
        }
    }

    const native = { js: raw.js };
    if (raw.css !== undefined) native.css = raw.css;
    if (raw.hooks !== undefined) native.hooks = { ...raw.hooks };
    if (raw.generateInterceptor !== undefined) native.generateInterceptor = raw.generateInterceptor;
    return native;
}

/**
 * Phase 1.3 / MANIFEST.md §5 — `i18n` validation. Locale → flat-JSON
 * translation file. The host namespaces every key as `mod.<modId>.<key>` on
 * merge, so a mod can never overwrite a host string. `i18n` is DATA ONLY: a
 * locale file is never JS. Locale codes are not restricted to the host's six
 * — a mod may ship `fr` before the app does; unknown codes load and are
 * simply never selected.
 *
 * Returns `{ i18n: declarations, i18nStrings: parsed }` so the host can pair
 * the declaration (which locales the mod claims) with the contents (the
 * actual string maps), in the same order. The contents are read here because
 * a malformed locale file is a load-time rejection naming the locale and the
 * problem, not a runtime surprise when the user switches languages.
 */
function validateI18n(raw, modDir) {
    if (!isPlainObject(raw)) reject('i18n must be an object mapping locale codes to translation files');

    const i18n = {};
    const i18nStrings = {};

    for (const [locale, fileValue] of Object.entries(raw)) {
        if (!LOCALE_CODE_REGEX.test(locale)) {
            reject(`i18n key "${locale}" is not a locale code`);
        }
        if (typeof fileValue !== 'string' || fileValue.trim() === '') {
            reject(`i18n["${locale}"] must be a path to a JSON translation file`);
        }

        const text = readModRelativeFile(modDir, fileValue, `i18n["${locale}"]`, `i18n["${locale}"] file`);
        let parsed;
        try {
            parsed = JSON.parse(text);
        } catch (err) {
            reject(`i18n["${locale}"] file "${fileValue}" is not valid JSON: ${err.message}`);
        }
        if (!isPlainObject(parsed)) {
            reject(`i18n["${locale}"] must be a flat object of string keys to string values`);
        }
        const flat = {};
        for (const [key, value] of Object.entries(parsed)) {
            if (typeof value !== 'string') {
                reject(`i18n["${locale}"] must be a flat object of string keys to string values`);
            }
            flat[key] = value;
        }

        i18n[locale] = fileValue;
        i18nStrings[locale] = flat;
    }

    return { i18n, i18nStrings };
}

/**
 * Phase 1.3 / MANIFEST.md §6.4 — `dependencies` field validation. Shape and
 * range grammar only; resolution (present, loaded, version-satisfied) happens
 * after all mods are parsed, in `resolveDependenciesAndSort`. Returns the
 * validated `{ id: range }` map.
 *
 * A self-dependency is caught here (not in resolution) because it is a shape
 * fault on the dependent, not a relationship fault between two mods.
 */
function validateDependenciesField(raw, modId) {
    if (!isPlainObject(raw)) {
        reject('dependencies must be an object mapping mod ids to version ranges');
    }
    const dependencies = {};
    for (const [depId, range] of Object.entries(raw)) {
        if (!DEPENDENCY_KEY_REGEX.test(depId)) {
            reject(`dependencies key "${depId}" may contain only letters, digits, "_" and "-"`);
        }
        if (depId === modId) {
            reject(`dependencies names "${depId}", which is this mod`);
        }
        if (typeof range !== 'string') {
            reject(`dependencies["${depId}"] "${range}" must be ">=X.Y.Z" or "*"`);
        }
        const trimmed = range.trim();
        if (trimmed !== '*' && !DEPENDENCY_RANGE_REGEX.exec(trimmed)) {
            reject(`dependencies["${depId}"] "${range}" must be ">=X.Y.Z" or "*"`);
        }
        dependencies[depId] = trimmed;
    }
    return dependencies;
}

const KNOWN_ROLE_IDS = new Set(ROLE_IDS);

function validateRoles(raw) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) reject('roles must be an array of role ids');
    const seen = new Set();
    return raw.map((role, index) => {
        const at = 'roles[' + index + ']';
        if (typeof role !== 'string' || role.trim() === '') {
            reject(at + ' must be a non-empty role id');
        }
        const id = role.trim();
        if (!KNOWN_ROLE_IDS.has(id)) {
            reject(at + ' "' + id + '" is an unknown role id (known roles: ' + ROLE_IDS.join(', ') + ')');
        }
        if (seen.has(id)) reject('duplicate role id "' + id + '"');
        seen.add(id);
        return id;
    });
}

/**
 * Phase 7.3 — validate a mod's declared `tierEntries` array. A tier entry is a
 * DECLARATION, never code: the mod says "I have a feature that calls a model,
 * here is how the user's Lite/Pro/Max setting should gate it." The app's tier
 * matrix is the source of truth for built-in features; this lets a mod add its
 * own features to that matrix without core knowing about them.
 *
 * The shape mirrors `TierBlock` in `aiTier.ts` (id, name, description,
 * toggleable, trigger, defaultEnabled, callsModel) PLUS a per-tier `matrix`
 * (the gate values that `tierAllows` resolves) and an optional per-tier
 * `cooldown` (the scene-gap throttle pattern that `enemyDiscovery`
 * established).
 *
 * Validation follows the same shape as `validateTables` / `validatePanels`:
 * allow-listed keys, ID_REGEX on ids, reject with a ModFault rather than
 * fail silently. A malformed entry rejects THIS mod (not others).
 *
 * `cooldown` values are non-negative numbers. There is no `Infinity` in JSON;
 * a mod that wants "never" at a tier sets `matrix[tier] = false` (the tier
 * gate blocks it), not a cooldown. This is the "explicitly decide not to"
 * path for `enemyDiscovery` — its built-in cooldown stays on the standalone
 * `ENEMY_DISCOVERY_COOLDOWN` constant; when enemies moves to a mod (Phase 8),
 * the cooldown moves here with it.
 */
const TIER_TRIGGER_VALUES = new Set(['automatic', 'manual', 'unwired']);
const TIER_NAMES = ['lite', 'pro', 'max'];

function validateTierMatrix(raw, at) {
    if (!isPlainObject(raw)) reject(at + '.matrix must be an object with lite, pro, max boolean values');
    const matrix = {};
    for (const tier of TIER_NAMES) {
        if (typeof raw[tier] !== 'boolean') {
            reject(at + '.matrix.' + tier + ' must be a boolean');
        }
        matrix[tier] = raw[tier];
    }
    for (const key of Object.keys(raw)) {
        if (!TIER_NAMES.includes(key)) {
            reject(at + '.matrix has unknown tier "' + key + '" — only lite, pro, max are allowed');
        }
    }
    return matrix;
}

function validateTierCooldown(raw, at) {
    if (!isPlainObject(raw)) reject(at + '.cooldown must be an object with lite, pro, max number values');
    const cooldown = {};
    for (const tier of TIER_NAMES) {
        if (raw[tier] === undefined) continue;
        if (typeof raw[tier] !== 'number' || !Number.isFinite(raw[tier]) || raw[tier] < 0) {
            reject(at + '.cooldown.' + tier + ' must be a non-negative finite number');
        }
        cooldown[tier] = raw[tier];
    }
    for (const key of Object.keys(raw)) {
        if (!TIER_NAMES.includes(key)) {
            reject(at + '.cooldown has unknown tier "' + key + '" — only lite, pro, max are allowed');
        }
    }
    return Object.keys(cooldown).length > 0 ? cooldown : undefined;
}

function validateTierEntries(raw, modId) {
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) reject('tierEntries must be an array of tier entry declarations');

    const seen = new Set();
    return raw.map((entry, index) => {
        const at = 'tierEntries[' + index + ']';
        if (!isPlainObject(entry)) reject(at + ' must be an object');

        requireNonEmptyString(entry.id, at + '.id');
        if (!ID_REGEX.test(entry.id)) {
            reject(at + '.id "' + entry.id + '" may contain only letters, digits, "_" and "-"');
        }
        if (seen.has(entry.id)) reject(at + '.id "' + entry.id + '" is declared more than once in mod "' + modId + '"');
        seen.add(entry.id);

        requireNonEmptyString(entry.name, at + '.name');
        if (entry.description !== undefined && typeof entry.description !== 'string') {
            reject(at + '.description must be a string');
        }

        if (typeof entry.toggleable !== 'boolean') reject(at + '.toggleable must be a boolean');

        requireNonEmptyString(entry.trigger, at + '.trigger');
        if (!TIER_TRIGGER_VALUES.has(entry.trigger)) {
            reject(at + '.trigger "' + entry.trigger + '" must be one of ' + [...TIER_TRIGGER_VALUES].join(', '));
        }

        if (typeof entry.defaultEnabled !== 'boolean') reject(at + '.defaultEnabled must be a boolean');

        if (entry.callsModel !== undefined && typeof entry.callsModel !== 'boolean') {
            reject(at + '.callsModel must be a boolean');
        }

        const matrix = validateTierMatrix(entry.matrix, at);

        let cooldown;
        if (entry.cooldown !== undefined) {
            cooldown = validateTierCooldown(entry.cooldown, at);
        }

        // Forbidden keys: anything that would carry code or a path.
        const forbidden = ['fileSuffix', 'filePath', 'path', 'hooks', 'compute', 'native', 'file'];
        for (const key of forbidden) {
            if (entry[key] !== undefined) {
                reject(at + '.' + key + ' is not allowed on a tier entry — a tier entry is a declaration, not code');
            }
        }
        const allowed = new Set(['id', 'name', 'description', 'toggleable', 'trigger', 'defaultEnabled', 'callsModel', 'matrix', 'cooldown']);
        for (const key of Object.keys(entry)) {
            if (!allowed.has(key)) {
                reject(at + ' has unknown field "' + key + '" — only ' + [...allowed].join(', ') + ' are allowed');
            }
        }

        const tierEntry = {
            id: entry.id,
            name: entry.name,
            description: typeof entry.description === 'string' ? entry.description : '',
            toggleable: entry.toggleable,
            trigger: entry.trigger,
            defaultEnabled: entry.defaultEnabled,
            matrix,
        };
        if (entry.callsModel !== undefined) tierEntry.callsModel = entry.callsModel;
        if (cooldown !== undefined) tierEntry.cooldown = cooldown;
        return tierEntry;
    });
}

function validateMod(raw, file, appVersion, modDir) {
    if (!isPlainObject(raw)) reject('mod file must contain a JSON object');

    requireNonEmptyString(raw.id, 'id');
    if (!ID_REGEX.test(raw.id)) {
        reject(`id "${raw.id}" may contain only letters, digits, "_" and "-"`);
    }
    requireNonEmptyString(raw.name, 'name');
    requireNonEmptyString(raw.version, 'version');
    if (!MANIFEST_VERSION_REGEX.test(raw.version.trim())) {
        reject(`version "${raw.version}" must be X.Y.Z, optionally with a "-prerelease" suffix`);
    }
    if (raw.description !== undefined && typeof raw.description !== 'string') {
        reject('description must be a string');
    }

    // Phase 1.1 / MANIFEST.md §2 — `author` and `homepage` are the trust-
    // disclosure pair (TRUST.md §D). `author` is a non-empty string; `homepage`
    // is an http(s) URL rendered as text with a copyable link (the app never
    // auto-opens it). Both optional; absent means the disclosure has nothing
    // to show for this mod.
    if (raw.author !== undefined) {
        if (typeof raw.author !== 'string' || raw.author.trim() === '') {
            reject('author must be a non-empty string');
        }
    }
    if (raw.homepage !== undefined) {
        if (typeof raw.homepage !== 'string' || raw.homepage.trim() === '') {
            reject('homepage "' + raw.homepage + '" must be an http or https URL');
        }
        if (!/^https?:\/\//.test(raw.homepage.trim())) {
            reject('homepage "' + raw.homepage + '" must be an http or https URL');
        }
    }

    // Phase 1.3 / MANIFEST.md §2 — `loadOrder` is one integer an author
    // controls. Negative is allowed (so a mod can force itself before the
    // default 0 without a bidding war). Float, NaN, Infinity, and numeric
    // strings are all rejected; only Number.isInteger passes.
    if (raw.loadOrder !== undefined) {
        if (typeof raw.loadOrder !== 'number' || !Number.isInteger(raw.loadOrder)) {
            reject('loadOrder must be an integer');
        }
    }

    checkAppVersion(raw.appVersion, appVersion);

    // Phase 1.1 / MANIFEST.md §7.5 — `contributions` is now OPTIONAL. A
    // native-only mod (enemies, Phase 8) or a panel/screen-only mod
    // contributes no prompt text. The old "must be a non-empty array" rule
    // is replaced by the "declares nothing" check below: a manifest that
    // declares none of contributions/tables/panels/screens/compute/native/i18n
    // is a mod that does nothing, which is a typo, not an intention.
    let contributions = [];
    if (raw.contributions !== undefined) {
        if (!Array.isArray(raw.contributions) || raw.contributions.length === 0) {
            reject('contributions must be a non-empty array');
        }
        const seenIds = new Set();
        contributions = raw.contributions.map((c, i) => validateContribution(c, i, seenIds));
    }

    // WO-P5-05: validate declared data tables. Optional; absent = []. A
    // malformed table entry rejects this mod (not others). No descriptor is
    // built here — Step 2 derives suffixes and registers descriptors.
    const tables = validateTables(raw.tables, raw.id);

    // WO-P5-16: validate declared panels. Optional; absent = []. R1–R5 are
    // enforced here as load-time rejections, in the same shape as
    // validateTables: allow-listed keys, ID_REGEX on ids, reject with a
    // ModFault rather than fail silently. A malformed panel rejects this
    // mod (not others).
    const panels = validatePanels(raw.panels, raw.id, tables);

    // WO-P5-17: validate declared screens. Optional; absent = {[],[]}. R2
    // source loading and R6 (no host API) are enforced here as load-time
    // rejections, in the same shape as validatePanels/validateTables. A
    // malformed screen rejects this mod (not others). The source ships as
    // TEXT — the server never evaluates it (R2).
    const { screens, sources: screenSources } = validateScreens(raw.screens, raw.id, modDir);

    // Phase 1.3 / MANIFEST.md §6.4 — dependencies field shape. Resolution
    // (present, loaded, version-satisfied, no cycle) happens AFTER all mods
    // are parsed, in resolveDependenciesAndSort below. A self-dependency is
    // caught here because it is a shape fault on this mod, not a relationship
    // fault between two mods.
    let dependencies = {};
    if (raw.dependencies !== undefined) {
        dependencies = validateDependenciesField(raw.dependencies, raw.id);
    }
    const roles = validateRoles(raw.roles);
    const tierEntries = validateTierEntries(raw.tierEntries, raw.id);

    // Phase 1.3 / MANIFEST.md §5 — i18n. Optional; absent = {}. Read here so
    // a malformed locale file is a load-time fault naming the locale, not a
    // runtime surprise when the user switches languages. The parsed string
    // maps ship on the mod so the host merges them without re-reading disk.
    let i18n = {};
    let i18nStrings = {};
    if (raw.i18n !== undefined) {
        ({ i18n, i18nStrings } = validateI18n(raw.i18n, modDir));
    }

    // Phase 1.3 / MANIFEST.md §7.5 — a manifest that declares none of these
    // is a mod that does nothing, which is a typo, not an intention. This
    // replaces the old "contributions required" rule, which was accidentally
    // providing typo detection and would have rejected every native-only mod
    // in Phase 8.
    if (
        contributions.length === 0 &&
        tables.length === 0 &&
        panels.length === 0 &&
        screens.length === 0 &&
        raw.compute === undefined &&
        raw.native === undefined &&
        roles.length === 0 &&
        tierEntries.length === 0 &&
        Object.keys(i18n).length === 0
    ) {
        reject('manifest declares nothing — a mod must declare at least one of contributions, tables, panels, screens, compute, native, i18n, roles, tierEntries');
    }

    // Phase 1.3 / MANIFEST.md §3 — `native`. Its presence alone makes the mod
    // native-tier for trust and warning purposes (TRUST.md §B). The js/css
    // paths are validated as mod-relative but NOT read — the server never
    // evaluates native code (§4), and reading now would be eager I/O the
    // browser never asked for (§6.6).
    let native;
    if (raw.native !== undefined) {
        native = validateNative(raw.native, modDir);
    }

    // Phase 1.1 / MANIFEST.md §7.4 — unknown top-level keys are rejected, not
    // ignored. The forward-compatibility mechanism is `appVersion`: an author
    // using a field this host does not have declares `appVersion: ">=1.1.0"`
    // and gets a precise rejection on older hosts. Keys beginning `x-` are the
    // escape hatch (§2): allowed anywhere, never validated, never read.
    for (const key of Object.keys(raw)) {
        if (key.startsWith('x-')) continue;
        if (TOP_LEVEL_KEYS.has(key)) continue;
        if (key in ST_SPELLING_HINTS) {
            reject(`unknown field "${key}" — this app spells it "${ST_SPELLING_HINTS[key]}"`);
        }
        if (key in DECLINED_KEYS) {
            reject(DECLINED_KEYS[key]);
        }
        if (key in RESERVED_KEYS) {
            reject(`field "${key}" is reserved for a later app version (${RESERVED_KEYS[key]}) and is not supported yet`);
        }
        if (NATIVE_ONLY_TOP_LEVEL_KEYS.has(key)) {
            reject(`unknown field "${key}" — it belongs inside "native", which requires a native.js entry point`);
        }
        reject(`unknown field "${key}" — see MANIFEST.md for the field set`);
    }

    const mod = {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        description: typeof raw.description === 'string' ? raw.description : '',
        contributions,
        tables,
        panels,
        screens,
        screenSources,
        roles,
        tierEntries,
        file,
    };
    if (typeof raw.description === 'string') mod.description = raw.description;
    if (raw.author !== undefined) mod.author = raw.author;
    if (raw.homepage !== undefined) mod.homepage = raw.homepage;
    if (typeof raw.appVersion === 'string') mod.appVersion = raw.appVersion;
    // §6.3: loadOrder is one number; default 0. Carried on the mod so callers
    // (4.1 mount points, 5.2 interceptors) can use the resolved order without
    // re-reading the manifest.
    mod.loadOrder = typeof raw.loadOrder === 'number' ? raw.loadOrder : 0;
    // §6.4: the validated dependency map. Empty = no dependencies. The
    // resolver uses this to topologically sort mods before they reach the
    // caller.
    mod.dependencies = dependencies;
    // §5: locale → translation file declarations. The host uses these to know
    // which locales a mod claims; the parsed strings ship alongside.
    mod.i18n = i18n;
    mod.i18nStrings = i18nStrings;
    // §3: the native tier. Absent = no native code. Presence flags native-tier
    // trust (TRUST.md §B) and Phase 6.1 shows the verbatim warning before the
    // first enablement.
    if (native !== undefined) mod.native = native;
    if (raw.compute !== undefined) {
        Object.assign(mod, validateCompute(raw.compute, modDir, raw.id, new Set(tables.map((t) => t.name))));
    }
    return mod;
}

/**
 * Phase 1.3 / MANIFEST.md §6.3 — resolve dependencies and topologically sort.
 *
 * Resolved order = topological sort over `dependencies`, choosing among ready
 * mods by `loadOrder` ascending, then by `id` ascending. Deterministic, and
 * stable across filesystems (§6.3). A dependency therefore always precedes its
 * dependent even when its `loadOrder` is higher.
 *
 * This order governs: loader registration, lifecycle-hook firing (1.4),
 * mount-point render order (4.1), and interceptor order (5.2). Load order is
 * BEHAVIOUR, NOT STYLE; reordering changes execution. Callers must not
 * re-sort the returned `mods[]`.
 *
 * Faults produced here (missing dep, faulted dep, version unsatisfied, cycle)
 * remove ONLY the dependent mod and any mod that transitively depends on it.
 * A mod whose dependency is missing cannot be loaded in a consistent order, so
 * it is dropped; a mod whose dependency was dropped for a different reason
 * must also be dropped, because a dependent loading before its dependency is
 * the bug the topological sort exists to prevent. Independent mods keep loading
 * — that is the fail-safe contract (§7.4).
 *
 * A cycle is reported naming BOTH ids in the smallest cycle found, per §6.4
 * and the rejection table in §11. Self-dependency is already caught at
 * `validateDependenciesField` (it is a shape fault, not a relationship one).
 *
 * Phase 6.2 — the user-visible load order override.
 *
 * `userOrder` is an array of mod ids in the user's chosen order, persisted in
 * `settings.modLoadOrder`. When present, it is the PRIMARY tiebreak among
 * ready mods in the topological sort: a mod earlier in `userOrder` emits
 * before a mod later in `userOrder`, regardless of their manifest `loadOrder`.
 * The dependency graph is still a hard constraint — a dependency always
 * precedes its dependent — so `userOrder` only reorders mods that are
 * simultaneously ready (their dependencies already emitted). This is exactly
 * the "override persists and beats the manifest value" rule (Phase 6.2 §2.2).
 *
 * Mods not listed in `userOrder` (newly installed, or removed from the list)
 * fall back to `loadOrder` then `id`, the manifest default. This keeps the
 * override partial: the user does not have to rank every mod to reorder any.
 *
 * @param {object[]} mods - validated mods, in arbitrary order
 * @param {Map<string, string>} idToFile - mod id → manifest file label, for faults
 * @param {{ file: string, reason: string }[]} faults - append faults here
 * @param {readonly string[]} [userOrder] - Phase 6.2: user-chosen order, ids ascending
 * @returns {object[]} mods in resolved load order; faulted mods removed
 */
function resolveDependenciesAndSort(mods, idToFile, faults, userOrder) {
    const byId = new Map(mods.map((m) => [m.id, m]));
    const dropped = new Set();
    // Phase 6.2 — the user override position map. A mod's position in
    // `userOrder` is its primary tiebreak; mods absent from `userOrder`
    // get `Number.MAX_SAFE_INTEGER` so they sort after every listed mod
    // and fall back to `loadOrder` then `id` among themselves.
    const userPosition = new Map();
    if (Array.isArray(userOrder)) {
        for (let i = 0; i < userOrder.length; i++) {
            userPosition.set(userOrder[i], i);
        }
    }

    // ── Step 1: validate every dependency is present, loaded, and version-
    // satisfied. Drop the dependent on any failure. This is a property of
    // each mod independent of order; do it before the sort so the sort works
    // on a clean graph. §6.4.
    for (const mod of mods) {
        for (const [depId, range] of Object.entries(mod.dependencies)) {
            if (dropped.has(mod.id)) break;
            if (!byId.has(depId)) {
                faults.push({
                    file: idToFile.get(mod.id),
                    reason: `depends on mod "${depId}", which is not installed`,
                });
                dropped.add(mod.id);
                continue;
            }
            // A dependency that itself faulted at load is not in `mods`/`byId`,
            // so the `!byId.has(depId)` branch above already covered it. The
            // "present but faulted" reason in §11 is the same case from this
            // resolver's perspective; the distinction between "faulted at
            // validation" and "not installed at all" is not visible here, and
            // the user-facing message ("which is not installed") is honest
            // about the outcome (the dependency is not loadable).
            const dep = byId.get(depId);
            const depVersion = parseVersion(dep.version);
            if (!depVersion) {
                // The version regex already validated this at validateMod, so
                // this is unreachable. Belt-and-braces: drop rather than throw.
                faults.push({
                    file: idToFile.get(mod.id),
                    reason: `depends on mod "${depId}", which failed to load`,
                });
                dropped.add(mod.id);
                continue;
            }
            if (!satisfiesRange(depVersion, range)) {
                faults.push({
                    file: idToFile.get(mod.id),
                    reason: `depends on mod "${depId}" ${range}, but the installed version is ${dep.version}`,
                });
                dropped.add(mod.id);
            }
        }
    }

    // ── Step 2: cascade drops. A mod whose dependency was dropped cannot
    // load before its dependency, so it must also drop. Iterate to fixpoint
    // because a drop can expose a new drop (A→B→C, B drops, A must drop).
    let changed = true;
    while (changed) {
        changed = false;
        for (const mod of mods) {
            if (dropped.has(mod.id)) continue;
            for (const depId of Object.keys(mod.dependencies)) {
                if (dropped.has(depId)) {
                    faults.push({
                        file: idToFile.get(mod.id),
                        reason: `depends on mod "${depId}", which failed to load`,
                    });
                    dropped.add(mod.id);
                    changed = true;
                    break;
                }
            }
        }
    }

    const live = mods.filter((m) => !dropped.has(m.id));
    if (live.length === 0) return [];

    // ── Step 3: detect cycles among the survivors. A cycle is reported
    // naming BOTH ids in the smallest cycle found (§6.4). Self-dependency was
    // caught at validation; here we look for cycles of length ≥ 2.
    //
    // DFS with a recursion stack; when we revisit a node on the stack, the
    // slice from the first occurrence to the current node is a cycle. We
    // report the first one found — there may be more, but one cycle is enough
    // to stop the sort, and reporting one per fault is the contract (§7.4:
    // "one reason per rejection"). Every mod in a cycle is dropped.
    const cycleMembers = findCycle(live);
    if (cycleMembers) {
        const [a, b] = cycleMembers;
        for (const id of cycleMembers) {
            faults.push({
                file: idToFile.get(id),
                reason: `dependency cycle between "${a}" and "${b}"`,
            });
        }
        for (const id of cycleMembers) dropped.add(id);
    }
    const acyclic = live.filter((m) => !dropped.has(m.id));

    // ── Step 4: topological sort with `loadOrder` then `id` as the tie-break
    // (§6.3). Among mods whose dependencies are all already emitted, pick the
    // one with the lowest `loadOrder`, then the lowest `id`. Deterministic
    // across filesystems: the only inputs are the integers in the manifests
    // and the ids, both of which the loader has already canonicalised.
    const remaining = new Map(acyclic.map((m) => [m.id, m]));
    const emitted = new Set();
    const ordered = [];

    while (remaining.size > 0) {
        // Ready = every dependency already emitted. A mod with no
        // dependencies is always ready on the first pass.
        const ready = [...remaining.values()].filter(
            (m) => Object.keys(m.dependencies).every((depId) => emitted.has(depId)),
        );
        if (ready.length === 0) {
            // Should be unreachable after cycle detection. Belt-and-braces:
            // stop rather than infinite-loop. A remaining mod that is not
            // ready and not in a detected cycle means the cycle finder
            // missed one — keep the app alive by dropping the rest.
            for (const id of remaining.keys()) dropped.add(id);
            break;
        }
        ready.sort((a, b) => {
            // Phase 6.2 — user override is the primary tiebreak. A mod
            // listed in `userOrder` sorts before an unlisted one, and
            // before a mod later in the list. The dependency graph is
            // already satisfied (both are `ready`), so this is the
            // exact point the override is allowed to act.
            const ua = userPosition.has(a.id) ? userPosition.get(a.id) : Number.MAX_SAFE_INTEGER;
            const ub = userPosition.has(b.id) ? userPosition.get(b.id) : Number.MAX_SAFE_INTEGER;
            if (ua !== ub) return ua - ub;
            // Fall back to the manifest's `loadOrder`, then `id` (§6.3).
            if (a.loadOrder !== b.loadOrder) return a.loadOrder - b.loadOrder;
            return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
        });
        const next = ready[0];
        ordered.push(next);
        emitted.add(next.id);
        remaining.delete(next.id);
    }

    return ordered;
}

/**
 * Find one cycle in the dependency graph and return its members, or `null`
 * if the graph is acyclic. Returns the members of the smallest cycle found
 * (the first one DFS closes), so the rejection reason can name two of them
 * per §6.4. Members are returned in cycle order, starting from the node DFS
 * entered the cycle through.
 */
function findCycle(mods) {
    const adj = new Map(mods.map((m) => [m.id, Object.keys(m.dependencies)]));
    const visited = new Set();
    const stack = new Set();
    const path = [];

    const dfs = (id) => {
        if (stack.has(id)) {
            const start = path.indexOf(id);
            return path.slice(start);
        }
        if (visited.has(id)) return null;
        visited.add(id);
        stack.add(id);
        path.push(id);
        for (const dep of adj.get(id) || []) {
            if (!adj.has(dep)) continue; // dep not in `mods`; resolver drops the dependent
            const cycle = dfs(dep);
            if (cycle) return cycle;
        }
        stack.delete(id);
        path.pop();
        return null;
    };

    for (const mod of mods) {
        if (visited.has(mod.id)) continue;
        const cycle = dfs(mod.id);
        if (cycle) return cycle;
    }
    return null;
}

/**
 * Phase 6.3 — the two provenances a mod may carry.
 *
 * `bundled` mods ship with the app (live in `public/bundled-mods/`, on by default,
 * version moves with app updates). `installed` mods live in the user's `mods/`
 * folder and are never touched by an app update. Both use the same loader, the
 * same validation, and the same lifecycle — the tag is display and update-
 * behaviour only, never a special case in the validation path.
 *
 * Stamped on every validated mod by `loadModsFromDir` so the client can show a
 * "Bundled" badge in the Extensions screen and hide the delete affordance for
 * bundled mods (Phase 6.3 §2.5 recommendation).
 */
const PROVENANCE_BUNDLED = 'bundled';
const PROVENANCE_INSTALLED = 'installed';

/**
 * Phase 6.3 — scan ONE mods directory and append its validated mods/faults to the
 * shared `mods`/`faults`/`claimedIds` accumulators, stamping each mod with the
 * given `provenance` tag.
 *
 * Extracted from `loadMods` so `loadMods` can scan two directories (bundled then
 * installed) without duplicating the per-folder walk. A bundled mod is NOT
 * special-cased in the validation path (§3): the same `validateMod`, the same
 * faults, the same `ModRejected` handling. The only difference is the
 * `provenance` field stamped on the validated mod.
 *
 * @param {string} modsDir Directory to scan. Missing = append nothing.
 * @param {string} appVersion Host app version, for `appVersion` compatibility checks.
 * @param {object[]} mods Accumulator — validated mods are pushed here.
 * @param {{ file: string, reason: string }[]} faults Accumulator — faults are pushed here.
 * @param {Map<string, string>} claimedIds mod id → file label, for duplicate-id detection.
 * @param {'bundled' | 'installed'} provenance The provenance tag to stamp on each mod.
 */
function loadModsFromDir(modsDir, appVersion, mods, faults, claimedIds, provenance) {
    let entries;
    try {
        entries = fs.readdirSync(modsDir, { withFileTypes: true });
    } catch (err) {
        // No mods folder is the normal state of a fresh install, not a fault.
        // This applies to BOTH the bundled dir (a packaged layout may omit it)
        // and the installed dir (the user has not added anything yet).
        if (err && err.code === 'ENOENT') return;
        faults.push({ file: String(modsDir), reason: `mods directory unreadable: ${err?.message ?? String(err)}` });
        return;
    }

    const sortedEntries = [...entries].sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of sortedEntries) {
        if (entry.name.startsWith('.')) continue;

        if (entry.isFile()) {
            if (entry.name.toLowerCase().endsWith(MOD_FILE_SUFFIX)) {
                faults.push({
                    file: entry.name,
                    reason: `flat mod files are no longer supported — move "${entry.name}" and its sibling sources into mods/<mod-id>/manifest.json`,
                });
            }
            continue;
        }

        if (entry.isDirectory()) {
            const folderName = entry.name;
            const modDir = path.join(modsDir, folderName);
            const manifestPath = path.join(modDir, 'manifest.json');
            const fileLabel = `${folderName}/manifest.json`;

            if (!fs.existsSync(manifestPath)) {
                faults.push({
                    file: folderName,
                    reason: `directory "${folderName}" contains no manifest.json — a mod folder must contain one`,
                });
                continue;
            }

            let text;
            try {
                text = fs.readFileSync(manifestPath, 'utf-8');
            } catch (err) {
                faults.push({
                    file: fileLabel,
                    reason: `manifest.json could not be read: ${err?.message ?? String(err)}`,
                });
                continue;
            }

            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (err) {
                faults.push({
                    file: fileLabel,
                    reason: `invalid JSON: ${err.message}`,
                });
                continue;
            }

            try {
                const mod = validateMod(parsed, fileLabel, appVersion, modDir);

                const claimedBy = claimedIds.get(mod.id);
                if (claimedBy) {
                    reject(`duplicate mod id "${mod.id}" (already declared by ${claimedBy})`);
                }
                claimedIds.set(mod.id, fileLabel);

                // §6.6 / Phase 1.5: carry the mod's folder name and absolute
                // folder path so later phases can serve files from it without
                // re-reading the manifest or re-walking the directory. The
                // loader must not read asset files eagerly (§6.6); `folder` is
                // the path, not the contents.
                mod.folder = folderName;
                mod.folderPath = modDir;
                // Phase 6.3 — stamp the provenance so the client can show a
                // "Bundled" badge and hide the delete affordance. The tag is
                // display + update behaviour only; it is never read by the
                // validation path (§3: a bundled mod is not special-cased).
                mod.provenance = provenance;

                mods.push(mod);
            } catch (err) {
                faults.push({
                    file: fileLabel,
                    reason: err instanceof ModRejected ? err.message : `unreadable: ${err?.message ?? String(err)}`,
                });
            }
        }
    }
}

/**
 * Load and validate every folder containing `manifest.json` in `modsDir`, plus
 * every folder in `bundledModsDir` (Phase 6.3) when that argument is supplied.
 *
 * Phase 6.3 — two provenances, one loader. Bundled mods (from `bundledModsDir`)
 * are scanned first and tagged `provenance: 'bundled'`; installed mods (from
 * `modsDir`) are scanned second and tagged `provenance: 'installed'`. Both
 * use the exact same `validateMod` path — a bundled mod is not special-cased
 * (§3). A duplicate mod id across the two directories is a fault on the
 * second one, exactly as it would be within one directory.
 *
 * Phase 6.2 — `userOrder` is the optional user-chosen order (array of mod ids)
 * that overrides the manifest's `loadOrder` as the primary tiebreak in the
 * topological sort. The dependency graph is still a hard constraint; the
 * override only reorders mods that are simultaneously ready. See
 * `resolveDependenciesAndSort` for the exact rule.
 *
 * @param {string} modsDir Installed mods directory. Missing = no installed mods.
 * @param {string} [appVersion] Host app version, for `appVersion` compatibility checks.
 * @param {readonly string[]} [userOrder] Phase 6.2: user-chosen order, ids ascending.
 * @param {string} [bundledModsDir] Phase 6.3: bundled mods directory. Missing/absent = no bundled scan.
 * @returns {{ mods: object[], faults: { file: string, reason: string }[] }}
 */
export function loadMods(modsDir, appVersion, userOrder, bundledModsDir) {
    const mods = [];
    const faults = [];
    const claimedIds = new Map();

    // Phase 6.3 — scan the bundled directory first so a bundled mod's id is
    // claimed before any installed mod with the same id. The bundled mod wins
    // and the installed duplicate is faulted, which is the right outcome: a
    // user who drops a folder with the same id as a bundled mod has made a
    // mistake, and the bundled mod is the one the app depends on. Scanning
    // bundled first means `claimedIds` already has the bundled id when the
    // installed dir is walked, so the duplicate is reported on the installed
    // copy (the user's file), not the bundled one.
    if (typeof bundledModsDir === 'string' && bundledModsDir.length > 0) {
        loadModsFromDir(bundledModsDir, appVersion, mods, faults, claimedIds, PROVENANCE_BUNDLED);
    }
    if (typeof modsDir === 'string' && modsDir.length > 0) {
        loadModsFromDir(modsDir, appVersion, mods, faults, claimedIds, PROVENANCE_INSTALLED);
    }

    // Phase 1.3 / MANIFEST.md §6.3 — resolve dependencies and topologically
    // sort. Faults produced here (missing dep, faulted dep, version
    // unsatisfied, cycle) are appended to `faults` and the dependent is
    // removed from `mods`. Independent mods keep loading — the fail-safe
    // contract (§7.4) still holds. The returned `mods` are in resolved load
    // order; callers MUST NOT re-sort.
    const idToFile = new Map(mods.map((m) => [m.id, m.file]));
    const ordered = resolveDependenciesAndSort(mods, idToFile, faults, userOrder);

    return { mods: ordered, faults };
}
