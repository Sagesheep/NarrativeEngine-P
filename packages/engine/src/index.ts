// @narrative/engine — shared Narrative Engine core.
// Pure TypeScript: no React, no Zustand, no storage, no platform APIs.

export {
    rollEngines, rollDiceFairness, resolveManualRoll,
    executeGateRoll, parseDiceExpr,
} from './rolls/engineRolls';
export type { EngineRollResult, GateRollResult, ManualRollResult } from './rolls/engineRolls';

export { mapTier, mapTierLegacy, validateBands } from './rolls/diceTier';
export type { LegacyDiceConfig } from './rolls/diceTier';

export type {
    OutcomeBand, DieType, RollAggregation, RollModifier, RollDefinition,
    DiceCategory, DiceSystemConfig, ManualRollRequest,
    EngineTierConfig, WorldEventConfig, LegacyDiceThresholds, EngineRollContext,
    WorldTagParts, WorldTagFormatter, EngineDefaultLists, RollEnginesOptions,
} from './rolls/types';

export { computeIdf, fuseRRF } from './retrieval/lexicalFusion';

export { extractJson, extractJsonRobust } from './json/jsonExtract';

export {
    ENVELOPES, MODIFIERS, GROUP_KEYS,
} from './npc/dispositionGroups';
export type { AxisSpread, AxisEnvelope, GroupEnvelope, AxisModifier, GroupModifiers } from './npc/dispositionGroups';
export { buildVoiceDirective } from './npc/hexVoiceGuide';
export type { HexAxis, PersonalityHex } from './npc/types';

export {
    createRng, ABILITY_KEYS, TIER_LEVEL, abilityMod, proficiencyForLevel,
    PC_POINT_BUY, POINT_BUY_COST, OP_POINT_BUY_COST, INVALID_POINT_COST,
    DEFAULT_ABILITIES, ARCHETYPE_KEYS, ARCHETYPE_PRESETS,
    getPointCost, validateAllocation, allocateAbility,
    createDefaultSheet, deriveSheet, levelForBudget,
    TIER_TABLE, DEFAULT_JITTER_RANGE, BASE_ENEMY_ABILITIES, DEFAULT_DAMAGE_TYPE, buildTierBlock,
    PC_COMBATANT_ID, WEAPON_QUALITY_DICE, UNARMED_DIE, FALLBACK_WEAPON_DIE, buildPcCombatant,
    DEFEND_CONDITION, isHostile, canTarget, currentActorId, checkOutcome, applyAction,
    chooseEngineTurn, stepEngine, runEngineTurns, createCombat, hpBand, simulateFights, HAZARD_DAMAGE_DIE,
    freshTurn, currentTurn, checkAttack, reachable, pathTo, deriveMapSeed, hasUsableBonusAbility, terrainOf,
    STUNNED, SLOWED, HASTED, SHIELDED, COMBAT_EVENT_TYPES, canAttackWith, hasCondition, countsForOutcome,
    FORM_IDS, EFFECT_IDS, AUGMENT_IDS, FORMS, EFFECTS, AUGMENT_COSTS, GLYPH_NUMBERS, SUMMON_TIERS, UNSTUNNABLE_TIERS,
    MP_BASE, MP_PER_LEVEL, MP_PER_CASTING_MOD, MP_MIN, SINGLE_TARGET_FORMS,
    CASTING_KEYS, defaultCastingAbility, castingAbilityOf, deriveMaxMp, proficiencyOf, castingModOf, casterStats, saveDc,
    saveModifier, projectileRange, lineLength, lineWidth, coneLength, burstRange, burstRadius, dashLength, blinkRange,
    DEFAULT_ABILITY_LIMITS, cleanAbilityName, glyphCount, abilityCost, validateAbility, describeAbility, isGlyphAbilityShape,
    abilityTargets, legalAims, directionOf, tileEffectOf, isEmptyTile,
    findKitAbility, abilitySlot, usesMp, abilityReadiness, checkAbility,
    enemyKit, ENEMY_BOLT_ID, ENEMY_BURST_ID, STARTER_ABILITIES,
    emptyChain, chainOf, allGlyphs, acceptedAugments, glyphsAccepting, augmentCapacity, glyphCost, chainCost, chainCount,
    socketGlyph, placeGlyph, removeGlyph, placementReason, chainColumns, socketKey, sameSocket, firstFreeSocket,
    autoPlacementReason, describeGlyph, previewAbility, previewState, PREVIEW_SIZE, PREVIEW_USER_ID,
    TILE_KINDS, DEFAULT_SPEED, REACH_DISTANCE, RANGED_DISTANCE, HAZARD_AVOID_PENALTY, HALF_COVER_BONUS, THREE_QUARTER_COVER_BONUS,
    inBounds, tileAt, isWalkable, isWalkableTile, distance, samePos, canStep, traceLine, hasLineOfSight, coverBetween,
    speedOf, rangeOf, sameTeam,
    MAP_SIZES, SPAWN_COLUMNS, DEFAULT_HAZARD_TYPE,
    normalizeMapSize, isFullyConnected, openArena, buildTerrain, generateMap, placeCombatants, buildGrid,
    buildMapFromSeed, isValidGrid, ensureGrid, withMapLabels, hasHazardFreeRoute, isPlayableMap,
    HAZARD_KINDS, MAP_SIZE_KEYS, LABEL_MAX, AREA_KEYWORDS, HAZARD_KEYWORDS, KEYWORD_COUNT,
    normalizeMapSpec, normalizeLabels, cleanLabel, inferMapSpec, inferHazard, resolveMapSpec, mapSizeFor, defaultLabels,
    AREA_TYPES, MAP_DENSITIES, STRUCTURAL_AREAS, AREA_GENERATORS, DEFAULT_AREA_LABELS, DEFAULT_HAZARD_LABELS,
    shareBand, measuredRows, bandCounts, terrainShare,
    concedeCombat, playerCharacterOf, OUTCOME_TEXT, HARDCORE_DEATH_MAX, isPlayerSide,
    MORALE_DC, MORALE_DC_LEADER_DOWN, PARLEY_DC, PARLEY_LOSING_SHIFT, PARLEY_FAILURE_STEP, PARLEY_INTENTS, PARLEY_RATINGS,
    MECHANICAL_INTENTS, teamOfSide, isEdgeTile, edgeTiles, buildMoraleBook, teamLoss, lostHalf, isLeaderDown, isOutnumbered,
    startedOnEdge, checkFlee, isRetreating, canAbandon, checkParley, resolveSpeaker, onlySummonedEnemies,
    earlierParleyFailures, parleyDc,
} from './combat/index';
export type {
    AbilityKey, AbilityScores, CombatTier, Archetype, PointBudget,
    CombatSheet, DerivedSheet, Rng, PointBuyConfig, PointBuyAllocation,
    Side, Controller, CombatantStatus, DamageSpec, Combatant, CombatOutcome, CombatState,
    CombatAction, CombatEvent, TierBlock, CombatantSpec, CombatSpec, WeaponQuality, PcWeapon,
    PcCombatantInput, TierRow, HpBand, SimulationResult, SimulationOptions, AttackCheck, SpawnEntry,
    AttackRange, Tile, Grid, Pos, MapSize, MapSpec, TurnState, TemplateOverlay,
    AreaType, MapDensity, HazardKind, TerrainLabels, ResolvedMapSpec, MapInference, ResolveOptions,
    AreaGenerator, AreaLayout, BandCounts,
    FormId, EffectId, AugmentId, GlyphAbility, CombatCondition, Barrier,
    FormSpec, EffectSpec, FormRoll, CasterStats, AbilityLimits, AimResult, AbilityCheck, AbilitySlot, StarterPresetId,
    GlyphRef, GlyphKind, ChainDraft, SocketOwner, Socket, PlacementReason, ChainColumn, AbilityPreview, PreviewUnit,
    PartyControl, DefeatMode, Team, ParleyIntent, ParleyRating, ParleyEffect, ParleyRecord, FateRecord, MoraleBook, CombatEnding,
    FleeReason, FleeCheck, ParleyReason,
} from './combat/index';

