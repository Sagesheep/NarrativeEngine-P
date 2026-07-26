export type EnemyStat = { name: string; value: string };
export type EnemyAction = { name: string; description: string };
export type EnemyModifier = { id: string; name: string; value: string };

/**
 * Reusable, campaign-scoped enemy reference template.
 * Runtime HP, conditions, and individual encounter state intentionally live
 * outside this record so combat cannot mutate the source compendium.
 */
export type EnemyEntry = {
    id: string;
    name: string;
    aliases: string;
    classification: string;
    description: string;
    threatTier: string;
    tags: string[];
    faction: string;
    stats: EnemyStat[];
    actions: EnemyAction[];
    passiveTraits: string[];
    specialBehaviors: string[];
    weaknesses: string[];
    resistances: string[];
    tactics: string;
    loot: string;
    gmNotes: string;
    promptEnabled: boolean;
    createdAt: number;
    updatedAt: number;
};

/**
 * A mutable encounter copy backed by an immutable snapshot of its source
 * template. Phase 2 persists these records without adding them to AI context.
 */
export type EnemyInstance = {
    id: string;
    templateId: string;
    templateSnapshot: EnemyEntry;
    displayName: string;
    currentHp: number;
    maxHp: number;
    currentBarrier: number;
    maxBarrier: number;
    conditions: string[];
    temporaryModifiers: EnemyModifier[];
    defeated: boolean;
    createdAt: number;
    updatedAt: number;
};
