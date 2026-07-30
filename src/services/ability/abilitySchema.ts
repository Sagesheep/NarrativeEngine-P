import type { AbilityCategory, AbilityCompendiumDocument, AbilityCost, AbilityEntry, AbilityMasteryTier, AbilityOrigin, AbilityTerminology, AbilityUpgradeNode } from '../../types';

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

export const ABILITY_ORIGINS: readonly AbilityOrigin[] = [
    'innate',
    'trained',
    'spell',
    'item-granted',
    'enemy-action',
    'lore-granted',
    'other',
] as const;

export const ABILITY_ORIGIN_LABELS: Record<AbilityOrigin, string> = {
    innate: 'Innate',
    trained: 'Trained',
    spell: 'Spell',
    'item-granted': 'Inventory Power',
    'enemy-action': 'Enemy Action',
    'lore-granted': 'Lore-Granted',
    other: 'Other',
};

export const ABILITY_CATEGORY_LABELS: Record<AbilityCategory, string> = {
    active: 'Active',
    passive: 'Passive',
    reaction: 'Reaction',
    sustained: 'Sustained',
    transformation: 'Transformation',
    summon: 'Summon',
    stance: 'Stance',
    ritual: 'Ritual',
    crafting: 'Crafting',
    'narrative-permission': 'Narrative Permission',
    other: 'Other',
};

export const DEFAULT_ABILITY_TERMINOLOGY: AbilityTerminology = {
    originLabels: {},
    categoryLabels: {},
};

const isRecord = (value: unknown): value is UnknownRecord =>
    Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const optionalText = (value: unknown): string =>
    typeof value === 'string' ? value.trim() : '';

const optionalStringList = (value: unknown): string[] =>
    Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string').map(item => item.trim()).filter(Boolean)
        : [];

export function normalizeAbilityTerminology(value: unknown): AbilityTerminology {
    if (!isRecord(value)) return { originLabels: {}, categoryLabels: {} };
    const originSource = isRecord(value.originLabels) ? value.originLabels : {};
    const categorySource = isRecord(value.categoryLabels) ? value.categoryLabels : {};
    const originLabels: AbilityTerminology['originLabels'] = {};
    const categoryLabels: AbilityTerminology['categoryLabels'] = {};
    for (const origin of ABILITY_ORIGINS) {
        const label = optionalText(originSource[origin]);
        if (label) originLabels[origin] = label;
    }
    for (const category of ABILITY_CATEGORIES) {
        const label = optionalText(categorySource[category]);
        if (label) categoryLabels[category] = label;
    }
    return { originLabels, categoryLabels };
}

export const resolveAbilityOriginLabel = (
    origin: AbilityOrigin,
    terminology?: AbilityTerminology,
): string => terminology?.originLabels[origin] || ABILITY_ORIGIN_LABELS[origin];

export const resolveAbilityCategoryLabel = (
    category: AbilityCategory,
    terminology?: AbilityTerminology,
): string => terminology?.categoryLabels[category] || ABILITY_CATEGORY_LABELS[category];

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

const optionalMasteryLadder = (value: unknown): AbilityMasteryTier[] =>
    Array.isArray(value)
        ? value.flatMap(item => {
            if (!isRecord(item)) return [];
            const name = optionalText(item.name);
            if (!name) return [];
            return [{
                id: optionalText(item.id) || crypto.randomUUID(),
                name,
                requirements: optionalText(item.requirements),
                benefits: optionalText(item.benefits),
            }];
        })
        : [];

const optionalUpgradeNodes = (value: unknown): AbilityUpgradeNode[] =>
    Array.isArray(value)
        ? value.flatMap(item => {
            if (!isRecord(item)) return [];
            const name = optionalText(item.name);
            if (!name) return [];
            return [{
                id: optionalText(item.id) || crypto.randomUUID(),
                branch: optionalText(item.branch),
                name,
                description: optionalText(item.description),
                prerequisiteTierId: optionalText(item.prerequisiteTierId),
                prerequisiteUpgradeIds: optionalStringList(item.prerequisiteUpgradeIds),
            }];
        })
        : [];

