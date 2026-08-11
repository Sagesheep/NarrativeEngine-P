// Phase 8.2 — the ported validator.
//
// Source: `server/lib/enemySchema.js` (443 lines, 6 exported validators, 8
// internal helpers, 5 locally-mirrored `Set` wrappers of the shared enum
// arrays, inline `DEFAULT_ENEMY_COMBAT_CONFIG`). Per Phase 8.2 §5 item 2 and
// the D2 decision (§0), the mod carries the coercion, the defaults and the
// shape repair in its own native code and runs it **on write and on read**.
//
// Why a mod-local copy and not `import ... from '@narrative/engine/enemy/enemyShape'`:
// the engine's `enemyShape.ts` is the shared *shape* (field-name lists + enum
// sets + type guards). The validation/normalization *logic* never lived in
// the engine — it lived in the server's `enemySchema.js` and the client's
// `enemySchema.ts`, which are hand-kept mirrors the engine was extracted FROM
// (WO-P5-03 Step 4). The mod takes the server's logic verbatim because the
// server is the one that runs the all-or-nothing import validation 8.2 §0 D2
// item 2 names as the guarantee that retires. The client mirror stays in core
// until 8.5; the mod does not need it because the mod never hydrates from
// disk (the host's table adapter does that, and the mod's `onRead` repairs
// whatever the host handed it).
//
// AMENDED BY PHASE 8.5. The paragraph that used to sit here argued that the
// shared shape constants could be imported from `@narrative/engine`, because
// the engine is a package the host depends on rather than app source. That is
// true of the host's build and false of a mod: a mod is fetched from disk and
// evaluated by the browser as a plain ES module, with no bundler and no import
// map, so a bare specifier resolves to nothing. The constants are inlined
// below, and flag #5 is answered — the mod owns the shape. See that comment.
//
// The 14 asymmetries between the server and client mirrors (ENEMY_SEAM §4.5)
// are not reproduced across `validate*`: those functions are the server mirror,
// full stop, and the differential test
// (`server/__tests__/enemyValidatorPort.test.js`) pins them against the frozen
// pre-extraction schema on forty-odd malformed inputs.
//
// AMENDED BY PHASE 8.5 for one of them. Asymmetry #13 — the server keeps a
// `null` where a bad record was, because its caller (the PUT route) rejected
// the whole payload on `errors.length`. After the extraction there is no such
// caller: the `repair*` wrappers ARE the last word on the read path, and a
// `null` reaching the UI takes the compendium window down. The wrappers now
// drop unusable rows, which is what the CLIENT normalizer did on that same
// path before the extraction. See the comment above `repairCompendium`; the
// differential test records it as a named, deliberate divergence.
//
// ID generation: the server uses `randomUUID` from `node:crypto`; the mod
// runs in the browser via `import()`, where `crypto.randomUUID()` is a global
// (Web Crypto API). The mod uses the browser global. The differential test
// injects a deterministic `createId` into both sides so the generated ids
// agree; in production the ids differ (server vs browser crypto) but the
// *shape* and *repair* are identical, which is what the port guarantees.

// ── The shape (Phase 8.5, ENEMY_SEAM §8 flag #5) ────────────────────────────
//
// These seven lists used to be imported from `@narrative/engine/enemy/enemyShape`.
// Phase 8.5 answered flag #5 — "does the engine keep owning the enemy shape, or
// does the mod become the shape authority?" — with **the mod**, and deleted the
// engine's copy. Two reasons, and only the second one is architectural:
//
//   1. It could not have worked. A mod is fetched from disk and evaluated by
//      the browser as a plain ES module; there is no bundler and no import map
//      in that path, so a bare specifier like `@narrative/engine/...` has
//      nothing to resolve against. The comment above anticipated the inlining
//      as a possibility. It was already required.
//   2. After 8.2 deleted the server validator and 8.3/8.4 the client
//      normalizer, the engine's copy had zero runtime consumers, and no
//      third-party enemy mod could have imported it either — for reason 1.
//
// So the shape lives with the code that validates against it, which is the one
// arrangement where the two cannot drift apart. Values are verbatim from the
// deleted `packages/engine/src/enemy/enemyShape.ts`.
const ENEMY_TEXT_FIELDS = Object.freeze([
    'aliases', 'classification', 'description', 'threatTier', 'faction',
    'tactics', 'loot', 'gmNotes',
]);
const ENEMY_LIST_FIELDS = Object.freeze([
    'tags', 'passiveTraits', 'specialBehaviors', 'weaknesses', 'resistances',
]);
const ENCOUNTER_STATUSES = Object.freeze(['active', 'paused', 'ended']);
const ENCOUNTER_OUTCOMES = Object.freeze([
    'victory', 'partial', 'defeat', 'escaped', 'negotiated', 'other',
]);
const INSTANCE_DISPOSITIONS = Object.freeze(['archive', 'discard']);
const INITIATIVE_MODES = Object.freeze(['manual', 'd20', 'd100']);
const BARRIER_MODES = Object.freeze(['manual', 'absorb-first']);

