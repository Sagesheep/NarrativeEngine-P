export type {
    AbilityKey, AbilityScores, CombatTier, Archetype, PointBudget,
    CombatSheet, DerivedSheet, Rng,
    Side, Controller, CombatantStatus, DamageSpec, Combatant, CombatOutcome, CombatState,
    CombatAction, CombatEvent, TierBlock, CombatantSpec, CombatSpec, WeaponQuality, PcWeapon,
    PcCombatantInput, AttackRange, Tile, Grid, Pos, MapSize, MapFeatureSpec, MapSpec, TurnState, TemplateOverlay,
} from './types';
export { createRng } from './rng';
export { ABILITY_KEYS, TIER_LEVEL, abilityMod, proficiencyForLevel } from './abilities';
export {
    PC_POINT_BUY, POINT_BUY_COST, OP_POINT_BUY_COST, INVALID_POINT_COST,
    DEFAULT_ABILITIES, ARCHETYPE_KEYS, ARCHETYPE_PRESETS,
    getPointCost, validateAllocation, allocateAbility,
} from './pointBuy';
export type { PointBuyConfig, PointBuyAllocation } from './pointBuy';
export { createDefaultSheet, deriveSheet, levelForBudget } from './sheet';
export { TIER_TABLE, DEFAULT_JITTER_RANGE, BASE_ENEMY_ABILITIES, DEFAULT_DAMAGE_TYPE, buildTierBlock } from './tiers';
export type { TierRow } from './tiers';
export { PC_COMBATANT_ID, WEAPON_QUALITY_DICE, UNARMED_DIE, FALLBACK_WEAPON_DIE, buildPcCombatant } from './pc';
export {
    DEFEND_CONDITION, isHostile, canTarget, currentActorId, checkOutcome, applyAction,
    chooseEngineTurn, stepEngine, runEngineTurns, createCombat, hpBand, HAZARD_DAMAGE_DIE,
    freshTurn, currentTurn, checkAttack, reachable, pathTo, deriveMapSeed,
} from './resolve';
export type { HpBand, AttackCheck } from './resolve';
export {
    TILE_KINDS, DEFAULT_SPEED, REACH_DISTANCE, RANGED_DISTANCE, HAZARD_AVOID_PENALTY, HALF_COVER_BONUS, THREE_QUARTER_COVER_BONUS,
    inBounds, tileAt, isWalkable, isWalkableTile, distance, samePos, canStep, traceLine, hasLineOfSight, coverBetween,
    speedOf, rangeOf, sameTeam,
} from './grid';
export {
    MAP_SIZES, SPAWN_COLUMNS, MAX_MAP_FEATURES, MAX_BLOCKED_SHARE, DEFAULT_HAZARD_TYPE,
    tileForKind, normalizeMapSize, isFullyConnected, openArena, buildTerrain, placeCombatants, buildGrid,
    buildMapFromSeed, isValidGrid, ensureGrid,
} from './mapBuilder';
export type { SpawnEntry } from './mapBuilder';
export { simulateFights } from './simulate';
export type { SimulationResult, SimulationOptions } from './simulate';
