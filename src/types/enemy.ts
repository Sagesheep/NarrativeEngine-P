export type EnemyStat = { name: string; value: string };
export type EnemyAction = { name: string; description: string };

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