/**
 * The full `EnemyEntry` field set, in the order the validator builds it. The
 * engine's copy carried a compile-time assertion pinning `keyof EnemyEntry` to
 * this list; a JSON-manifest mod cannot hold one. What replaces it is that
 * there is now only ONE list — the mirrors it existed to keep honest are gone.
 */
export const ENEMY_ENTRY_FIELDS = Object.freeze([
    'id', 'name', 'aliases', 'classification', 'description', 'threatTier', 'tags',
    'faction', 'stats', 'actions', 'passiveTraits', 'specialBehaviors',
    'weaknesses', 'resistances', 'tactics', 'loot', 'gmNotes',
    'promptEnabled', 'createdAt', 'updatedAt',
]);

// `crypto.randomUUID()` is a browser global (Web Crypto API). The server's
// `enemySchema.js` uses `import { randomUUID } from 'node:crypto'`; the mod
// runs in the browser via `import()`, so it uses the global instead. Bind to
// a local so the call sites read the same as the server's.
const randomUUID = () => crypto.randomUUID();

// ── Internal helpers (verbatim from server/lib/enemySchema.js:18-71, 141-167) ──

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const textFields = ENEMY_TEXT_FIELDS;
const listFields = ENEMY_LIST_FIELDS;

const nullableText = (value, path, errors) => {
    if (value == null) return '';
    if (typeof value !== 'string') {
        errors.push(`${path} must be a string or null`);
        return '';
    }
    return value.trim();
};

const nullableStringList = (value, path, errors) => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array or null`);
        return [];
    }
    return value.flatMap((item, index) => {
        if (item == null) return [];
        if (typeof item !== 'string') {
            errors.push(`${path}[${index}] must be a string or null`);
            return [];
        }
        const normalized = item.trim();
        return normalized ? [normalized] : [];
    });
};

const nullablePairs = (value, path, valueKey, errors) => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array or null`);
        return [];
    }
    return value.flatMap((item, index) => {
        if (item == null) return [];
        if (!isRecord(item)) {
            errors.push(`${path}[${index}] must be an object or null`);
            return [];
        }
        const name = nullableText(item.name, `${path}[${index}].name`, errors);
        const detail = nullableText(item[valueKey], `${path}[${index}].${valueKey}`, errors);
        if (!name) {
            errors.push(`${path}[${index}].name is required`);
            return [];
        }
        return [{ name, [valueKey]: detail }];
    });
};

const finiteNumber = (value, path, errors, fallback = 0) => {
    if (value == null) return fallback;
    const num = Number(value);
    if (!Number.isFinite(num)) {
        errors.push(`${path} must be a finite number or null`);
        return fallback;
    }
    return num;
};

const optionalBoolean = (value, path, errors, fallback = false) => {
    if (value == null) return fallback;
    if (typeof value !== 'boolean') {
        errors.push(`${path} must be a boolean or null`);
        return fallback;
    }
    return value;
};

const optionalString = (value, path, errors, fallback = '') => {
    if (value == null) return fallback;
    if (typeof value !== 'string') {
        errors.push(`${path} must be a string or null`);
        return fallback;
    }
    return value.trim();
};

