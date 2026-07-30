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
