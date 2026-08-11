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
