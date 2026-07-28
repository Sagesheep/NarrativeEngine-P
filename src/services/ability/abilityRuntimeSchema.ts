import type { AbilityRuntimeEffect, AbilityRuntimeState } from '../../types';

type UnknownRecord = Record<string, unknown>;

export type AbilityRuntimeOptions = {
    now?: number;
    createId?: () => string;
};

const isRecord = (value: unknown): value is UnknownRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';

const nonNegativeInteger = (value: unknown, fallback = 0): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : fallback;

const nullableNonNegativeInteger = (value: unknown): number | null =>
    value == null ? null : nonNegativeInteger(value);

const normalizeEffect = (
    value: unknown,
    options: AbilityRuntimeOptions,
): AbilityRuntimeEffect | null => {
    if (!isRecord(value)) return null;
    const name = text(value.name);
    if (!name) return null;
    return {
        id: text(value.id) || (options.createId ?? (() => crypto.randomUUID()))(),
        name,
        remainingTurns: nonNegativeInteger(value.remainingTurns, 1),
        notes: text(value.notes),
    };
};

export function createEmptyAbilityRuntimeState(
    characterAbilityId: string,
    options: AbilityRuntimeOptions = {},
): AbilityRuntimeState {
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: createId(),
        characterAbilityId,
        cooldownRemaining: 0,
        cooldownMax: 0,
        chargesRemaining: null,
        chargesMax: null,
        activeEffects: [],
        uses: 0,
        lastUsedSceneId: '',
        notes: '',
        updatedAt: options.now ?? Date.now(),
    };
}

export function normalizeAbilityRuntimeState(
    value: unknown,
    options: AbilityRuntimeOptions = {},
): AbilityRuntimeState | null {
    if (!isRecord(value)) return null;
    const characterAbilityId = text(value.characterAbilityId);
    if (!characterAbilityId) return null;
    const chargesMax = nullableNonNegativeInteger(value.chargesMax);
    const chargesRemaining = chargesMax == null
        ? null
        : Math.min(nullableNonNegativeInteger(value.chargesRemaining) ?? chargesMax, chargesMax);
    return {
        id: text(value.id) || (options.createId ?? (() => crypto.randomUUID()))(),
        characterAbilityId,
        cooldownRemaining: nonNegativeInteger(value.cooldownRemaining),
        cooldownMax: nonNegativeInteger(value.cooldownMax),
        chargesRemaining,
        chargesMax,
        activeEffects: Array.isArray(value.activeEffects)
            ? value.activeEffects
                .map(effect => normalizeEffect(effect, options))
                .filter((effect): effect is AbilityRuntimeEffect => effect !== null)
            : [],
        uses: nonNegativeInteger(value.uses),
        lastUsedSceneId: text(value.lastUsedSceneId),
        notes: text(value.notes),
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt)
            ? value.updatedAt
            : options.now ?? Date.now(),
    };
}

export function normalizeAbilityRuntimeStates(
    value: unknown,
    options: AbilityRuntimeOptions = {},
): { entries: AbilityRuntimeState[]; skipped: number } {
    if (!Array.isArray(value)) return { entries: [], skipped: value == null ? 0 : 1 };
    const entries = value
        .map(item => normalizeAbilityRuntimeState(item, options))
        .filter((entry): entry is AbilityRuntimeState => entry !== null);
    return { entries, skipped: value.length - entries.length };
}

export function canActivateAbility(state: AbilityRuntimeState): { ok: boolean; reason: string } {
    if (state.cooldownRemaining > 0) {
        return { ok: false, reason: `${state.cooldownRemaining} cooldown turn(s) remaining` };
    }
    if (state.chargesRemaining === 0) return { ok: false, reason: 'No charges remaining' };
    return { ok: true, reason: '' };
}

export function activateAbilityRuntimeState(
    state: AbilityRuntimeState,
    sceneId = '',
    now = Date.now(),
): AbilityRuntimeState {
    if (!canActivateAbility(state).ok) return state;
    return {
        ...state,
        cooldownRemaining: state.cooldownMax,
        chargesRemaining: state.chargesRemaining == null ? null : Math.max(0, state.chargesRemaining - 1),
        uses: state.uses + 1,
        lastUsedSceneId: sceneId.trim() || state.lastUsedSceneId,
        updatedAt: now,
    };
}

export function advanceAbilityRuntimeState(
    state: AbilityRuntimeState,
    now = Date.now(),
): AbilityRuntimeState {
    return {
        ...state,
        cooldownRemaining: Math.max(0, state.cooldownRemaining - 1),
        activeEffects: state.activeEffects.flatMap(effect =>
            effect.remainingTurns <= 1
                ? []
                : [{ ...effect, remainingTurns: effect.remainingTurns - 1 }]),
        updatedAt: now,
    };
}

export function resetAbilityRuntimeState(
    state: AbilityRuntimeState,
    now = Date.now(),
): AbilityRuntimeState {
    return {
        ...state,
        cooldownRemaining: 0,
        chargesRemaining: state.chargesMax,
        activeEffects: [],
        updatedAt: now,
    };
}
