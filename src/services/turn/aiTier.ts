import type { AiTier } from '../../types';
import { isBlockEnabled } from './blockEnablement';
import { createTierBlockRegistry } from './tierBlockRegistry';

export type TierFeature =
  | 'introEngine' | 'planner' | 'expandQuery' | 'reranker' | 'archiveFunnel'
  | 'deepScan' | 'recommender'
  | 'importanceRating' | 'witnessAux' | 'npcValidate' | 'npcProfileGen'
  | 'npcUpdate' | 'drivesBackfill' | 'profileScan' | 'inventoryScan' | 'locationScan' | 'locationEnrich' | 'sealChapter'
  | 'sceneStakesClassify'
  | 'heartbeatTick' | 'timeskipRun'
  | 'arcTick' | 'arcSpawn'
  | 'directorBrief'
  | 'lodDynamicElevation'
  | 'lodSlottedRag';

/**
 * Phase 8.3 — `tierAllows`'s parameter is widened to `string` so a mod's
 * declared tier entry (e.g. `mod.<modId>.enemyDiscovery`) passes the type
 * check at the call site. 7.3 forbade touching the signature because
 * removing `'enemyDiscovery'` from the `TierFeature` union would have
 * broken the one enemy call site before the mod's replacement existed.
 * 8.3 is the phase that may, and does this as one deliberate widening
 * rather than as a side effect of a delete. `tierAllows`'s logic is
 * unchanged: the built-in `MATRIX` lookup runs first for the 26 built-in
 * ids (byte-identical with the pre-8.3 behaviour), and any other id
 * falls through to `modTierBlocks.allows()`, which an id absent from
 * `MATRIX` and not registered as a mod entry resolves to `false`
 * (the "unknown → false" characterization contract).
 */

/**
 * Phase 7.3 — the mod-declared tier block registry. Module-level singleton,
 * like `postTurnTracks` (`tracks/index.ts`). Built-in tier features are NOT
 * registered here — they live in `MATRIX` + `TIER_BLOCKS` below. This registry
 * holds ONLY mod-declared entries. `tierAllows` consults `MATRIX` first
 * (byte-identical for the 27 built-in ids) and falls through to this registry
 * for any other id.
 */
export const modTierBlocks = createTierBlockRegistry();
export type { ModTierEntry } from './tierBlockRegistry';

export const MATRIX: Record<AiTier, Record<TierFeature, boolean>> = {
    lite: {
        introEngine: false, planner: false, expandQuery: false, reranker: false, archiveFunnel: false,
        deepScan: false, recommender: false,
        importanceRating: false, witnessAux: false, npcValidate: false, npcProfileGen: false,
        npcUpdate: false, drivesBackfill: false, profileScan: false, inventoryScan: false, locationScan: false, locationEnrich: false, sealChapter: false,
        sceneStakesClassify: false,
        heartbeatTick: false, timeskipRun: false,
        arcTick: false, arcSpawn: false,
        directorBrief: false,
        lodDynamicElevation: false,
        lodSlottedRag: false,
    },
    pro: {
        introEngine: false, planner: true, expandQuery: false, reranker: false, archiveFunnel: true,
        deepScan: true, recommender: true,
        importanceRating: false, witnessAux: false, npcValidate: true, npcProfileGen: true,
        npcUpdate: true, drivesBackfill: false, profileScan: false, inventoryScan: false, locationScan: false, locationEnrich: true, sealChapter: true,
        sceneStakesClassify: true,
        heartbeatTick: true, timeskipRun: true,
        arcTick: true, arcSpawn: true,
        directorBrief: true,
        lodDynamicElevation: true,
        lodSlottedRag: false,
    },
    max: {
        introEngine: true, planner: true, expandQuery: true, reranker: true, archiveFunnel: true,
        deepScan: true, recommender: true,
        importanceRating: true, witnessAux: true, npcValidate: true, npcProfileGen: true,
        npcUpdate: true, drivesBackfill: true, profileScan: true, inventoryScan: true, locationScan: true, locationEnrich: true, sealChapter: true,
        sceneStakesClassify: true,
        heartbeatTick: true, timeskipRun: true,
        arcTick: true, arcSpawn: true,
        directorBrief: true,
        lodDynamicElevation: true,
        lodSlottedRag: true,
    },
};