export { resolveLootDrop } from './loot/lootEngine';
export type {
    LootNodeId, LootPoolEntry, LootPool, LootPickNode, LootDrawSpec,
    LootDrawNode, LootAmountNode, LootComposeNode, LootNode, LootTree,
    LootProfile, LootItem, LootDropResult, ResolveLootOpts,
} from './loot/types';

export { createTableRegistry } from './tables/tableDescriptor';
export type {
    RecordShape, HookKind, TableHooks,
    TouchpointDeclaration, AbsentTouchpoint, Touchpoint,
    TableDescriptor, TableRegistry,
} from './tables/tableDescriptor';

export { createPanelRegistry } from './panels/panelDescriptor';
export type {
    PanelLayout, PanelLaunch, PanelCrudOperation,
    PanelInputControl, PanelControl, PanelOption,
    PanelComputed, PanelInputField, PanelComputedField, PanelField, FieldSpec,
    SearchSpec, FilterSpec, SortSpec, PanelFilter,
    PanelValidationResult, PanelHooks, PanelDescriptor, PanelRegistry,
    PanelTouchpoint,
} from './panels/panelDescriptor';
export { runPanelHook, evaluatePanelComputed } from './panels/panelHooks';
export type {
    PanelHookKind, PanelHookInvocation, PanelHookFault, PanelHookResult,
    PanelHookRunOptions, PanelComputedFault, PanelComputedResult, PanelComputedOptions,
} from './panels/panelHooks';

// Phase 8.5 — `enemy/enemyShape.ts` is gone, and with it the eight frozen
// field/enum arrays and five type guards this file used to re-export.
//
// ENEMY_SEAM.md flag #5 asked whether the engine package should keep owning the
// enemy shape so a third-party replacement mod could import it. The answer is
// no, and the code had already made it: after 8.2 deleted the server validator
// and 8.3/8.4 deleted the client normalizer, the shape had ZERO runtime
// consumers — the five type guards never had any at all. Keeping it would also
// not have bought what the flag hoped: mods are loaded from disk as plain JS
// and never go through this bundle, so no mod could have imported it anyway.
// The `enemies` mod carries its own field lists in `validator.js` and is the
// shape authority.
//
// What is knowingly lost: the compile-time `_EntryMatchesShared` assertion that
// pinned `keyof EnemyEntry` to `ENEMY_ENTRY_FIELDS`. A JSON-manifest mod cannot
// hold a type assertion. The mod has one field list instead of two, which is
// the other way to stop mirrors drifting.