function createDefaultSnapshot(templateId, displayName) {
    const now = Date.now();
    return {
        id: templateId || randomUUID(),
        name: displayName || 'Unknown Enemy',
        aliases: '',
        classification: '',
        description: '',
        threatTier: '',
        tags: [],
        faction: '',
        stats: [],
        actions: [],
        passiveTraits: [],
        specialBehaviors: [],
        weaknesses: [],
        resistances: [],
        tactics: '',
        loot: '',
        gmNotes: '',
        promptEnabled: true,
        createdAt: now,
        updatedAt: now,
    };
}

// ── The 6 exported validators (verbatim from server/lib/enemySchema.js:78-443) ──

export function validateEnemyEntry(value, index = 0, now = Date.now()) {
    const path = `enemies[${index}]`;
    const errors = [];
    if (!isRecord(value)) {
        return { value: null, errors: [`${path} must be an object`] };
    }

    const name = nullableText(value.name, `${path}.name`, errors);
    if (!name) errors.push(`${path}.name is required`);
    const normalized = {
        id: nullableText(value.id, `${path}.id`, errors) || randomUUID(),
        name,
        aliases: '',
        classification: '',
        description: '',
        threatTier: '',
        tags: [],
        faction: '',
        stats: nullablePairs(value.stats, `${path}.stats`, 'value', errors),
        actions: nullablePairs(value.actions, `${path}.actions`, 'description', errors),
        passiveTraits: [],
        specialBehaviors: [],
        weaknesses: [],
        resistances: [],
        tactics: '',
        loot: '',
        gmNotes: '',
        promptEnabled: value.promptEnabled == null ? true : value.promptEnabled,
        createdAt: value.createdAt == null ? now : value.createdAt,
        updatedAt: value.updatedAt == null ? now : value.updatedAt,
    };

    for (const field of textFields) {
        normalized[field] = nullableText(value[field], `${path}.${field}`, errors);
    }
    for (const field of listFields) {
        normalized[field] = nullableStringList(value[field], `${path}.${field}`, errors);
    }
    if (typeof normalized.promptEnabled !== 'boolean') {
        errors.push(`${path}.promptEnabled must be a boolean or null`);
    }
    if (typeof normalized.createdAt !== 'number' || !Number.isFinite(normalized.createdAt)) {
        errors.push(`${path}.createdAt must be a finite number or null`);
    }
    if (typeof normalized.updatedAt !== 'number' || !Number.isFinite(normalized.updatedAt)) {
        errors.push(`${path}.updatedAt must be a finite number or null`);
    }

    return { value: normalized, errors };
}

export function validateEnemyCompendium(value) {
    if (!Array.isArray(value)) {
        return { value: null, errors: ['Enemy compendium must be an array'] };
    }
    const checked = value.map((entry, index) => validateEnemyEntry(entry, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}

function validateEnemyWave(value, index) {
    const path = `waves[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };
    const instanceIds = nullableStringList(value.instanceIds, `${path}.instanceIds`, errors);
    const activeInstanceIds = nullableStringList(value.activeInstanceIds, `${path}.activeInstanceIds`, errors);
    return {
        value: {
            id: optionalString(value.id, `${path}.id`, errors) || randomUUID(),
            name: optionalString(value.name, `${path}.name`, errors, 'Wave'),
            instanceIds,
            activeInstanceIds,
            createdAt: finiteNumber(value.createdAt, `${path}.createdAt`, errors, Date.now()),
            updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`, errors, Date.now()),
        },
        errors,
    };
}

const ENCOUNTER_STATUSES_SET = new Set(ENCOUNTER_STATUSES);

