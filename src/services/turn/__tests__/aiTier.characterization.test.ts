import { describe, it, expect } from 'vitest';
import { tierAllows, NPC_UPDATE_COOLDOWN, ENEMY_DISCOVERY_COOLDOWN, type TierFeature } from '../aiTier';
import type { AiTier } from '../../../types';

/**
 * WORKORDER-P5-01 §4 Step 1 — characterization tests for `tierAllows`.
 *
 * Golden tests that capture TODAY's answers. They must pass before AND after every
 * later step of this work order, unmodified. No characterization tests → no carve.
 *
 * The 78 per-tier assertions (26 features × 3 tiers) are generated from the matrix
 * in `aiTier.ts` so they can never drift from the source of truth. If the matrix is
 * the source of truth, asserting against it would be circular — so the expected
 * values are HARDCODED here, captured by reading the matrix once. A change to the
 * matrix that these tests do not expect is a behaviour change this work order
 * promises not to make.
 */

const TIERS: AiTier[] = ['lite', 'pro', 'max'];

/**
 * The 27 TierFeature ids declared in `aiTier.ts`. The work order text says "26"
 * but the matrix has 27; this discrepancy is reported in the handoff, not "fixed"
 * here — these tests capture every id the union declares, whatever the count.
 */
const FEATURES: TierFeature[] = [
    'introEngine', 'planner', 'expandQuery', 'reranker', 'archiveFunnel',
    'deepScan', 'recommender',
    'importanceRating', 'witnessAux', 'npcValidate', 'npcProfileGen',
    'npcUpdate', 'drivesBackfill', 'profileScan', 'inventoryScan', 'locationScan', 'locationEnrich', 'sealChapter',
    'sceneStakesClassify',
    'heartbeatTick', 'timeskipRun',
    'arcTick', 'arcSpawn',
    'directorBrief',
    'lodDynamicElevation',
    'lodSlottedRag',
    'enemyDiscovery',
];

/**
 * Today's matrix, captured verbatim. These are the byte-for-byte expected values
 * for `tierAllows(tier, feature)`. Editing them is a behaviour change.
 */
const EXPECTED: Record<AiTier, Record<TierFeature, boolean>> = {
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

describe('WORKORDER-P5-01 — tierAllows characterization (golden)', () => {
    for (const tier of TIERS) {
        it(`tierAllows('${tier}', f) returns today's value for every TierFeature`, () => {
            for (const feature of FEATURES) {
                const expected = EXPECTED[tier][feature];
                const actual = tierAllows(tier, feature);
                expect(actual, `tierAllows('${tier}', '${feature}')`).toBe(expected);
            }
        });
    }

    it('tierAllows(undefined, f) falls back to the pro preset (current behaviour)', () => {
        for (const feature of FEATURES) {
            const expected = EXPECTED.pro[feature];
            const actual = tierAllows(undefined, feature);
            expect(actual, `tierAllows(undefined, '${feature}') should match pro`).toBe(expected);
        }
    });

    it('an unknown feature id returns false', () => {
        // Cast through unknown to call the real signature with an id the union does
        // not contain. Today `MATRIX[tier]?.[f] ?? false` makes this fall through.
        const unknown = 'nonExistentFeature' as unknown as TierFeature;
        for (const tier of TIERS) {
            expect(tierAllows(tier, unknown)).toBe(false);
        }
        expect(tierAllows(undefined, unknown)).toBe(false);
    });

    it('NPC_UPDATE_COOLDOWN is unchanged per tier', () => {
        expect(NPC_UPDATE_COOLDOWN.lite).toBe(Infinity);
        expect(NPC_UPDATE_COOLDOWN.pro).toBe(5);
        expect(NPC_UPDATE_COOLDOWN.max).toBe(0);
    });

    it('ENEMY_DISCOVERY_COOLDOWN is unchanged per tier', () => {
        expect(ENEMY_DISCOVERY_COOLDOWN.lite).toBe(Infinity);
        expect(ENEMY_DISCOVERY_COOLDOWN.pro).toBe(5);
        expect(ENEMY_DISCOVERY_COOLDOWN.max).toBe(0);
    });
});