export type EnemyStat = { name: string; value: string };
export type EnemyAction = { name: string; description: string; abilityId?: string };
export type EnemyModifier = { id: string; name: string; value: string };
export type EnemyCooldown = { id: string; name: string; remainingRounds: number };
export type EnemyResource = { id: string; name: string; current: number; max: number };
export type EnemyInitiativeMode = 'manual' | 'd20' | 'd100';
export type EnemyBarrierMode = 'manual' | 'absorb-first';
export type EnemyEncounterOutcome = 'victory' | 'partial' | 'defeat' | 'escaped' | 'negotiated' | 'other';
export type EnemyInstanceDisposition = 'archive' | 'discard';

export type EnemyCombatConfig = {
    /** Master gate for all compendium and active-encounter prompt injection. */
    promptContextEnabled: boolean;
    /** Runs post-turn enemy/alias discovery into a review queue, never direct mutation. */
    enemyDiscoveryEnabled: boolean;
    enabled: boolean;
    initiativeMode: EnemyInitiativeMode;
    initiativeModifierStat: string;
    barrierMode: EnemyBarrierMode;
    autoDefeatAtZeroHp: boolean;
    weaknessMultiplier: number;
    resistanceMultiplier: number;
    actionsEnabled: boolean;
    defaultActionsPerTurn: number;
    cooldownsEnabled: boolean;
    resourcesEnabled: boolean;
};

export type EnemySuggestionKind = 'new' | 'alias';

/** A post-turn discovery candidate awaiting explicit player approval. */
export type EnemySuggestion = {
    id: string;
    kind: EnemySuggestionKind;
    name: string;
    targetEnemyId?: string;
    classification?: string;
    reason?: string;
    context?: string;
    firstSeen: number;
};

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
 * template. It enters AI context only through an explicitly active wave roster.
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
    initiative: number | null;
    actionsRemaining: number;
    actionsPerTurn: number;
    cooldowns: EnemyCooldown[];
    resources: EnemyResource[];
    createdAt: number;
    updatedAt: number;
};

export type EnemyEncounterStatus = 'active' | 'paused' | 'ended';

export type EnemyEncounterWave = {
    id: string;
    name: string;
    instanceIds: string[];
    activeInstanceIds: string[];
    createdAt: number;
    updatedAt: number;
};

/**
 * A saved encounter groups instance IDs into waves. Only the active encounter,
 * its current wave, and that wave's explicitly active IDs enter AI context.
 */
export type EnemyEncounter = {
    id: string;
    name: string;
    status: EnemyEncounterStatus;
    waves: EnemyEncounterWave[];
    activeWaveId: string;
    createdAt: number;
    updatedAt: number;
    endedAt?: number;
    resolutionId?: string;
};

/**
 * Immutable Phase 5 record created when the player explicitly resolves an
 * encounter. Full runtime copies are retained only for the archive option.
 */
export type EnemyEncounterResolution = {
    id: string;
    encounterId: string;
    encounterName: string;
    outcome: EnemyEncounterOutcome;
    summary: string;
    xpAwarded: number;
    lootAwarded: string[];
    otherRewards: string[];
    participantNames: string[];
    instanceDisposition: EnemyInstanceDisposition;
    archivedInstances: EnemyInstance[];
    timelineEventId?: string;
    resolvedAt: number;
};
