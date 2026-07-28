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

export type AbilityRuntimeEffect = {
    id: string;
    name: string;
    remainingTurns: number;
    notes: string;
};

/**
 * Mutable encounter state for one character-owned ability. This references the
 * ownership row rather than the canonical definition so two characters can use
 * the same definition without sharing cooldowns, charges, or active effects.
 * A null charge value means the ability is not charge-limited.
 */
export type AbilityRuntimeState = {
    id: string;
    characterAbilityId: string;
    cooldownRemaining: number;
    cooldownMax: number;
    chargesRemaining: number | null;
    chargesMax: number | null;
    activeEffects: AbilityRuntimeEffect[];
    uses: number;
    lastUsedSceneId: string;
    notes: string;
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
