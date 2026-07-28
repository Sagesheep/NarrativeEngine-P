import type { AbilityCategory, AbilityCost, AbilityEntry } from '../../types';

type UnknownRecord = Record<string, unknown>;

export type NormalizeAbilityOptions = {
    now?: number;
    createId?: () => string;
};

export const ABILITY_CATEGORIES: readonly AbilityCategory[] = [
    'active',
    'passive',
    'reaction',
    'sustained',
    'transformation',
    'summon',
    'stance',
    'ritual',
    'crafting',
    'narrative-permission',
    'other',
] as const;

const isRecord = (value: unknown): value is UnknownRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const optionalStringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];

const optionalCosts = (value: unknown): AbilityCost[] =>
    Array.isArray(value)
        ? value.flatMap(item => {
            if (!isRecord(item)) return [];
            const resource = optionalText(item.resource);
            if (!resource) return [];
            return [{
                resource,
                amount: optionalText(item.amount),
                timing: optionalText(item.timing),
                condition: optionalText(item.condition),
            }];
        })
        : [];

const normalizeCategory = (value: unknown): AbilityCategory =>
    typeof value === 'string' && ABILITY_CATEGORIES.includes(value as AbilityCategory)
        ? value as AbilityCategory
        : 'active';

/** Creates a complete controlled draft for the library editor. */
export function createEmptyAbilityEntry(options: NormalizeAbilityOptions = {}): AbilityEntry {
    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: createId(),
        name: '',
        aliases: '',
        category: 'active',
        description: '',
        appearance: '',
        activation: '',
        costs: [],
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
        promptEnabled: true,
        createdAt: now,
        updatedAt: now,
    };
}

/**
 * Converts imported or persisted unknown data into the safe known-field-only
 * definition shape. Unnamed records are unusable; optional malformed fields
 * receive neutral defaults so hand-authored and older JSON remains importable.
 */
export function normalizeAbilityEntry(
    value: unknown,
    options: NormalizeAbilityOptions = {},
): AbilityEntry | null {
    if (!isRecord(value)) return null;
    const name = optionalText(value.name);
    if (!name) return null;

    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: optionalText(value.id) || createId(),
        name,
        aliases: optionalText(value.aliases),
        category: normalizeCategory(value.category),
        description: optionalText(value.description),
        appearance: optionalText(value.appearance),
        activation: optionalText(value.activation),
        costs: optionalCosts(value.costs),
        range: optionalText(value.range),
        targets: optionalText(value.targets),
        duration: optionalText(value.duration),
        area: optionalText(value.area),
        effect: optionalText(value.effect),
        outcomeGuidance: optionalText(value.outcomeGuidance),
        limitations: optionalStringList(value.limitations),
        counters: optionalStringList(value.counters),
        prerequisites: optionalStringList(value.prerequisites),
        tags: optionalStringList(value.tags),
        source: optionalText(value.source),
        gmNotes: optionalText(value.gmNotes),
        promptEnabled: typeof value.promptEnabled === 'boolean' ? value.promptEnabled : true,
        createdAt: typeof value.createdAt === 'number' && Number.isFinite(value.createdAt) ? value.createdAt : now,
        updatedAt: typeof value.updatedAt === 'number' && Number.isFinite(value.updatedAt) ? value.updatedAt : now,
    };
}

/** Normalizes a whole imported library and reports discarded records. */
export function normalizeAbilityEntries(
    value: unknown,
    options: NormalizeAbilityOptions = {},
): { entries: AbilityEntry[]; skipped: number } {
    if (!Array.isArray(value)) return { entries: [], skipped: 0 };
    const entries = value
        .map(item => normalizeAbilityEntry(item, options))
        .filter((entry): entry is AbilityEntry => entry !== null);
    return { entries, skipped: value.length - entries.length };
}
