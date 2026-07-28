export type AbilityCategory =
    | 'active'
    | 'passive'
    | 'reaction'
    | 'sustained'
    | 'transformation'
    | 'summon'
    | 'stance'
    | 'ritual'
    | 'crafting'
    | 'narrative-permission'
    | 'other';

export type AbilityCost = {
    resource: string;
    amount: string;
    timing: string;
    condition: string;
};

export type AbilityOwnerType = 'pc' | 'npc';

/**
 * Character-specific ownership of a canonical definition. This is persistent
 * progression metadata only; mutable cooldowns, charges, and active effects
 * remain out of scope until the runtime-state phase.
 */
export type CharacterAbility = {
    id: string;
    abilityId: string;
    ownerType: AbilityOwnerType;
    ownerId: string;
    mastery: string;
    variantName: string;
    modifications: string[];
    learnedSceneId: string;
    notes: string;
    promptEnabled: boolean;
    createdAt: number;
    updatedAt: number;
};

/**
 * Campaign-scoped canonical ability definition.
 * Ownership, mastery, cooldowns, charges, and other mutable character state
 * intentionally belong to later phases rather than this reusable record.
 */
export type AbilityEntry = {
    id: string;
    name: string;
    aliases: string;
    category: AbilityCategory;
    description: string;
    appearance: string;
    activation: string;
    costs: AbilityCost[];
    range: string;
    targets: string;
    duration: string;
    area: string;
    effect: string;
    outcomeGuidance: string;
    limitations: string[];
    counters: string[];
    prerequisites: string[];
    tags: string[];
    source: string;
    gmNotes: string;
    promptEnabled: boolean;
    createdAt: number;
    updatedAt: number;
};
