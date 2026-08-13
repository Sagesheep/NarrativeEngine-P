import { describe, it, expect, beforeEach } from 'vitest';
import { listTierBlocks, MATRIX, modTierBlocks, type TierFeature } from '../aiTier';

/**
 * WORKORDER-P5-01 §4 Step 5 — the declaration table tests.
 *
 * 27 TierFeature ids in, 27 TierBlock entries out. One entry per id, no dupes,
 * no omissions. Shape mirrors `ContributionRegistry.list()` and
 * `PostTurnTrackRegistry.list()`. `arcSpawn` is `trigger: 'manual'` and
 * `toggleable: false` per §3 (the press IS the gate; the matrix value is never
 * read). Features with no call site at all — no pipeline step and no button —
 * are `trigger: 'unwired'`: present-but-inert, shown to the user as "no call
 * site exists yet" so a reader does not hunt for a control that is not there.
 *
 * Phase 8.3 — `enemyDiscovery` is gone from the union (27 built-ins now). The
 * enemies mod (8.5) declares its own `mod.enemies.enemyDiscovery` tier entry
 * through the 7.3 registry; `listTierBlocks` returns it alongside the built-ins
 * once the mod is enabled.
 */

const TIER_FEATURE_IDS: TierFeature[] = [
    'introEngine', 'planner', 'expandQuery', 'reranker', 'archiveFunnel',
    'deepScan', 'recommender', 'npcStance',
    'importanceRating', 'witnessAux', 'npcValidate', 'npcProfileGen',
    'npcUpdate', 'drivesBackfill', 'profileScan', 'inventoryScan', 'locationScan', 'locationEnrich', 'sealChapter',
    'sceneStakesClassify',
    'heartbeatTick', 'timeskipRun',
    'arcTick', 'arcSpawn',
    'directorBrief',
    'lodDynamicElevation',
    'lodSlottedRag',
];

describe('WORKORDER-P5-01 — listTierBlocks declaration table', () => {
    beforeEach(() => {
        // Phase 7.3 — ensure no mod-declared tier entries leak in from other
        // test files. The declaration table tests expect exactly 27 built-ins.
        modTierBlocks.clear();
    });

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
            expect(['automatic', 'manual', 'unwired']).toContain(block.trigger);
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

    it('features with no call site at all are unwired (reserved slots, not manual)', () => {
        // Per §5: a feature with no pipeline step AND no button is `unwired`, not `manual`.
        // `manual` means "fires from a button"; these have no button either. Labelling them
        // manual sends a user hunting for a control that does not exist.
        const witnessAux = blocks.find(b => b.id === 'witnessAux');
        expect(witnessAux).toBeDefined();
        expect(witnessAux!.trigger).toBe('unwired');

        const npcProfileGen = blocks.find(b => b.id === 'npcProfileGen');
        expect(npcProfileGen).toBeDefined();
        expect(npcProfileGen!.trigger).toBe('unwired');
    });

    it('arcSpawn calls a model (the 2,000-token spawnArc LLM call)', () => {
        const arcSpawn = blocks.find(b => b.id === 'arcSpawn');
        expect(arcSpawn).toBeDefined();
        expect(arcSpawn!.callsModel).toBe(true);
    });

    it('the 23 pipeline-fired features are automatic', () => {
        const nonAutomaticIds = new Set(['arcSpawn', 'witnessAux', 'npcProfileGen']);
        for (const block of blocks) {
            if (nonAutomaticIds.has(block.id)) continue;
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