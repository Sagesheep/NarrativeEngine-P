import type { AbilityOwnerType, CharacterAbility } from '../../types';

type UnknownRecord = Record<string, unknown>;

export type NormalizeCharacterAbilityOptions = {
    now?: number;
    createId?: () => string;
};

const isRecord = (value: unknown): value is UnknownRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const optionalStringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];

const normalizeOwnerType = (value: unknown): AbilityOwnerType | null =>
    value === 'pc' || value === 'npc' ? value : null;

export function createEmptyCharacterAbility(
    ownerType: AbilityOwnerType,
    ownerId: string,
    abilityId: string,
    options: NormalizeCharacterAbilityOptions = {},
): CharacterAbility {
    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: createId(),
        abilityId,
        ownerType,
        ownerId,
        mastery: '',
        variantName: '',
        modifications: [],
        learnedSceneId: '',
        notes: '',
        promptEnabled: true,
        createdAt: now,
        updatedAt: now,
    };
}

export function normalizeCharacterAbility(
    value: unknown,
    options: NormalizeCharacterAbilityOptions = {},
): CharacterAbility | null {
    if (!isRecord(value)) return null;
    const abilityId = optionalText(value.abilityId);
    const ownerId = optionalText(value.ownerId);
    const ownerType = normalizeOwnerType(value.ownerType);
    if (!abilityId || !ownerId || !ownerType) return null;

    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: optionalText(value.id) || createId(),
        abilityId,
        ownerType,
        ownerId,
        mastery: optionalText(value.mastery),
        variantName: optionalText(value.variantName),
        modifications: optionalStringList(value.modifications),
        learnedSceneId: optionalText(value.learnedSceneId),
        notes: optionalText(value.notes),
        promptEnabled: typeof value.promptEnabled === 'boolean' ? value.promptEnabled : true,
        createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now,
    };
}

export function normalizeCharacterAbilities(
    value: unknown,
    options: NormalizeCharacterAbilityOptions = {},
): { entries: CharacterAbility[]; skipped: number } {
    if (!Array.isArray(value)) return { entries: [], skipped: 0 };
    const entries = value
        .map(item => normalizeCharacterAbility(item, options))
        .filter((entry): entry is CharacterAbility => entry !== null);
    return { entries, skipped: value.length - entries.length };
}
