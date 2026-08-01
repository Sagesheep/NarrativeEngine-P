import fs from 'fs';
import path from 'path';

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
    'addEnemySuggestions',
    'setDivergenceRegister',
    'addNpcSuggestions',
    'archiveNPC',
    'restoreNPC',
    'onDirectorBriefPhase',
    'updatePlayerCharacter',
    'setCharacterProfileData',
    'setInventoryItems',
    'setLocationLedger',
    'addLocationSuggestions',
]);
const COMPUTE_TABLE_READS = new Set(['archive', 'divergence', 'enemies', 'locations', 'npcs']);
const COMPUTE_TABLE_WRITES = new Set(['archive', 'locations', 'npcs']);
const COMPUTE_MODEL_ROLES = new Set(['story', 'utility', 'auxiliary', 'summariser', 'raw-auxiliary', 'raw-summariser']);

/**
 * WO-P5-05 §2: the only two record shapes a mod table may declare. The app
 * uses this only to pick the right empty default (`[]` vs `null`).
 */
const TABLE_RECORD_SHAPES = new Set(['array', 'single-object']);

/** v1 supports exactly two forms: `">=X.Y.Z"` (Y and Z optional) and `"*"`. */
const APP_VERSION_REGEX = /^>=\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?$/;

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

function validateComputeCapability(value, index) {
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
        const allowed = operation === 'read' ? COMPUTE_TABLE_READS : COMPUTE_TABLE_WRITES;
        if (!allowed.has(table)) {
            reject(at + ' names an unavailable ' + operation + ' table "' + table + '"');
        }
        return value;
    }

    reject(at + ' must be write:<name> or table:<read|write>:<name>');
}

function validateCompute(raw, modsDir) {
    if (!isPlainObject(raw)) reject('compute must be an object');

    requireNonEmptyString(raw.file, 'compute.file');
    if (raw.file.includes('/') || raw.file.includes('\\') || raw.file.includes('..')) {
        reject('compute.file must be a plain filename inside the mods directory');
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
        const capability = validateComputeCapability(value, index);
        if (seen.has(capability)) reject('duplicate compute capability "' + capability + '"');
        seen.add(capability);
        return capability;
    });

    const modsRoot = fs.realpathSync(modsDir);
    const requestedPath = path.resolve(modsRoot, raw.file);
    let sourcePath;
    try {
        sourcePath = fs.realpathSync(requestedPath);
    } catch (err) {
        reject('compute.file "' + raw.file + '" could not be read: ' + (err?.message ?? String(err)));
    }
    const relative = path.relative(modsRoot, sourcePath);
    if (relative === '' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
        reject('compute.file must resolve to a file inside the mods directory');
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

function validateMod(raw, file, appVersion, modsDir) {
    if (!isPlainObject(raw)) reject('mod file must contain a JSON object');

    requireNonEmptyString(raw.id, 'id');
    if (!ID_REGEX.test(raw.id)) {
        reject(`id "${raw.id}" may contain only letters, digits, "_" and "-"`);
    }
    requireNonEmptyString(raw.name, 'name');
    requireNonEmptyString(raw.version, 'version');
    if (raw.description !== undefined && typeof raw.description !== 'string') {
        reject('description must be a string');
    }

    checkAppVersion(raw.appVersion, appVersion);

    if (!Array.isArray(raw.contributions) || raw.contributions.length === 0) {
        reject('contributions must be a non-empty array');
    }

    const seenIds = new Set();
    const contributions = raw.contributions.map((c, i) => validateContribution(c, i, seenIds));

    // WO-P5-05: validate declared data tables. Optional; absent = []. A
    // malformed table entry rejects this mod (not others). No descriptor is
    // built here — Step 2 derives suffixes and registers descriptors.
    const tables = validateTables(raw.tables, raw.id);

    const mod = {
        id: raw.id,
        name: raw.name,
        version: raw.version,
        description: typeof raw.description === 'string' ? raw.description : '',
        contributions,
        tables,
        file,
    };
    if (typeof raw.appVersion === 'string') mod.appVersion = raw.appVersion;
    if (raw.compute !== undefined) Object.assign(mod, validateCompute(raw.compute, modsDir));
    return mod;
}

/**
 * Load and validate every `*.mod.json` in `modsDir`.
 *
 * @param {string} modsDir Directory to scan. Missing = `{ mods: [], faults: [] }`.
 * @param {string} [appVersion] Host app version, for `appVersion` compatibility checks.
 * @returns {{ mods: object[], faults: { file: string, reason: string }[] }}
 */
export function loadMods(modsDir, appVersion) {
    const mods = [];
    const faults = [];

    let entries;
    try {
        entries = fs.readdirSync(modsDir, { withFileTypes: true });
    } catch (err) {
        // No mods folder is the normal state of a fresh install, not a fault.
        if (err && err.code === 'ENOENT') return { mods, faults };
        return {
            mods,
            faults: [{ file: String(modsDir), reason: `mods directory unreadable: ${err?.message ?? String(err)}` }],
        };
    }

    // Sorted so "first wins" on a duplicate id is deterministic rather than filesystem-ordered.
    const files = entries
        .filter((e) => e.isFile() && e.name.toLowerCase().endsWith(MOD_FILE_SUFFIX))
        .map((e) => e.name)
        .sort();

    const claimedIds = new Map();

    for (const file of files) {
        try {
            const text = fs.readFileSync(path.join(modsDir, file), 'utf-8');
            let parsed;
            try {
                parsed = JSON.parse(text);
            } catch (err) {
                reject(`invalid JSON: ${err.message}`);
            }

            const mod = validateMod(parsed, file, appVersion, modsDir);

            const claimedBy = claimedIds.get(mod.id);
            if (claimedBy) reject(`duplicate mod id "${mod.id}" (already declared by ${claimedBy})`);
            claimedIds.set(mod.id, file);

            mods.push(mod);
        } catch (err) {
            faults.push({
                file,
                reason: err instanceof ModRejected ? err.message : `unreadable: ${err?.message ?? String(err)}`,
            });
        }
    }

    return { mods, faults };
}
