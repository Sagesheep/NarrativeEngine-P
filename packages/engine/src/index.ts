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

export {
    ENEMY_TEXT_FIELDS, ENEMY_LIST_FIELDS, ENEMY_ENTRY_FIELDS,
    ENCOUNTER_STATUSES, ENCOUNTER_OUTCOMES, INSTANCE_DISPOSITIONS,
    INITIATIVE_MODES, BARRIER_MODES,
    isEncounterStatus, isEncounterOutcome, isInstanceDisposition,
    isInitiativeMode, isBarrierMode,
} from './enemy/enemyShape';
