export type EnemyStat = { name: string; value: string };
export type EnemyAction = { name: string; description: string };

/** Reusable template only; current HP and conditions belong to a future encounter instance. */
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