export function tierAllows(tier: AiTier | undefined, f: string): boolean {
    const t = tier ?? 'pro';
    // Built-in features: byte-identical resolution (the 26 TierFeature ids).
    // The MATRIX lookup and isBlockEnabled call are the same body this
    // function has had since WORKORDER-P5-01 — no call site sees a change.
    if (f in MATRIX[t]) return isBlockEnabled(f as TierFeature, tier, undefined);
    // Phase 7.3 — mod-declared tier entries: resolve through the mod's
    // declared per-tier matrix. An id not in the built-in MATRIX and not
    // registered as a mod entry returns `false`, preserving the "unknown →
    // false" characterization contract.
    return modTierBlocks.allows(t, f);
}

// 0 = every turn (Max), Infinity = never (Lite)
export const NPC_UPDATE_COOLDOWN: Record<AiTier, number> = { lite: Infinity, pro: 5, max: 0 };

/**
 * WORKORDER-P5-01 §4 Step 5 — the 26 tier features as listable blocks.
 *
 * `TierFeature` is a string-literal union plus a boolean matrix, not objects, so it has
 * nothing to list. This declaration table gives each feature the metadata the block view
 * (WO-P5-02) renders: `id`, `name`, `description`, `toggleable`, and `trigger`.
 *
 * `trigger` exists because a tier gates automation, not capability (§3): 23 of the 26
 * features fire from the turn pipeline (`automatic`); `arcSpawn` fires only from a button
 * (`manual`), so its matrix value is never read and a toggle for it would do nothing.
 * `witnessAux` and `npcProfileGen` have no service-side call site at all — no pipeline
 * step and no button. They are `unwired`: present in the matrix as reserved slots, inert
 * in the graph, shown to the user as "no call site exists yet" so a reader does not hunt
 * for a control that is not there.
 *
 * Phase 8.3 — the 27th built-in (`enemyDiscovery`) is gone. The enemies mod
 * (8.5) declares its own tier entry (`mod.enemies.enemyDiscovery`) through
 * `tierEntries` in its manifest, which `modTierBlocks` resolves exactly as a
 * built-in MATRIX row would. The `ENEMY_DISCOVERY_COOLDOWN` constant retired
 * with the literal; the mod declares its own cooldown through the 7.3
 * registry's `cooldown` field on the tier entry.
 *
 * `listTierBlocks()` mirrors the shape `ContributionRegistry.list()` and
 * `PostTurnTrackRegistry.list()` already return, so one consumer can walk all three.
 */
export type TierBlockTrigger = 'automatic' | 'manual' | 'unwired';

export interface TierBlock {
    /**
     * Stable unique id. Built-in entries use a `TierFeature` literal; mod
     * entries use a namespaced string (`mod.<modId>.<entryId>`). Widened from
     * `TierFeature` to `string` in Phase 7.3 so mod-declared entries share
     * the `TierBlock` shape without the compile-time union having to list them.
     */
    id: string;
    name: string;
    description: string;
    toggleable: boolean;
    trigger: TierBlockTrigger;
    defaultEnabled: boolean;
    /**
     * Whether this block calls a language model. WO-P5-02 §5 — the block view renders
     * an ENGINE / MODEL badge per block from this metadata, never from feature-name
     * checks. Defaults to `false` (engine code only) for safety: a block that does
     * not declare itself a model call is shown as ENGINE, which is the cheaper wrong
     * answer to give a user who is trying to understand what costs them tokens.
     */
    callsModel?: boolean;
    /**
     * Phase 7.3 — provenance. Present (set to the mod id) on mod-declared
     * entries; absent on built-ins. The block view renders this under the
     * description so a user can see which mod contributed the feature.
     */
    modId?: string;
}

