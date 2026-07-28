import { randomUUID } from 'node:crypto';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const textFields = [
    'aliases', 'classification', 'description', 'threatTier', 'faction',
    'tactics', 'loot', 'gmNotes',
];
const listFields = [
    'tags', 'passiveTraits', 'specialBehaviors', 'weaknesses', 'resistances',
];

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
        const normalized = { name, [valueKey]: detail };
        if (valueKey === 'description') {
            const abilityId = nullableText(item.abilityId, `${path}[${index}].abilityId`, errors);
            if (abilityId) normalized.abilityId = abilityId;
        }
        return [normalized];
    });
};

/**
 * Validates one API-supplied enemy and returns a known-field-only normalized
 * record. Optional null values mean "not used"; incompatible non-null values
 * are reported so malformed API clients cannot persist crash-prone data.
 */
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

/** Validates and normalizes the complete compendium used by the PUT endpoint. */
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

/** Builds a safe empty template snapshot for instances missing one. */
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

/**
 * Validates one enemy instance (a mutable encounter copy). Optional null fields
 * mean "unused"; incompatible non-null values are reported. The templateSnapshot
 * is recursively validated so a malformed snapshot cannot crash the combat UI.
 */
export function validateEnemyInstance(value, index = 0) {
    const path = `enemyInstances[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };

    // templateSnapshot is optional — null/missing means "unused" and backfills a
    // default empty template. A present-but-malformed snapshot is reported.
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

/**
 * Validates one encounter wave. Instance ids are strings; missing ids drop.
 */
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

const ENCOUNTER_STATUSES = new Set(['active', 'paused', 'ended']);

/** Validates one encounter (a grouping of instance ids into waves). */
export function validateEnemyEncounter(value, index = 0) {
    const path = `enemyEncounters[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };
    const status = ENCOUNTER_STATUSES.has(value.status) ? value.status : 'active';
    if (value.status != null && !ENCOUNTER_STATUSES.has(value.status)) {
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

const ENCOUNTER_OUTCOMES = new Set(['victory', 'partial', 'defeat', 'escaped', 'negotiated', 'other']);
const INSTANCE_DISPOSITIONS = new Set(['archive', 'discard']);

/** Validates one immutable encounter resolution record. */
export function validateEnemyResolution(value, index = 0) {
    const path = `enemyResolutions[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };
    const outcome = ENCOUNTER_OUTCOMES.has(value.outcome) ? value.outcome : 'other';
    if (value.outcome != null && !ENCOUNTER_OUTCOMES.has(value.outcome)) {
        errors.push(`${path}.outcome must be one of victory, partial, defeat, escaped, negotiated, other or null`);
    }
    const instanceDisposition = INSTANCE_DISPOSITIONS.has(value.instanceDisposition) ? value.instanceDisposition : 'archive';
    if (value.instanceDisposition != null && !INSTANCE_DISPOSITIONS.has(value.instanceDisposition)) {
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

const INITIATIVE_MODES = new Set(['manual', 'd20', 'd100']);
const BARRIER_MODES = new Set(['manual', 'absorb-first']);

/**
 * Validates the optional enemy combat configuration. Optional null fields mean
 * "unused"; incompatible non-null values are reported. The enemyDiscoveryEnabled
 * flag is preserved as-is here (the hydrator and runtime tier gate enforce the
 * default-OFF + tier policy); this validator only guards against crash-prone
 * non-boolean / non-numeric values.
 */
export function validateEnemyCombatConfig(value) {
    const errors = [];
    if (value == null) return { value: null, errors };
    if (!isRecord(value)) return { value: null, errors: ['Enemy combat configuration must be an object'] };

    const initiativeMode = INITIATIVE_MODES.has(value.initiativeMode) ? value.initiativeMode : 'manual';
    if (value.initiativeMode != null && !INITIATIVE_MODES.has(value.initiativeMode)) {
        errors.push('enemyCombatConfig.initiativeMode must be one of manual, d20, d100 or null');
    }
    const barrierMode = BARRIER_MODES.has(value.barrierMode) ? value.barrierMode : 'absorb-first';
    if (value.barrierMode != null && !BARRIER_MODES.has(value.barrierMode)) {
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
