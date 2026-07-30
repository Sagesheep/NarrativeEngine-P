import type { AiTier } from '../../types';
import { isBlockEnabled } from './blockEnablement';

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
  | 'lodSlottedRag'
  | 'enemyDiscovery';

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
        enemyDiscovery: false,
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
        enemyDiscovery: true,
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
        enemyDiscovery: true,
    },
};

export function tierAllows(tier: AiTier | undefined, f: TierFeature): boolean {
    // The resolver returns `true` for ids not in the matrix (the "absent means enabled"
    // convention for contributions/tracks). `tierAllows` is typed to `TierFeature` and its
    // historical contract is "unknown id → false" (the `?? false` in the old body), so guard
    // the fallthrough here. The 31 call sites only ever pass valid `TierFeature` literals,
    // so this branch is unreachable in production — it preserves the typed contract.
    if (!(f in MATRIX[tier ?? 'pro'])) return false;
    return isBlockEnabled(f, tier, undefined);
}

// 0 = every turn (Max), Infinity = never (Lite)
export const NPC_UPDATE_COOLDOWN: Record<AiTier, number> = { lite: Infinity, pro: 5, max: 0 };

// Enemy discovery cooldown: Lite is runtime-blocked (Infinity). Pro scans at most
// once every 5 committed turns. Max may scan after every committed turn (0).
// The cooldown is a minimum gap between the scene number of the last accepted scan
// and the scene number of the next eligible turn.
export const ENEMY_DISCOVERY_COOLDOWN: Record<AiTier, number> = { lite: Infinity, pro: 5, max: 0 };

/**
 * WORKORDER-P5-01 §4 Step 5 — the 27 tier features as listable blocks.
 *
 * `TierFeature` is a string-literal union plus a boolean matrix, not objects, so it has
 * nothing to list. This declaration table gives each feature the metadata the block view
 * (WO-P5-02) renders: `id`, `name`, `description`, `toggleable`, and `trigger`.
 *
 * `trigger` exists because a tier gates automation, not capability (§3): 24 of the 27
 * features fire from the turn pipeline (`automatic`); `arcSpawn` fires only from a button
 * (`manual`), so its matrix value is never read and a toggle for it would do nothing.
 * `witnessAux` and `npcProfileGen` have no service-side call site at all — no pipeline
 * step and no button. They are `unwired`: present in the matrix as reserved slots, inert
 * in the graph, shown to the user as "no call site exists yet" so a reader does not hunt
 * for a control that is not there.
 *
 * `listTierBlocks()` mirrors the shape `ContributionRegistry.list()` and
 * `PostTurnTrackRegistry.list()` already return, so one consumer can walk all three.
 */
export type TierBlockTrigger = 'automatic' | 'manual' | 'unwired';

export interface TierBlock {
    id: TierFeature;
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
    { id: 'enemyDiscovery', name: 'Enemy Discovery', description: 'Scans committed scenes for new enemy entries and adds them to the compendium under a cooldown.', toggleable: true, trigger: 'automatic', defaultEnabled: true, callsModel: true },
];

export function listTierBlocks(): readonly TierBlock[] {
    return [...TIER_BLOCKS];
}