const TIER_BLOCKS: readonly TierBlock[] = [
    { id: 'introEngine', name: 'Character Intro Engine', description: 'Rolls a one-line introduction tag for newly mentioned NPCs before the GM writes the reply.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'planner', name: 'Archive Planner', description: 'Asks a utility model which past scenes to recall before the main turn runs.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'expandQuery', name: 'Query Expansion', description: 'Expands short user messages into richer retrieval queries for semantic archive search.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'reranker', name: 'Semantic Reranker', description: 'Re-ranks archive search results with a utility model after the first-pass retrieval.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'archiveFunnel', name: 'Chapter Recall Funnel', description: 'Uses a multi-round chapter funnel to find the most relevant sealed-chapter scenes.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'deepScan', name: 'Deep Archive Search', description: 'Runs a two-round LLM deep scan across sealed chapters when standard recall is not enough.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'recommender', name: 'Context Recommender', description: 'Asks a utility model which world-state fields the GM should focus on this turn.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'importanceRating', name: 'Scene Importance Rating', description: 'Rates each committed scene 1–5 so the archive can prioritise high-stakes events.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'witnessAux', name: 'Witness Capture (Auxiliary)', description: 'Reserved tier slot for an auxiliary witness-capture pass. No call site exists yet — neither a pipeline step nor a button.', toggleable: true, trigger: 'unwired', defaultEnabled: false, callsModel: false },
    { id: 'npcValidate', name: 'NPC Name Validation', description: 'Validates extracted NPC names with a fail-closed LLM check before adding them as suggestions.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'npcProfileGen', name: 'NPC Profile Generation', description: 'Reserved tier slot for LLM-generated NPC profiles. No call site exists yet — neither a pipeline step nor a button.', toggleable: true, trigger: 'unwired', defaultEnabled: true, callsModel: false },
    { id: 'npcUpdate', name: 'NPC Profile Update', description: 'Background LLM call that refreshes known NPC profiles from the latest scene text.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'drivesBackfill', name: 'NPC Drives Backfill', description: 'Backfills missing goal/want records for known NPCs so the agency engine can act on them.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'profileScan', name: 'Character Profile Scan', description: 'Periodically scans chat history to keep the player character sheet and active traits current.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'inventoryScan', name: 'Inventory Scan', description: 'Periodically scans chat history to keep the player inventory list current.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'locationScan', name: 'Location Scan', description: 'Periodically scans chat history to resolve the current place and merge location ledger entries.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: true },
    { id: 'locationEnrich', name: 'Location Enrichment', description: 'Enriches location ledger entries with features and connections drawn from the scene.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'sealChapter', name: 'Chapter Auto-Seal', description: 'Seals a chapter and writes its summary when it reaches the scene-count soft cap.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'sceneStakesClassify', name: 'Scene Stakes Classifier', description: 'Classifies the stakes of a committed scene when the GM omitted the tag, so downstream systems can react.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'heartbeatTick', name: 'NPC Agency Heartbeat', description: 'Runs the off-screen NPC agency tick that pursues goals, drifts hexes, and collides with rivals.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: false },
    { id: 'timeskipRun', name: 'Timeskip Narration', description: 'Simulates off-screen NPC life and narrates the return when the player skips weeks at once.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'arcTick', name: 'Arc Engine Tick', description: 'Rolls tempo per active arc, advances the ladder, and folds the surface line into the next GM call.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: false },
    { id: 'arcSpawn', name: 'Arc Injector Spawn', description: 'Fires a new systemic-conflict arc from the Arc Injector button. The press is the gate; the tier matrix value is never read.', toggleable: false, trigger: 'manual', defaultEnabled: true, callsModel: true },
    { id: 'directorBrief', name: 'Director Brief', description: 'Asks a utility model for scene directives that steer the next GM reply.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
    { id: 'lodDynamicElevation', name: 'Dynamic Scene Elevation', description: 'Elevates synopsis-tier scenes verbatim below the cache boundary when they are highly relevant.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: false },
    { id: 'lodSlottedRag', name: 'Slotted RAG Snippets', description: 'Injects one-line snippets from synopsis-tier scenes that had search hits but were not elevated.', toggleable: true, trigger: 'automatic', defaultEnabled: false, callsModel: false },
];

export function listTierBlocks(): readonly TierBlock[] {
    // Phase 7.3 — built-ins first (stable order, matching the declaration
    // table), then mod-declared entries in registration order. The block
    // view walks one list; mod entries appear alongside built-ins.
    return [...TIER_BLOCKS, ...modTierBlocks.list()];
}
