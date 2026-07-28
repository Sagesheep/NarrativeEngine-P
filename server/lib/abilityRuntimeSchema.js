import { randomUUID } from 'crypto';

const isRecord = value => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value, path, errors) => {
    if (value == null) return '';
    if (typeof value !== 'string') {
        errors.push(`${path} must be a string or null`);
        return '';
    }
    return value.trim();
};

const integer = (value, path, errors, fallback = 0) => {
    if (value == null) return fallback;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        errors.push(`${path} must be a non-negative finite number or null`);
        return fallback;
    }
    return Math.floor(value);
};

const nullableInteger = (value, path, errors) =>
    value == null ? null : integer(value, path, errors);

const effects = (value, path, errors) => {
    if (value == null) return [];
    if (!Array.isArray(value)) {
        errors.push(`${path} must be an array or null`);
        return [];
    }
    return value.flatMap((effect, index) => {
        const effectPath = `${path}[${index}]`;
        if (!isRecord(effect)) {
            errors.push(`${effectPath} must be an object`);
            return [];
        }
        const name = text(effect.name, `${effectPath}.name`, errors);
        if (!name) {
            errors.push(`${effectPath}.name is required`);
            return [];
        }
        return [{
            id: text(effect.id, `${effectPath}.id`, errors) || randomUUID(),
            name,
            remainingTurns: integer(effect.remainingTurns, `${effectPath}.remainingTurns`, errors, 1),
            notes: text(effect.notes, `${effectPath}.notes`, errors),
        }];
    });
};

export function validateAbilityRuntimeState(value, index = 0, now = Date.now()) {
    const path = `abilityRuntimeStates[${index}]`;
    const errors = [];
    if (!isRecord(value)) return { value: null, errors: [`${path} must be an object`] };
    const characterAbilityId = text(value.characterAbilityId, `${path}.characterAbilityId`, errors);
    if (!characterAbilityId) errors.push(`${path}.characterAbilityId is required`);
    const chargesMax = nullableInteger(value.chargesMax, `${path}.chargesMax`, errors);
    const requestedCharges = nullableInteger(value.chargesRemaining, `${path}.chargesRemaining`, errors);
    const normalized = {
        id: text(value.id, `${path}.id`, errors) || randomUUID(),
        characterAbilityId,
        cooldownRemaining: integer(value.cooldownRemaining, `${path}.cooldownRemaining`, errors),
        cooldownMax: integer(value.cooldownMax, `${path}.cooldownMax`, errors),
        chargesRemaining: chargesMax == null ? null : Math.min(requestedCharges ?? chargesMax, chargesMax),
        chargesMax,
        activeEffects: effects(value.activeEffects, `${path}.activeEffects`, errors),
        uses: integer(value.uses, `${path}.uses`, errors),
        lastUsedSceneId: text(value.lastUsedSceneId, `${path}.lastUsedSceneId`, errors),
        notes: text(value.notes, `${path}.notes`, errors),
        updatedAt: value.updatedAt == null ? now : value.updatedAt,
    };
    if (typeof normalized.updatedAt !== 'number' || !Number.isFinite(normalized.updatedAt)) {
        errors.push(`${path}.updatedAt must be a finite number or null`);
    }
    return { value: normalized, errors };
}

export function validateAbilityRuntimeStates(value) {
    if (!Array.isArray(value)) return { value: null, errors: ['Ability runtime states must be an array'] };
    const checked = value.map((entry, index) => validateAbilityRuntimeState(entry, index));
    return {
        value: checked.map(result => result.value),
        errors: checked.flatMap(result => result.errors),
    };
}
