import { randomUUID } from 'node:crypto';

const CATEGORIES = new Set([
    'active', 'passive', 'reaction', 'sustained', 'transformation', 'summon',
    'stance', 'ritual', 'crafting', 'narrative-permission', 'other',
]);
const ORIGINS = new Set([
    'innate', 'trained', 'spell', 'item-granted', 'enemy-action', 'lore-granted', 'other',
]);
const TEXT_FIELDS = [
    'aliases', 'description', 'appearance', 'activation', 'range', 'targets',
    'duration', 'area', 'effect', 'outcomeGuidance', 'source', 'gmNotes',
    'sourceInventoryItemId', 'loreCheckNotes',
];
const LIST_FIELDS = ['limitations', 'counters', 'prerequisites', 'tags', 'interactionTags', 'counterTags'];

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

const nullableMasteryLadder = (value, path, errors) => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array or null`);
        return [];
    }
    return value.flatMap((item, index) => {
        if (!isRecord(item)) {
            errors.push(`${path}[${index}] must be an object`);
            return [];
        }
        const name = nullableText(item.name, `${path}[${index}].name`, errors);
        if (!name) {
            errors.push(`${path}[${index}].name is required`);
            return [];
        }
        return [{
            id: nullableText(item.id, `${path}[${index}].id`, errors) || randomUUID(),
            name,
            requirements: nullableText(item.requirements, `${path}[${index}].requirements`, errors),
            benefits: nullableText(item.benefits, `${path}[${index}].benefits`, errors),
        }];
    });
};

const nullableUpgradeNodes = (value, path, errors) => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array or null`);
        return [];
    }
    return value.flatMap((item, index) => {
        if (!isRecord(item)) {
            errors.push(`${path}[${index}] must be an object`);
            return [];
        }
        const name = nullableText(item.name, `${path}[${index}].name`, errors);
        if (!name) {
            errors.push(`${path}[${index}].name is required`);
            return [];
        }
        return [{
            id: nullableText(item.id, `${path}[${index}].id`, errors) || randomUUID(),
            branch: nullableText(item.branch, `${path}[${index}].branch`, errors),
            name,
            description: nullableText(item.description, `${path}[${index}].description`, errors),
            prerequisiteTierId: nullableText(item.prerequisiteTierId, `${path}[${index}].prerequisiteTierId`, errors),
            prerequisiteUpgradeIds: nullableStringList(
                item.prerequisiteUpgradeIds,
                `${path}[${index}].prerequisiteUpgradeIds`,
                errors,
            ),
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
    const tags = nullableStringList(value.tags, `${path}.tags`, errors);
    const inferredOrigin = [name, ...tags].join(' ').toLowerCase().match(/\b(spell|cantrip)\b/)
        ? 'spell'
        : 'trained';
    const origin = value.origin == null ? inferredOrigin : value.origin;
    if (typeof origin !== 'string' || !ORIGINS.has(origin)) {
        errors.push(`${path}.origin must be a supported ability origin or null`);
    }
    const loreStatus = value.loreStatus == null ? 'unverified' : value.loreStatus;
    if (!['unverified', 'verified', 'flagged'].includes(loreStatus)) {
        errors.push(`${path}.loreStatus must be unverified, verified, flagged, or null`);
    }

    const normalized = {
        id: nullableText(value.id, `${path}.id`, errors) || randomUUID(),
        name,
        aliases: '',
        category: CATEGORIES.has(category) ? category : 'active',
        origin: ORIGINS.has(origin) ? origin : inferredOrigin,
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
        interactionTags: [],
        counterTags: [],
        sourceInventoryItemId: '',
        inventoryRequiresEquipped: value.inventoryRequiresEquipped == null ? true : value.inventoryRequiresEquipped,
        loreCheckRequired: value.loreCheckRequired == null ? false : value.loreCheckRequired,
        loreStatus: ['verified', 'flagged'].includes(loreStatus) ? loreStatus : 'unverified',
        loreCheckNotes: '',
        loreCheckedAt: value.loreCheckedAt == null ? null : value.loreCheckedAt,
        masteryLadder: nullableMasteryLadder(value.masteryLadder, `${path}.masteryLadder`, errors),
        upgradeNodes: nullableUpgradeNodes(value.upgradeNodes, `${path}.upgradeNodes`, errors),
        tags: [],
        source: '',
        gmNotes: '',
        promptEnabled: value.promptEnabled == null ? true : value.promptEnabled,
        createdAt: value.createdAt == null ? now : value.createdAt,
        updatedAt: value.updatedAt == null ? now : value.updatedAt,
    };

    for (const field of TEXT_FIELDS) normalized[field] = nullableText(value[field], `${path}.${field}`, errors);
    for (const field of LIST_FIELDS) {
        normalized[field] = field === 'tags' ? tags : nullableStringList(value[field], `${path}.${field}`, errors);
    }
    if (typeof normalized.inventoryRequiresEquipped !== 'boolean') {
        errors.push(`${path}.inventoryRequiresEquipped must be a boolean or null`);
    }
    if (typeof normalized.loreCheckRequired !== 'boolean') {
        errors.push(`${path}.loreCheckRequired must be a boolean or null`);
    }
    if (normalized.loreCheckedAt !== null
        && (typeof normalized.loreCheckedAt !== 'number' || !Number.isFinite(normalized.loreCheckedAt))) {
        errors.push(`${path}.loreCheckedAt must be a finite number or null`);
    }
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
