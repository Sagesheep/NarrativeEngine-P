import { randomUUID } from 'crypto';

const CATEGORIES = new Set([
    'active', 'passive', 'reaction', 'sustained', 'transformation', 'summon',
    'stance', 'ritual', 'crafting', 'narrative-permission', 'other',
]);
const ORIGINS = new Set([
    'innate', 'trained', 'spell', 'item-granted', 'enemy-action', 'lore-granted', 'other',
]);

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value, path, errors, max = 4_000) => {
    if (value == null) return '';
    if (typeof value !== 'string') {
        errors.push(`${path} must be a string or null`);
        return '';
    }
    return value.trim().slice(0, max);
};

const nonNegativeInteger = (value, path, errors) => {
    if (value == null) return 0;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push(`${path} must be a non-negative finite number or null`);
        return 0;
    }
    return Math.floor(value);
};

export function validateAbilityProposal(value, index = 0, now = Date.now()) {
    const path = `abilityProposals[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };

    const kind = value.kind === 'new' || value.kind === 'assign' || value.kind === 'progression'
        ? value.kind
        : null;
    if (!kind) errors.push(`${path}.kind must be new, assign, or progression`);
    const abilityId = text(value.abilityId, `${path}.abilityId`, errors, 160);
    const abilityName = text(value.abilityName, `${path}.abilityName`, errors, 120);
    if (kind === 'new' && !abilityName) errors.push(`${path}.abilityName is required for new proposals`);
    if ((kind === 'assign' || kind === 'progression') && !abilityId) {
        errors.push(`${path}.abilityId is required for ${kind} proposals`);
    }

    const requestedOwnerType = value.ownerType;
    const ownerType = requestedOwnerType === 'pc' || requestedOwnerType === 'npc'
        ? requestedOwnerType
        : null;
    if (requestedOwnerType != null && !ownerType) {
        errors.push(`${path}.ownerType must be pc, npc, or null`);
    }
    const ownerId = text(value.ownerId, `${path}.ownerId`, errors, 160);
    if ((kind === 'assign' || kind === 'progression') && (!ownerType || !ownerId)) {
        errors.push(`${path} must identify an owner for ${kind} proposals`);
    }

    const category = typeof value.category === 'string' && CATEGORIES.has(value.category)
        ? value.category
        : 'other';
    const origin = typeof value.origin === 'string' && ORIGINS.has(value.origin)
        ? value.origin
        : 'trained';
    const createdAt = value.createdAt == null ? now : value.createdAt;
    const updatedAt = value.updatedAt == null ? now : value.updatedAt;
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) {
        errors.push(`${path}.createdAt must be a finite number or null`);
    }
    if (typeof updatedAt !== 'number' || !Number.isFinite(updatedAt)) {
        errors.push(`${path}.updatedAt must be a finite number or null`);
    }

    return {
        value: {
            id: text(value.id, `${path}.id`, errors, 160) || randomUUID(),
            kind,
            abilityId,
            abilityName,
            ownerType: ownerType && ownerId ? ownerType : null,
            ownerId: ownerType ? ownerId : '',
            category,
            origin,
            effect: text(value.effect, `${path}.effect`, errors),
            activation: text(value.activation, `${path}.activation`, errors),
            mastery: text(value.mastery, `${path}.mastery`, errors, 120),
            masteryTierId: text(value.masteryTierId, `${path}.masteryTierId`, errors, 160),
            modification: text(value.modification, `${path}.modification`, errors, 500),
            upgradeId: text(value.upgradeId, `${path}.upgradeId`, errors, 160),
            trainingDelta: nonNegativeInteger(value.trainingDelta, `${path}.trainingDelta`, errors),
            reason: text(value.reason, `${path}.reason`, errors, 500),
            evidence: text(value.evidence, `${path}.evidence`, errors, 1_000),
            sourceSceneId: text(value.sourceSceneId, `${path}.sourceSceneId`, errors, 160),
            sourceProfileAbility: text(value.sourceProfileAbility, `${path}.sourceProfileAbility`, errors, 1_000) || undefined,
            createdAt,
            updatedAt,
        },
        errors,
    };
}

export function validateAbilityProposals(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Ability proposals must be an array'] };
    const checked = value.map((entry, index) => validateAbilityProposal(entry, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}
