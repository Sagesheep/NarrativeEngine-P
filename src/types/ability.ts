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