const normalizeCategory = (value: unknown): AbilityCategory =>
    typeof value === 'string' && ABILITY_CATEGORIES.includes(value as AbilityCategory)
        ? value as AbilityCategory
        : 'active';

const normalizeOrigin = (value: unknown, tags: string[], name: string): AbilityOrigin => {
    if (typeof value === 'string' && ABILITY_ORIGINS.includes(value as AbilityOrigin)) {
        return value as AbilityOrigin;
    }
    const hints = [name, ...tags].join(' ').toLocaleLowerCase();
    if (/\bspell\b|\bcantrip\b/.test(hints)) return 'spell';
    if (/\bweapon mastery\b|\borigin feat\b|\bskill\b|\btechnique\b/.test(hints)) return 'trained';
    return 'trained';
};

/** Creates a complete controlled draft for the library editor. */
export function createEmptyAbilityEntry(options: NormalizeAbilityOptions = {}): AbilityEntry {
    const now = options.now ?? Date.now();
    const createId = options.createId ?? (() => crypto.randomUUID());
    return {
        id: createId(),
        name: '',
        aliases: '',
        category: 'active',
        origin: 'trained',
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
        interactionTags: [],
        counterTags: [],
        sourceInventoryItemId: '',
        inventoryRequiresEquipped: true,
        loreCheckRequired: false,
        loreStatus: 'unverified',
        loreCheckNotes: '',
        loreCheckedAt: null,
        masteryLadder: [],
        upgradeNodes: [],
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
    const tags = optionalStringList(value.tags);
    return {
        id: optionalText(value.id) || createId(),
        name,
        aliases: optionalText(value.aliases),
        category: normalizeCategory(value.category),
        origin: normalizeOrigin(value.origin, tags, name),
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
        interactionTags: optionalStringList(value.interactionTags),
        counterTags: optionalStringList(value.counterTags),
        sourceInventoryItemId: optionalText(value.sourceInventoryItemId),
        inventoryRequiresEquipped: typeof value.inventoryRequiresEquipped === 'boolean'
            ? value.inventoryRequiresEquipped
            : true,
        loreCheckRequired: value.loreCheckRequired === true,
        loreStatus: value.loreStatus === 'verified' || value.loreStatus === 'flagged'
            ? value.loreStatus
            : 'unverified',
        loreCheckNotes: optionalText(value.loreCheckNotes),
        loreCheckedAt: typeof value.loreCheckedAt === 'number' && Number.isFinite(value.loreCheckedAt)
            ? value.loreCheckedAt
            : null,
        masteryLadder: optionalMasteryLadder(value.masteryLadder),
        upgradeNodes: optionalUpgradeNodes(value.upgradeNodes),
        tags,
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

export function normalizeAbilityCompendiumDocument(
    value: unknown,
    options: NormalizeAbilityOptions = {},
): { entries: AbilityEntry[]; skipped: number; terminology: AbilityTerminology } {
    if (Array.isArray(value)) {
        return { ...normalizeAbilityEntries(value, options), terminology: normalizeAbilityTerminology(null) };
    }
    if (!isRecord(value) || !Array.isArray(value.abilities)) {
        return { entries: [], skipped: 0, terminology: normalizeAbilityTerminology(null) };
    }
    return {
        ...normalizeAbilityEntries(value.abilities, options),
        terminology: normalizeAbilityTerminology(value.terminology),
    };
}

export function createAbilityCompendiumDocument(
    abilities: AbilityEntry[],
    terminology?: AbilityTerminology,
): AbilityCompendiumDocument {
    return { schemaVersion: 2, terminology: normalizeAbilityTerminology(terminology), abilities };
}
