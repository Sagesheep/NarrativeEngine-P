import type { AbilityOwnerType, AbilityTrainingMilestone, CharacterAbility } from '../../types';

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

const nonNegativeInteger = (value: unknown, fallback = 0): number =>
    typeof value === 'number' && Number.isFinite(value)
        ? Math.max(0, Math.floor(value))
        : fallback;

const optionalMilestones = (value: unknown): AbilityTrainingMilestone[] =>
    Array.isArray(value)
        ? value.flatMap(item => {
            if (!isRecord(item)) return [];
            const name = optionalText(item.name);
            if (!name) return [];
            return [{
                id: optionalText(item.id) || crypto.randomUUID(),
                name,
                requirement: optionalText(item.requirement),
                completed: item.completed === true,
                completedSceneId: optionalText(item.completedSceneId),
                completedAt: typeof item.completedAt === 'number' && Number.isFinite(item.completedAt)
                    ? item.completedAt
                    : null,
            }];
        })
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
        masteryTierId: '',
        unlockedUpgradeIds: [],
        trainingProgress: 0,
        trainingGoal: 0,
        trainingMilestones: [],
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
        masteryTierId: optionalText(value.masteryTierId),
        unlockedUpgradeIds: optionalStringList(value.unlockedUpgradeIds),
        trainingProgress: nonNegativeInteger(value.trainingProgress),
        trainingGoal: nonNegativeInteger(value.trainingGoal),
        trainingMilestones: optionalMilestones(value.trainingMilestones),
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
