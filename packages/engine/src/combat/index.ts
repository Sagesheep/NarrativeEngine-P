export type {
    AbilityKey, AbilityScores, CombatTier, Archetype, PointBudget,
    CombatSheet, DerivedSheet, Rng,
    Side, Controller, CombatantStatus, DamageSpec, Combatant, CombatOutcome, CombatState, Speech, Tactic, PlanIntent, PlanIntentKind, TurnPlan,
    CombatAction, CombatEvent, TierBlock, CombatantSpec, CombatSpec, WeaponQuality, PcWeapon,
    PcCombatantInput, AttackRange, Tile, Grid, Pos, MapSize, MapSpec, TurnState, TemplateOverlay,
    AreaType, MapDensity, HazardKind, TerrainLabels, ResolvedMapSpec,
    FormId, EffectId, AugmentId, GlyphAbility, BuiltinKind, BuiltinProfile, CombatCondition, Barrier,
    StuntCheckProfile, StuntOutcome, StuntDifficulty, StuntPart, StuntSpec,
    PartyControl, DefeatMode, Team, ParleyIntent, ParleyRating, ParleyEffect, ParleyRecord, FateRecord, MoraleBook, CombatEnding,
    TerrainEdit, CarriedItem, FieldItem, WeaponFields, ThrowPayload, PcCarriedInput,
} from './types';
export {
    MORALE_DC, MORALE_DC_LEADER_DOWN, PARLEY_DC, PARLEY_LOSING_SHIFT, PARLEY_FAILURE_STEP, PARLEY_INTENTS, PARLEY_RATINGS,
    MECHANICAL_INTENTS, teamOfSide, isEdgeTile, edgeTiles, buildMoraleBook, teamLoss, lostHalf, isLeaderDown, isOutnumbered,
    startedOnEdge, checkFlee, isRetreating, canAbandon, checkParley, resolveSpeaker, onlySummonedEnemies,
    earlierParleyFailures, parleyDc,
} from './party';
export type { FleeReason, FleeCheck, ParleyReason } from './party';
export { createRng } from './rng';
export { SPEECH_VALUES, SOUNDS_KEYWORDS, SILENT_KEYWORDS, SPEAKS_KEYWORDS, normalizeSpeech, inferSpeech, speechOf, canSpeak } from './speech';
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
export { planTurn, planIntents, termsFor } from './ai/plan';
export { normalizeTactic, deriveTactic, tacticOf } from './ai/tactic';
export {
    TACTICS, TARGET_TERMS, POSITION_TERMS, ACTION_TERMS, ALL_TERMS, AI_WEIGHTS, TIER_DEPTH, AUTOPILOT_DEPTH, TACTIC_PROFILES,
    TACTIC_DERIVATION, DEFAULT_TACTIC, AI_LIMITS,
} from './ai/tables';
export type { TermId, TargetTerm, PositionTerm, ActionTerm, TacticProfile, TacticRule } from './ai/tables';
export {
    STUNNED, SLOWED, HASTED, SHIELDED, COMBAT_EVENT_TYPES, canAttackWith, hasCondition, countsForOutcome,
    playerCharacterOf, OUTCOME_TEXT, HARDCORE_DEATH_MAX, isPlayerSide, recoverFieldItems, fieldItemData,
} from './core';
export * from './glyphs/index';
export type { HpBand, AttackCheck, ActionOptions } from './resolve';
export {
    TILE_KINDS, DEFAULT_SPEED, REACH_DISTANCE, RANGED_DISTANCE, HAZARD_AVOID_PENALTY, HALF_COVER_BONUS, THREE_QUARTER_COVER_BONUS,
    inBounds, tileAt, isWalkable, isWalkableTile, distance, samePos, canStep, traceLine, hasLineOfSight, coverBetween,
    speedOf, rangeOf, sameTeam, isFullyConnected, terrainOf, surfaceOf,
} from './grid';
export {
    MAP_SIZES, MAP_GENERATOR_VERSION, SPAWN_COLUMNS, DEFAULT_HAZARD_TYPE,
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
export type {
    ObjectiveMark, WinKind, LoseKind, SideKind, PairedWin, WinCondition, LoseCondition, SideObjective, ObjectiveProgress, ObjectiveEndReason,
    ObjectiveResult, CombatObjective, ObjectiveRequest, RepairCode, ObjectiveRepair, ReinforcementEdge, ReinforcementLevel, ReinforcementTrigger,
    ReinforcementWaveRequest, ReinforcementRequest, ReinforcementWave, ReinforcementBook, ObjectiveReport,
} from './types';
export {
    WIN_KINDS, LOSE_KINDS, SIDE_KINDS, REINFORCEMENT_LEVELS, OBJECTIVE_EVENT_TYPES, OBJECTIVE_LIMITS, OBJECTIVE_WEIGHTS, REINFORCEMENT_THREAT,
    REINFORCEMENT_BUDGET, REINFORCEMENT_WAVES, REINFORCEMENT_KIND_SCALE, REINFORCEMENT_MIN_BUDGET,
} from './objectives/tables';
export {
    objectiveMarks, objectiveClock, mainWin, wardIdOf, leaderIdOf, bystanderIdOf, exitsOf, leaderExitsOf, seizeTileOf, reachTileOf,
} from './objectives/marks';
export type { ObjectiveMarks, ObjectiveClock } from './objectives/marks';
export {
    validateObjective, planReinforcements, normalizeObjectiveRequest, normalizeReinforcementRequest, reinforcementBudget,
} from './objectives/validate';
export type { ObjectiveSetup, ObjectiveSetupUnit, WavePlan, ReinforcementPlan } from './objectives/validate';
export { undoObjectiveEvent, arrivalTiles } from './objectives/run';
export type { ObjectiveSummary } from './objectives/run';
export { distanceField } from './grid';
export type { SimulationResult, SimulationOptions } from './simulate';
