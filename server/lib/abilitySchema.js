import { randomUUID } from 'node:crypto';

const CATEGORIES = new Set([
    'active', 'passive', 'reaction', 'sustained', 'transformation', 'summon',
    'stance', 'ritual', 'crafting', 'narrative-permission', 'other',
]);
const TEXT_FIELDS = [
    'aliases', 'description', 'appearance', 'activation', 'range', 'targets',
    'duration', 'area', 'effect', 'outcomeGuidance', 'source', 'gmNotes',
];
const LIST_FIELDS = ['limitations', 'counters', 'prerequisites', 'tags'];

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

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

const nullableCosts = (value, path, errors) => {
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
        const resource = nullableText(item.resource, `${path}[${index}].resource`, errors);
        if (!resource) {
            errors.push(`${path}[${index}].resource is required`);
            return [];
        }
        return [{
            resource,
            amount: nullableText(item.amount, `${path}[${index}].amount`, errors),
            timing: nullableText(item.timing, `${path}[${index}].timing`, errors),
            condition: nullableText(item.condition, `${path}[${index}].condition`, errors),
        }];
    });
};

/** Validates and strips unknown fields from one API-supplied definition. */
export function validateAbilityEntry(value, index = 0, now = Date.now()) {
    const path = `abilities[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };

    const name = nullableText(value.name, `${path}.name`, errors);
    if (!name) errors.push(`${path}.name is required`);
    const category = value.category == null ? 'active' : value.category;
    if (typeof category !== 'string' || !CATEGORIES.has(category)) {
        errors.push(`${path}.category must be a supported ability category or null`);
    }

    const normalized = {
        id: nullableText(value.id, `${path}.id`, errors) || randomUUID(),
        name,
        aliases: '',
        category: CATEGORIES.has(category) ? category : 'active',
        description: '',
        appearance: '',
        activation: '',
        costs: nullableCosts(value.costs, `${path}.costs`, errors),
        range: '',
        targets: '',
        duration: '',
        area: '',
        effect: '',
        outcomeGuidance: '',
        limitations: [],
        counters: [],
        prerequisites: [],
        tags: [],
        source: '',
        gmNotes: '',
        promptEnabled: value.promptEnabled == null ? true : value.promptEnabled,
        createdAt: value.createdAt == null ? now : value.createdAt,
        updatedAt: value.updatedAt == null ? now : value.updatedAt,
    };

    for (const field of TEXT_FIELDS) normalized[field] = nullableText(value[field], `${path}.${field}`, errors);
    for (const field of LIST_FIELDS) normalized[field] = nullableStringList(value[field], `${path}.${field}`, errors);
    if (typeof normalized.promptEnabled !== 'boolean') errors.push(`${path}.promptEnabled must be a boolean or null`);
    if (typeof normalized.createdAt !== 'number' || !Number.isFinite(normalized.createdAt)) {
        errors.push(`${path}.createdAt must be a finite number or null`);
    }
    if (typeof normalized.updatedAt !== 'number' || !Number.isFinite(normalized.updatedAt)) {
        errors.push(`${path}.updatedAt must be a finite number or null`);
    }
    return { value: normalized, errors };
}

/** Validates and normalizes the complete library used by the PUT endpoint. */
export function validateAbilityCompendium(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Ability compendium must be an array'] };
    const checked = value.map((entry, index) => validateAbilityEntry(entry, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}
