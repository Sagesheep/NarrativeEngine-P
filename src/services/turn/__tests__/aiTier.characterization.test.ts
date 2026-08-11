import { describe, it, expect, beforeEach } from 'vitest';
import { tierAllows, NPC_UPDATE_COOLDOWN, modTierBlocks, type TierFeature } from '../aiTier';
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
 *
 * Phase 8.3 — `enemyDiscovery` is no longer a `TierFeature` union member. The
 * 26 built-in ids below are the post-8.3 set. The mod (8.5) declares its own
 * `mod.enemies.enemyDiscovery` tier entry through the 7.3 registry; the
 * `tierAllows` fallthrough resolves it exactly as a built-in MATRIX row would.
 * The `ENEMY_DISCOVERY_COOLDOWN` constant retired with the union literal
 * (enemy-named); the mod declares its own cooldown through the tier entry's
 * `cooldown` field. The golden test for the cooldown is removed with the
 * constant — the mod's own controller test will cover its cooldown post-8.5.
 */

const TIERS: AiTier[] = ['lite', 'pro', 'max'];

/**
 * The 26 TierFeature ids declared in `aiTier.ts` (post-Phase 8.3). Phase 8.3
 * removed `enemyDiscovery` from the union; the mod (8.5) declares its own
 * `mod.enemies.enemyDiscovery` through the 7.3 registry.
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

describe('WORKORDER-P5-01 — tierAllows characterization (golden)', () => {
    beforeEach(() => {
        // Phase 7.3 — ensure no mod-declared tier entries leak in from other
        // test files. The golden tests capture TODAY's built-in behaviour;
        // a stray mod entry must not change the answers.
        modTierBlocks.clear();
    });

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
        // Phase 8.3 — `tierAllows`'s parameter is widened to `string`, so an
        // unknown id is passed through directly (no cast needed). Today
        // `MATRIX[tier]?.[f] ?? false` makes this fall through to
        // `modTierBlocks.allows()`, which returns `false` for an unregistered
        // id — the "unknown → false" characterization contract.
        const unknown = 'nonExistentFeature';
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
});