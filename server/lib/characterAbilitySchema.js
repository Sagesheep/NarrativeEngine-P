import { randomUUID } from 'node:crypto';

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
        const text = item.trim();
        return text ? [text] : [];
    });
};

export function validateCharacterAbility(value, index = 0, now = Date.now()) {
    const path = `characterAbilities[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };

    const abilityId = nullableText(value.abilityId, `${path}.abilityId`, errors);
    const ownerId = nullableText(value.ownerId, `${path}.ownerId`, errors);
    if (!abilityId) errors.push(`${path}.abilityId is required`);
    if (!ownerId) errors.push(`${path}.ownerId is required`);
    const ownerType = value.ownerType;
    if (ownerType !== 'pc' && ownerType !== 'npc') {
        errors.push(`${path}.ownerType must be "pc" or "npc"`);
    }

    const normalized = {
        id: nullableText(value.id, `${path}.id`, errors) || randomUUID(),
        abilityId,
        ownerType: ownerType === 'npc' ? 'npc' : 'pc',
        ownerId,
        mastery: nullableText(value.mastery, `${path}.mastery`, errors),
        variantName: nullableText(value.variantName, `${path}.variantName`, errors),
        modifications: nullableStringList(value.modifications, `${path}.modifications`, errors),
        learnedSceneId: nullableText(value.learnedSceneId, `${path}.learnedSceneId`, errors),
        notes: nullableText(value.notes, `${path}.notes`, errors),
        promptEnabled: value.promptEnabled == null ? true : value.promptEnabled,
        createdAt: value.createdAt == null ? now : value.createdAt,
        updatedAt: value.updatedAt == null ? now : value.updatedAt,
    };
    if (typeof normalized.promptEnabled !== 'boolean') errors.push(`${path}.promptEnabled must be a boolean or null`);
    if (typeof normalized.createdAt !== 'number' || !Number.isFinite(normalized.createdAt)) {
        errors.push(`${path}.createdAt must be a finite number or null`);
    }
    if (typeof normalized.updatedAt !== 'number' || !Number.isFinite(normalized.updatedAt)) {
        errors.push(`${path}.updatedAt must be a finite number or null`);
    }
    return { value: normalized, errors };
}

export function validateCharacterAbilities(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Character abilities must be an array'] };
    const checked = value.map((entry, index) => validateCharacterAbility(entry, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}
