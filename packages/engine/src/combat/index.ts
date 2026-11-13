export type {
    AbilityKey, AbilityScores, CombatTier, Archetype, PointBudget,
    CombatSheet, DerivedSheet, Rng,
    Side, Controller, CombatantStatus, DamageSpec, Combatant, CombatOutcome, CombatState,
    CombatAction, CombatEvent, TierBlock, CombatantSpec, CombatSpec, WeaponQuality, PcWeapon,
    PcCombatantInput, AttackRange, Tile, Grid, Pos, MapSize, MapSpec, TurnState, TemplateOverlay,
    AreaType, MapDensity, HazardKind, TerrainLabels, ResolvedMapSpec,
    FormId, EffectId, AugmentId, GlyphAbility, CombatCondition, Barrier,
    PartyControl, DefeatMode, Team, ParleyIntent, ParleyRating, ParleyEffect, ParleyRecord, FateRecord, MoraleBook, CombatEnding,
} from './types';
export {
    MORALE_DC, MORALE_DC_LEADER_DOWN, PARLEY_DC, PARLEY_LOSING_SHIFT, PARLEY_FAILURE_STEP, PARLEY_INTENTS, PARLEY_RATINGS,
    MECHANICAL_INTENTS, teamOfSide, isEdgeTile, edgeTiles, buildMoraleBook, teamLoss, lostHalf, isLeaderDown, isOutnumbered,
    startedOnEdge, checkFlee, isRetreating, canAbandon, checkParley, resolveSpeaker, onlySummonedEnemies,
    earlierParleyFailures, parleyDc,
} from './party';
export type { FleeReason, FleeCheck, ParleyReason } from './party';
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
    freshTurn, currentTurn, checkAttack, reachable, pathTo, deriveMapSeed, hasUsableBonusAbility, concedeCombat,
} from './resolve';
export {
    STUNNED, SLOWED, HASTED, SHIELDED, COMBAT_EVENT_TYPES, canAttackWith, hasCondition, countsForOutcome,
    playerCharacterOf, OUTCOME_TEXT, HARDCORE_DEATH_MAX, isPlayerSide,
} from './core';
export * from './glyphs/index';
export type { HpBand, AttackCheck } from './resolve';
export {
    TILE_KINDS, DEFAULT_SPEED, REACH_DISTANCE, RANGED_DISTANCE, HAZARD_AVOID_PENALTY, HALF_COVER_BONUS, THREE_QUARTER_COVER_BONUS,
    inBounds, tileAt, isWalkable, isWalkableTile, distance, samePos, canStep, traceLine, hasLineOfSight, coverBetween,
    speedOf, rangeOf, sameTeam, isFullyConnected, terrainOf,
} from './grid';
export {
    MAP_SIZES, SPAWN_COLUMNS, DEFAULT_HAZARD_TYPE,
    normalizeMapSize, openArena, buildTerrain, generateMap, placeCombatants, buildGrid,
    buildMapFromSeed, isValidGrid, ensureGrid, withMapLabels, hasHazardFreeRoute, isPlayableMap,
} from './mapBuilder';
export {
    HAZARD_KINDS, MAP_SIZE_KEYS, LABEL_MAX, AREA_KEYWORDS, HAZARD_KEYWORDS, KEYWORD_COUNT,
    normalizeMapSpec, normalizeLabels, cleanLabel, inferMapSpec, inferHazard, resolveMapSpec, mapSizeFor, defaultLabels,
} from './mapSpec';
export type { MapInference, ResolveOptions } from './mapSpec';
export {
    AREA_TYPES, MAP_DENSITIES, STRUCTURAL_AREAS, AREA_GENERATORS, DEFAULT_AREA_LABELS, DEFAULT_HAZARD_LABELS,
    shareBand, measuredRows, bandCounts, terrainShare,
} from './areas/index';
export type { AreaGenerator, AreaLayout, BandCounts } from './areas/index';
export type { SpawnEntry } from './mapBuilder';
export { simulateFights } from './simulate';
export type { SimulationResult, SimulationOptions } from './simulate';