export function validateEnemyEncounter(value, index = 0) {
    const path = `enemyEncounters[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };
    const status = ENCOUNTER_STATUSES_SET.has(value.status) ? value.status : 'active';
    if (value.status != null && !ENCOUNTER_STATUSES_SET.has(value.status)) {
        errors.push(`${path}.status must be one of active, paused, ended or null`);
    }
    const waves = Array.isArray(value.waves)
        ? value.waves.map((wave, i) => validateEnemyWave(wave, i))
        : (value.waves == null ? [] : (errors.push(`${path}.waves must be an array or null`), []));
    const waveErrors = waves.flatMap(w => w.errors);
    errors.push(...waveErrors);
    return {
        value: {
            id: optionalString(value.id, `${path}.id`, errors) || randomUUID(),
            name: optionalString(value.name, `${path}.name`, errors, 'Untitled Encounter'),
            status,
            waves: waves.map(w => w.value),
            activeWaveId: optionalString(value.activeWaveId, `${path}.activeWaveId`, errors)
                || (waves.length ? (waves[0].value?.id ?? '') : ''),
            createdAt: finiteNumber(value.createdAt, `${path}.createdAt`, errors, Date.now()),
            updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`, errors, Date.now()),
            ...(value.endedAt != null ? { endedAt: finiteNumber(value.endedAt, `${path}.endedAt`, errors, undefined) } : {}),
            ...(value.resolutionId != null ? { resolutionId: optionalString(value.resolutionId, `${path}.resolutionId`, errors) } : {}),
        },
        errors,
    };
}

