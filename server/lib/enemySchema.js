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
        return [{ name, [valueKey]: detail }];
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
