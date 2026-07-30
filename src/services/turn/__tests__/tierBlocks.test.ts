import { describe, it, expect } from 'vitest';
import { listTierBlocks, MATRIX, type TierFeature } from '../aiTier';

/**
 * WORKORDER-P5-01 §4 Step 5 — the declaration table tests.
 *
 * 27 TierFeature ids in, 27 TierBlock entries out. One entry per id, no dupes,
 * no omissions. Shape mirrors `ContributionRegistry.list()` and
 * `PostTurnTrackRegistry.list()`. `arcSpawn` is `trigger: 'manual'` and
 * `toggleable: false` per §3 (the press IS the gate; the matrix value is never
 * read). Features with no service-side call site are `trigger: 'manual'` per
 * the §5 rule.
 */

const TIER_FEATURE_IDS: TierFeature[] = [
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

describe('WORKORDER-P5-01 — listTierBlocks declaration table', () => {
    const blocks = listTierBlocks();

    it('returns one entry per TierFeature id (27 in, 27 out)', () => {
        expect(blocks).toHaveLength(TIER_FEATURE_IDS.length);
        const blockIds = blocks.map(b => b.id);
        for (const id of TIER_FEATURE_IDS) {
            expect(blockIds, `missing entry for ${id}`).toContain(id);
        }
        expect(new Set(blockIds).size).toBe(TIER_FEATURE_IDS.length);
    });

    it('every entry has the TierBlock shape (id, name, description, toggleable, trigger, defaultEnabled)', () => {
        for (const block of blocks) {
            expect(typeof block.id).toBe('string');
            expect(typeof block.name).toBe('string');
            expect(block.name.length).toBeGreaterThan(0);
            expect(typeof block.description).toBe('string');
            expect(block.description.length).toBeGreaterThan(0);
            expect(typeof block.toggleable).toBe('boolean');
            expect(['automatic', 'manual']).toContain(block.trigger);
            expect(typeof block.defaultEnabled).toBe('boolean');
        }
    });

    it('defaultEnabled matches the pro preset (the default tier — ?? pro fallback)', () => {
        for (const block of blocks) {
            expect(block.defaultEnabled, `defaultEnabled for ${block.id}`).toBe(MATRIX.pro[block.id]);
        }
    });

    it('arcSpawn is manual and not toggleable (the press IS the gate)', () => {
        const arcSpawn = blocks.find(b => b.id === 'arcSpawn');
        expect(arcSpawn).toBeDefined();
        expect(arcSpawn!.trigger).toBe('manual');
        expect(arcSpawn!.toggleable).toBe(false);
    });

    it('features with no service-side call site are manual', () => {
        // Per §5: "a feature with no service-side call site is manual."
        // witnessAux and npcProfileGen have zero call sites in src/services.
        const witnessAux = blocks.find(b => b.id === 'witnessAux');
        expect(witnessAux).toBeDefined();
        expect(witnessAux!.trigger).toBe('manual');

        const npcProfileGen = blocks.find(b => b.id === 'npcProfileGen');
        expect(npcProfileGen).toBeDefined();
        expect(npcProfileGen!.trigger).toBe('manual');
    });

    it('the 24 pipeline-fired features are automatic', () => {
        const manualIds = new Set(['arcSpawn', 'witnessAux', 'npcProfileGen']);
        for (const block of blocks) {
            if (manualIds.has(block.id)) continue;
            expect(block.trigger, `${block.id} should be automatic`).toBe('automatic');
        }
    });

    it('listTierBlocks returns a readonly array (defensive copy)', () => {
        const a = listTierBlocks();
        const b = listTierBlocks();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });
});