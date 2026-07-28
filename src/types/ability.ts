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

export type AbilityOrigin =
    | 'innate'
    | 'trained'
    | 'spell'
    | 'item-granted'
    | 'enemy-action'
    | 'lore-granted'
    | 'other';

export type AbilityLoreStatus = 'unverified' | 'verified' | 'flagged';

export type AbilityCost = {
    resource: string;
    amount: string;
    timing: string;
    condition: string;
};

export type AbilityMasteryTier = {
    id: string;
    name: string;
    requirements: string;
    benefits: string;
};

export type AbilityUpgradeNode = {
    id: string;
    branch: string;
    name: string;
    description: string;
    prerequisiteTierId: string;
    prerequisiteUpgradeIds: string[];
};

export type AbilityTrainingMilestone = {
    id: string;
    name: string;
    requirement: string;
    completed: boolean;
    completedSceneId: string;
    completedAt: number | null;
};

export type AbilityOwnerType = 'pc' | 'npc';

export type AbilityProposalKind = 'new' | 'assign' | 'progression';

/**
 * Review-only result produced by the Phase 4 discovery scan. Proposals are
 * persisted independently and cannot affect canon or character progression
 * until the player explicitly accepts them.
 */
export type AbilityProposal = {
    id: string;
    kind: AbilityProposalKind;
    abilityId: string;
    abilityName: string;
    ownerType: AbilityOwnerType | null;
    ownerId: string;
    category: AbilityCategory;
    origin: AbilityOrigin;
    effect: string;
    activation: string;
    mastery: string;
    masteryTierId: string;
    modification: string;
    upgradeId: string;
    trainingDelta: number;
    reason: string;
    evidence: string;
    sourceSceneId: string;
    sourceProfileAbility?: string;
    createdAt: number;
    updatedAt: number;
};

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
    masteryTierId: string;
    unlockedUpgradeIds: string[];
    trainingProgress: number;
    trainingGoal: number;
    trainingMilestones: AbilityTrainingMilestone[];
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
    origin: AbilityOrigin;
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
    interactionTags: string[];
    counterTags: string[];
    sourceInventoryItemId: string;
    inventoryRequiresEquipped: boolean;
    loreCheckRequired: boolean;
    loreStatus: AbilityLoreStatus;
    loreCheckNotes: string;
    loreCheckedAt: number | null;
    masteryLadder: AbilityMasteryTier[];
    upgradeNodes: AbilityUpgradeNode[];
    tags: string[];
    source: string;
    gmNotes: string;
    promptEnabled: boolean;
    createdAt: number;
    updatedAt: number;
};