export function validateEnemyEncounters(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Enemy encounters must be an array'] };
    const checked = value.map((item, index) => validateEnemyEncounter(item, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}

const ENCOUNTER_OUTCOMES_SET = new Set(ENCOUNTER_OUTCOMES);
const INSTANCE_DISPOSITIONS_SET = new Set(INSTANCE_DISPOSITIONS);

export function validateEnemyInstance(value, index = 0) {
    const path = `enemyInstances[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };

    const templateId = optionalString(value.templateId, `${path}.templateId`, errors);
    let templateSnapshot;
    if (value.templateSnapshot == null) {
        templateSnapshot = { value: createDefaultSnapshot(templateId, optionalString(value.displayName, `${path}.displayName`, errors)), errors: [] };
    } else {
        const checked = validateEnemyEntry(value.templateSnapshot, 0);
        templateSnapshot = { value: checked.value, errors: checked.errors.map(e => `${path}.templateSnapshot: ${e}`) };
    }
    errors.push(...templateSnapshot.errors);

    const displayName = optionalString(value.displayName, `${path}.displayName`, errors, 'Unknown Enemy');
    const conditions = nullableStringList(value.conditions, `${path}.conditions`, errors);
    const cooldowns = Array.isArray(value.cooldowns)
        ? value.cooldowns.flatMap((item, i) => {
            if (!isRecord(item)) { errors.push(`${path}.cooldowns[${i}] must be an object`); return []; }
            return [{
                id: optionalString(item.id, `${path}.cooldowns[${i}].id`, errors) || randomUUID(),
                name: optionalString(item.name, `${path}.cooldowns[${i}].name`, errors),
                remainingRounds: Math.max(0, Math.floor(finiteNumber(item.remainingRounds, `${path}.cooldowns[${i}].remainingRounds`, errors, 0))),
            }];
        })
        : (value.cooldowns == null ? [] : (errors.push(`${path}.cooldowns must be an array or null`), []));
    const resources = Array.isArray(value.resources)
        ? value.resources.flatMap((item, i) => {
            if (!isRecord(item)) { errors.push(`${path}.resources[${i}] must be an object`); return []; }
            const max = Math.max(0, finiteNumber(item.max, `${path}.resources[${i}].max`, errors, 0));
            const current = Math.min(max, Math.max(0, finiteNumber(item.current, `${path}.resources[${i}].current`, errors, 0)));
            return [{
                id: optionalString(item.id, `${path}.resources[${i}].id`, errors) || randomUUID(),
                name: optionalString(item.name, `${path}.resources[${i}].name`, errors, 'Resource'),
                current,
                max,
            }];
        })
        : (value.resources == null ? [] : (errors.push(`${path}.resources must be an array or null`), []));
    const temporaryModifiers = Array.isArray(value.temporaryModifiers)
        ? value.temporaryModifiers.flatMap((item, i) => {
            if (!isRecord(item)) { errors.push(`${path}.temporaryModifiers[${i}] must be an object`); return []; }
            return [{
                id: optionalString(item.id, `${path}.temporaryModifiers[${i}].id`, errors) || randomUUID(),
                name: optionalString(item.name, `${path}.temporaryModifiers[${i}].name`, errors),
                value: optionalString(item.value, `${path}.temporaryModifiers[${i}].value`, errors),
            }];
        })
        : (value.temporaryModifiers == null ? [] : (errors.push(`${path}.temporaryModifiers must be an array or null`), []));

    return {
        value: {
            id: optionalString(value.id, `${path}.id`, errors) || randomUUID(),
            templateId,
            templateSnapshot: templateSnapshot.value,
            displayName,
            currentHp: Math.max(0, finiteNumber(value.currentHp, `${path}.currentHp`, errors, 0)),
            maxHp: Math.max(0, finiteNumber(value.maxHp, `${path}.maxHp`, errors, 0)),
            currentBarrier: Math.max(0, finiteNumber(value.currentBarrier, `${path}.currentBarrier`, errors, 0)),
            maxBarrier: Math.max(0, finiteNumber(value.maxBarrier, `${path}.maxBarrier`, errors, 0)),
            conditions,
            temporaryModifiers,
            defeated: optionalBoolean(value.defeated, `${path}.defeated`, errors, false),
            initiative: value.initiative == null ? null : finiteNumber(value.initiative, `${path}.initiative`, errors, 0),
            actionsRemaining: Math.max(0, Math.floor(finiteNumber(value.actionsRemaining, `${path}.actionsRemaining`, errors, 0))),
            actionsPerTurn: Math.max(0, Math.floor(finiteNumber(value.actionsPerTurn, `${path}.actionsPerTurn`, errors, 1))),
            cooldowns,
            resources,
            createdAt: finiteNumber(value.createdAt, `${path}.createdAt`, errors, Date.now()),
            updatedAt: finiteNumber(value.updatedAt, `${path}.updatedAt`, errors, Date.now()),
        },
        errors,
    };
}

export function validateEnemyInstances(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Enemy instances must be an array'] };
    const checked = value.map((item, index) => validateEnemyInstance(item, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}

export function validateEnemyResolution(value, index = 0) {
    const path = `enemyResolutions[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };
    const outcome = ENCOUNTER_OUTCOMES_SET.has(value.outcome) ? value.outcome : 'other';
    if (value.outcome != null && !ENCOUNTER_OUTCOMES_SET.has(value.outcome)) {
        errors.push(`${path}.outcome must be one of victory, partial, defeat, escaped, negotiated, other or null`);
    }
    const instanceDisposition = INSTANCE_DISPOSITIONS_SET.has(value.instanceDisposition) ? value.instanceDisposition : 'archive';
    if (value.instanceDisposition != null && !INSTANCE_DISPOSITIONS_SET.has(value.instanceDisposition)) {
        errors.push(`${path}.instanceDisposition must be one of archive, discard or null`);
    }
    const archivedInstances = Array.isArray(value.archivedInstances)
        ? value.archivedInstances.map((item, i) => validateEnemyInstance(item, i))
        : (value.archivedInstances == null ? [] : (errors.push(`${path}.archivedInstances must be an array or null`), []));
    const archivedErrors = archivedInstances.flatMap(r => r.errors);
    errors.push(...archivedErrors);
    return {
        value: {
            id: optionalString(value.id, `${path}.id`, errors) || randomUUID(),
            encounterId: optionalString(value.encounterId, `${path}.encounterId`, errors),
            encounterName: optionalString(value.encounterName, `${path}.encounterName`, errors, 'Encounter'),
            outcome,
            summary: optionalString(value.summary, `${path}.summary`, errors, 'Encounter ended.'),
            xpAwarded: Math.max(0, finiteNumber(value.xpAwarded, `${path}.xpAwarded`, errors, 0)),
            lootAwarded: nullableStringList(value.lootAwarded, `${path}.lootAwarded`, errors),
            otherRewards: nullableStringList(value.otherRewards, `${path}.otherRewards`, errors),
            participantNames: nullableStringList(value.participantNames, `${path}.participantNames`, errors),
            instanceDisposition,
            archivedInstances: archivedInstances.map(r => r.value),
            ...(value.timelineEventId != null ? { timelineEventId: optionalString(value.timelineEventId, `${path}.timelineEventId`, errors) } : {}),
            resolvedAt: finiteNumber(value.resolvedAt, `${path}.resolvedAt`, errors, Date.now()),
        },
        errors,
    };
}

export function validateEnemyResolutions(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Enemy resolutions must be an array'] };
    const checked = value.map((item, index) => validateEnemyResolution(item, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}

const INITIATIVE_MODES_SET = new Set(INITIATIVE_MODES);
const BARRIER_MODES_SET = new Set(BARRIER_MODES);

export function validateEnemyCombatConfig(value) {
    const errors = [];
    if (value == null) return { value: null, errors };
    if (!isRecord(value)) return { value: null, errors: ['Enemy combat configuration must be an object'] };

    const initiativeMode = INITIATIVE_MODES_SET.has(value.initiativeMode) ? value.initiativeMode : 'manual';
    if (value.initiativeMode != null && !INITIATIVE_MODES_SET.has(value.initiativeMode)) {
        errors.push('enemyCombatConfig.initiativeMode must be one of manual, d20, d100 or null');
    }
    const barrierMode = BARRIER_MODES_SET.has(value.barrierMode) ? value.barrierMode : 'absorb-first';
    if (value.barrierMode != null && !BARRIER_MODES_SET.has(value.barrierMode)) {
        errors.push('enemyCombatConfig.barrierMode must be one of manual, absorb-first or null');
    }
    return {
        value: {
            promptContextEnabled: optionalBoolean(value.promptContextEnabled, 'enemyCombatConfig.promptContextEnabled', errors, true),
            enemyDiscoveryEnabled: optionalBoolean(value.enemyDiscoveryEnabled, 'enemyCombatConfig.enemyDiscoveryEnabled', errors, false),
            enabled: optionalBoolean(value.enabled, 'enemyCombatConfig.enabled', errors, false),
            initiativeMode,
            initiativeModifierStat: optionalString(value.initiativeModifierStat, 'enemyCombatConfig.initiativeModifierStat', errors, ''),
            barrierMode,
            autoDefeatAtZeroHp: optionalBoolean(value.autoDefeatAtZeroHp, 'enemyCombatConfig.autoDefeatAtZeroHp', errors, true),
            weaknessMultiplier: Math.max(0, finiteNumber(value.weaknessMultiplier, 'enemyCombatConfig.weaknessMultiplier', errors, 2)),
            resistanceMultiplier: Math.max(0, finiteNumber(value.resistanceMultiplier, 'enemyCombatConfig.resistanceMultiplier', errors, 0.5)),
            actionsEnabled: optionalBoolean(value.actionsEnabled, 'enemyCombatConfig.actionsEnabled', errors, false),
            defaultActionsPerTurn: Math.max(0, Math.floor(finiteNumber(value.defaultActionsPerTurn, 'enemyCombatConfig.defaultActionsPerTurn', errors, 1))),
            cooldownsEnabled: optionalBoolean(value.cooldownsEnabled, 'enemyCombatConfig.cooldownsEnabled', errors, false),
            resourcesEnabled: optionalBoolean(value.resourcesEnabled, 'enemyCombatConfig.resourcesEnabled', errors, false),
        },
        errors,
    };
}

// ── The inline DEFAULT_ENEMY_COMBAT_CONFIG (E8 — the server's copy lives at
//    enemySchema.js:427-439 inside validateEnemyCombatConfig; the client's
//    copy lives at src/services/enemy/enemyCombat.ts:9-23. This is the third
//    copy. 8.5 consolidates when the files move; for 8.2 the mod needs its
//    own because the mod's onRead for the config table backfills this when
//    the table is empty, the same way the server's GET endpoint returns null
//    and the hydrator normalizes via normalizeEnemyCombatConfig.) ──

export const DEFAULT_ENEMY_COMBAT_CONFIG = Object.freeze({
    promptContextEnabled: true,
    enemyDiscoveryEnabled: false,
    enabled: false,
    initiativeMode: 'manual',
    initiativeModifierStat: '',
    barrierMode: 'absorb-first',
    autoDefeatAtZeroHp: true,
    weaknessMultiplier: 2,
    resistanceMultiplier: 0.5,
    actionsEnabled: false,
    defaultActionsPerTurn: 1,
    cooldownsEnabled: false,
    resourcesEnabled: false,
});

// ── The onRead / onWrite repair entry points (D2 — run on both sides) ──
//
// The mod's data logic (index.js) calls these before every ctx.table.write
// and after every ctx.table.read. On write, the validator reports errors
// the mod can surface (via ctx.log) and writes the repaired value anyway —
// the server's all-or-nothing import validation (E25) is one of the
// guarantees D2 item 2 names as retiring; the mod writes what it is given,
// repaired to a safe shape. On read, the validator repairs whatever the
// host handed it, so observable behaviour is unchanged even if a corrupt
// table was written from outside the app (D2 item 1 — the guarantee that
// is knowingly reduced, written into 9.9.5's honesty list).
//
// The five table-specific repair functions return the repaired value
// directly (not the {value, errors} pair) because the mod's data logic
// always writes the repaired value; the errors are for logging only.

// ── The repair wrappers — the READ path (Phase 8.2 D2, corrected in 8.5) ────
//
// `validate*` above is the SERVER mirror, verbatim, and it is deliberately
// exact: `server/__tests__/enemyValidatorPort.test.js` pins it against the
// frozen pre-extraction schema across forty-odd malformed inputs.
//
// But the server mirror was written for a caller that REJECTS. The PUT route
// returned 400 when `errors.length`, so its "keep a `null` at the index where a
// bad record was" behaviour (ENEMY_SEAM.md §4.5 asymmetry #13) never reached
// anything that read it. On the read path there is no such caller: after the
// extraction these wrappers ARE the last word, and a `null` in the array goes
// straight to the UI, which does `item.name` on it and takes the whole
// compendium window down with it.
//
// Found by the differential test, on the shape a real messy save has: one
// malformed record among good ones. Under the old code the CLIENT normalizer
// (`normalizeEnemyEntries`) dropped those records on read, so this restores the
// behaviour that was actually in front of users, on the path it was on.
//
// So the split is deliberate and this is the record of it:
//   • `validate*` — the server mirror, exact, proven equal to the old schema.
//   • `repair*`   — the read path: same repairs, PLUS unusable rows dropped.
// A dropped row is one the old app never showed either. It is not a row being
// lost — the legacy file still holds it, unmodified, and the warning below
// names the index.

/** Rows the validator could not make usable. Never shown before; never shown now. */
const usableRows = rows => (Array.isArray(rows) ? rows.filter(row => row != null) : []);

export function repairCompendium(value) {
    const checked = validateEnemyCompendium(value);
    if (checked.errors.length) {
        console.warn('[enemies] compendium table had repair errors:', checked.errors);
    }
    return usableRows(checked.value);
}

export function repairInstances(value) {
    const checked = validateEnemyInstances(value);
    if (checked.errors.length) {
        console.warn('[enemies] instances table had repair errors:', checked.errors);
    }
    return usableRows(checked.value);
}

export function repairEncounters(value) {
    const checked = validateEnemyEncounters(value);
    if (checked.errors.length) {
        console.warn('[enemies] encounters table had repair errors:', checked.errors);
    }
    return usableRows(checked.value);
}

export function repairResolutions(value) {
    const checked = validateEnemyResolutions(value);
    if (checked.errors.length) {
        console.warn('[enemies] resolutions table had repair errors:', checked.errors);
    }
    return usableRows(checked.value);
}

export function repairConfig(value) {
    const checked = validateEnemyCombatConfig(value);
    if (checked.errors.length) {
        console.warn('[enemies] config table had repair errors:', checked.errors);
    }
    // The config table is single-object; a null/missing config backfills the
    // defaults, matching the server's GET endpoint (returns null) + the
    // hydrator's normalizeEnemyCombatConfig.
    return checked.value ?? { ...DEFAULT_ENEMY_COMBAT_CONFIG };
}