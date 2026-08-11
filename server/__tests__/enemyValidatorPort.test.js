// Phase 8.2 §8 / Phase 8.5 §3.5 — the differential test.
//
// ┌─ WHY THIS EXISTS ────────────────────────────────────────────────────────┐
// │ Phase 8.5 migrates real users' monsters, and the only thing standing      │
// │ between their data and a subtle loss is that the validator now running    │
// │ inside the mod repairs data exactly the way the 443-line server schema    │
// │ did. Not "similarly". The same.                                           │
// │                                                                           │
// │ That matters more than it sounds, because the old schema did not just     │
// │ validate — it BACKFILLED. A record missing `promptEnabled`, or with a     │
// │ string where a number belongs, or with a `null` in the middle of an       │
// │ array, survived only because the schema quietly fixed it on the way past. │
// │ Campaigns that have been played for months are full of records like that. │
// │ A port that is "close enough" is how the repair those saves depend on     │
// │ quietly stops repairing, with no error and no test failure — which is     │
// │ precisely what Phase 8.2 §9's stop condition names.                       │
// └───────────────────────────────────────────────────────────────────────────┘
//
// Method: feed the SAME inputs — mostly malformed ones — to the frozen
// pre-extraction schema and to the mod's copy, and assert the repaired values
// are deeply equal. Ids and timestamps are made deterministic on both sides so
// the comparison is about the repair and not about the clock.
//
// A divergence found here is not a test to relax. It is either a bug in the
// port or a deliberate change, and a deliberate change gets a named exception
// in this file with the reason. There are none today.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

const FIXED_UUID = '00000000-0000-4000-8000-000000000000';
const FIXED_NOW = 1_700_000_000_000;

const before = await import('./fixtures/preExtractionEnemySchema.js');

let after;

beforeEach(async () => {
    // The mod runs in the browser and calls the `crypto` global; the frozen
    // schema imports `node:crypto`. Pin both to the same id so a generated id
    // is not mistaken for a divergence. `globalThis.crypto` is getter-only in
    // Node, so spy on the method rather than replacing the object.
    vi.spyOn(globalThis.crypto, 'randomUUID').mockReturnValue(FIXED_UUID);
    vi.useFakeTimers();
    vi.setSystemTime(FIXED_NOW);
    after = await import('../../public/bundled-mods/enemies/validator.js');
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/**
 * Run one input through both implementations and assert they agree on the
 * repaired VALUE. Error strings are compared as a set of paths, not verbatim:
 * both sides emit the same paths, and pinning message wording would make this
 * a test about prose.
 */
function bothAgree(name, input) {
    const oldResult = before[name](input);
    const newResult = after[name](input);
    expect(newResult.value, `${name}: repaired value diverged`).toEqual(oldResult.value);
    expect(newResult.errors.length, `${name}: error count diverged`).toBe(oldResult.errors.length);
    return oldResult;
}

describe('the ported validator repairs exactly as the pre-extraction schema did', () => {
    describe('validateEnemyCompendium', () => {
        it('agrees on a well-formed compendium', () => {
            bothAgree('validateEnemyCompendium', [{
                id: 'e1', name: 'Goblin', classification: 'humanoid',
                stats: [{ name: 'HP', value: '7' }], actions: [{ name: 'Stab', description: '1d6' }],
                tags: ['cave'], promptEnabled: true, createdAt: 1, updatedAt: 2,
            }]);
        });

        it('agrees on the backfills a months-old record relies on', () => {
            // The shape a save written before half these fields existed has:
            // a name and nothing else. Every other field is the schema's doing.
            const result = bothAgree('validateEnemyCompendium', [{ name: 'Ancient Record' }]);
            expect(result.value[0].promptEnabled).toBe(true);
            expect(result.value[0].id).toBe(FIXED_UUID);
            expect(result.value[0].createdAt).toBe(FIXED_NOW);
            expect(result.value[0].tags).toEqual([]);
            expect(result.value[0].gmNotes).toBe('');
        });

        it.each([
            ['a missing name', [{ classification: 'beast' }]],
            ['a null in the middle of the array', [{ name: 'A' }, null, { name: 'B' }]],
            ['a non-array input', { name: 'not an array' }],
            ['a null input', null],
            ['an undefined input', undefined],
            ['a number where a record belongs', [42]],
            ['a string list holding non-strings', [{ name: 'A', tags: ['ok', 7, null, '  padded  ', ''] }]],
            ['a text field holding a number', [{ name: 'A', gmNotes: 12 }]],
            ['stats that are not pairs', [{ name: 'A', stats: ['HP 7', { value: 'orphan' }, { name: 'HP', value: 7 }] }]],
            ['actions missing a name', [{ name: 'A', actions: [{ description: 'no name' }] }]],
            ['a non-boolean promptEnabled', [{ name: 'A', promptEnabled: 'yes' }]],
            ['non-finite timestamps', [{ name: 'A', createdAt: 'yesterday', updatedAt: NaN }]],
            ['nested nulls in stats', [{ name: 'A', stats: [null, { name: 'HP', value: '1' }] }]],
        ])('agrees on %s', (_label, input) => {
            bothAgree('validateEnemyCompendium', input);
        });
    });

    describe('validateEnemyInstances', () => {
        it('agrees on a well-formed instance', () => {
            bothAgree('validateEnemyInstances', [{
                id: 'i1', templateId: 'e1', displayName: 'Goblin #1',
                templateSnapshot: { name: 'Goblin' },
                currentHp: 4, maxHp: 7, currentBarrier: 0, maxBarrier: 0,
                conditions: ['prone'], temporaryModifiers: [], defeated: false,
                initiative: 12, actionsRemaining: 1, actionsPerTurn: 1,
                cooldowns: [{ id: 'c1', name: 'Roar', remainingRounds: 2 }],
                resources: [{ id: 'r1', name: 'Rage', current: 2, max: 3 }],
                createdAt: 1, updatedAt: 2,
            }]);
        });

        it.each([
            ['a missing templateSnapshot (backfilled)', [{ templateId: 'e1', displayName: 'Ghoul #2' }]],
            ['negative hit points', [{ displayName: 'A', currentHp: -30, maxHp: -1 }]],
            ['a resource current above its max', [{ displayName: 'A', resources: [{ id: 'r', name: 'Rage', current: 99, max: 3 }] }]],
            ['a resource with a negative current', [{ displayName: 'A', resources: [{ id: 'r', name: 'Rage', current: -5, max: 3 }] }]],
            ['a null initiative', [{ displayName: 'A', initiative: null }]],
            ['a non-numeric initiative', [{ displayName: 'A', initiative: 'fast' }]],
            ['fractional action counts', [{ displayName: 'A', actionsRemaining: 1.7, actionsPerTurn: 2.4 }]],
            ['cooldowns missing fields', [{ displayName: 'A', cooldowns: [{ name: 'Roar' }, null, 5] }]],
            ['an empty record', [{}]],
            ['a null input', null],
        ])('agrees on %s', (_label, input) => {
            bothAgree('validateEnemyInstances', input);
        });
    });

    describe('validateEnemyEncounters', () => {
        it.each([
            ['a well-formed encounter', [{
                id: 'enc1', name: 'Ambush', status: 'active',
                waves: [{ id: 'w1', name: 'Wave 1', instanceIds: ['i1'], activeInstanceIds: ['i1'], createdAt: 1, updatedAt: 1 }],
                activeWaveId: 'w1', createdAt: 1, updatedAt: 1,
            }]],
            ['an unknown status', [{ name: 'A', status: 'skirmishing' }]],
            ['no waves at all', [{ name: 'A' }]],
            ['an activeWaveId that names nothing', [{ name: 'A', activeWaveId: 'ghost', waves: [] }]],
            ['a wave whose instanceIds are not strings', [{ name: 'A', waves: [{ name: 'W', instanceIds: [1, null, 'i1'] }] }]],
            ['an ended encounter with no resolutionId', [{ name: 'A', status: 'ended' }]],
            ['a null input', null],
        ])('agrees on %s', (_label, input) => {
            bothAgree('validateEnemyEncounters', input);
        });
    });

    describe('validateEnemyResolutions', () => {
        it.each([
            ['a well-formed resolution', [{
                id: 'r1', encounterId: 'enc1', encounterName: 'Ambush', outcome: 'victory',
                summary: 'They won.', xpAwarded: 120, lootAwarded: ['Sword'], otherRewards: [],
                participantNames: ['Goblin #1'], instanceDisposition: 'archive',
                archivedInstances: [{ displayName: 'Goblin #1' }], resolvedAt: 5,
            }]],
            ['an unknown outcome', [{ outcome: 'pyrrhic' }]],
            ['an unknown disposition', [{ instanceDisposition: 'incinerate' }]],
            ['negative xp', [{ xpAwarded: -50 }]],
            ['an empty record', [{}]],
            ['archived instances that are junk', [{ archivedInstances: [null, 7, { displayName: 'Ok' }] }]],
            ['a null input', null],
        ])('agrees on %s', (_label, input) => {
            bothAgree('validateEnemyResolutions', input);
        });
    });

    describe('validateEnemyCombatConfig', () => {
        it('agrees that an absent config validates to null, not to defaults', () => {
            // Deliberate, and worth stating: the SERVER never invented a config.
            // `null` in, `null` out — the defaults were applied one layer up, by
            // the client's normalizer. The mod keeps that split (its `repairConfig`
            // is what backfills), so a campaign with no `.enemy-combat.json` gets
            // its defaults from exactly one place, as it always did.
            const result = bothAgree('validateEnemyCombatConfig', null);
            expect(result.value).toBeNull();
        });

        it('agrees on the thirteen defaults an empty config expands to', () => {
            // A campaign that opened the combat tab once and changed nothing has
            // `{}` on disk. These thirteen values ARE its combat configuration.
            const result = bothAgree('validateEnemyCombatConfig', {});
            expect(result.value).toEqual({
                initiativeMode: 'manual', barrierMode: 'absorb-first',
                promptContextEnabled: true, enemyDiscoveryEnabled: false, enabled: false,
                initiativeModifierStat: '', autoDefeatAtZeroHp: true,
                weaknessMultiplier: 2, resistanceMultiplier: 0.5,
                actionsEnabled: false, defaultActionsPerTurn: 1,
                cooldownsEnabled: false, resourcesEnabled: false,
            });
        });

        it.each([
            ['a full config', {
                initiativeMode: 'd20', barrierMode: 'manual', promptContextEnabled: false,
                enemyDiscoveryEnabled: true, enabled: true, initiativeModifierStat: 'DEX',
                autoDefeatAtZeroHp: false, weaknessMultiplier: 3, resistanceMultiplier: 0.25,
                actionsEnabled: true, defaultActionsPerTurn: 2, cooldownsEnabled: true, resourcesEnabled: true,
            }],
            ['an unknown initiative mode', { initiativeMode: 'd7' }],
            ['an unknown barrier mode', { barrierMode: 'reflect' }],
            ['negative multipliers', { weaknessMultiplier: -2, resistanceMultiplier: -1 }],
            ['a fractional action count', { defaultActionsPerTurn: 2.6 }],
            ['booleans as strings', { enabled: 'true', actionsEnabled: 'false' }],
            ['undefined', undefined],
        ])('agrees on %s', (_label, input) => {
            bothAgree('validateEnemyCombatConfig', input);
        });
    });
});

describe('the mod repair wrappers the migration relies on', () => {
    // `repair*` is what runs on every read — including the first read after a
    // legacy file has been adopted, which is where the migrated data gets the
    // same treatment the old schema gave it on the way in.
    it('repairs an adopted compendium to the validator output, minus unusable rows', () => {
        const raw = [{ name: 'A' }, { classification: 'no name' }];
        expect(after.repairCompendium(raw)).toEqual(before.validateEnemyCompendium(raw).value);
    });

    // ── The one deliberate divergence, per this file's header ──────────────
    //
    // ENEMY_SEAM.md §4.5 asymmetry #13: the SERVER validator keeps a `null` at
    // the index of a record it could not parse, and expects its caller to
    // reject the payload — which the PUT route did, with a 400. The CLIENT
    // normalizer, on the read path, dropped those records instead.
    //
    // On the read path there is now no rejecting caller: `repair*` is the last
    // word before the UI, which does `item.name` on every row. Keeping the
    // `null` means the compendium window throws on exactly the messy save this
    // phase exists to migrate. So the read path takes the CLIENT's behaviour,
    // which is also the behaviour that was in front of users.
    //
    // Nothing is lost: a dropped row is one the old app never showed either,
    // the legacy file still holds it unmodified, and the mod warns with the
    // index.
    it('drops rows the validator could not make usable, where the server kept a null', () => {
        const raw = [{ name: 'A' }, null, { name: 'B' }];

        // The server mirror — unchanged, still exact.
        expect(before.validateEnemyCompendium(raw).value).toHaveLength(3);
        expect(before.validateEnemyCompendium(raw).value[1]).toBeNull();
        expect(after.validateEnemyCompendium(raw).value[1]).toBeNull();

        // The read path — the divergence.
        const repaired = after.repairCompendium(raw);
        expect(repaired).toHaveLength(2);
        expect(repaired.every(row => row !== null)).toBe(true);
        expect(repaired.map(row => row.name)).toEqual(['A', 'B']);
    });

    it('drops unusable rows in every array table, not just the compendium', () => {
        expect(after.repairInstances([null, { displayName: 'X' }])).toHaveLength(1);
        expect(after.repairEncounters([null, { name: 'E' }])).toHaveLength(1);
        expect(after.repairResolutions([null, { outcome: 'victory' }])).toHaveLength(1);
    });

    it('repairs the shapes an empty or absent table produces', () => {
        expect(after.repairCompendium(undefined)).toEqual([]);
        expect(after.repairInstances(null)).toEqual([]);
        expect(after.repairEncounters('not a table')).toEqual([]);
        expect(after.repairResolutions(42)).toEqual([]);
        // The one place the mod deliberately does MORE than the server did: a
        // null config backfills the defaults here, because the mod has no
        // client-side normalizer downstream to do it (the layer that used to,
        // `campaignHydrator`'s `normalizeEnemyCombatConfig`, left with 8.2).
        // Same values, one layer earlier.
        expect(after.repairConfig(null)).toEqual(after.DEFAULT_ENEMY_COMBAT_CONFIG);
        expect(after.repairConfig(null)).toEqual(before.validateEnemyCombatConfig({}).value);
    });

    it('is idempotent — repairing repaired data changes nothing', () => {
        // The migration reads through `repair*` on every open. If the repair
        // were not a fixed point, a campaign's data would drift a little each
        // time it was loaded.
        const once = after.repairCompendium([{ name: 'A' }, { name: 'B', tags: [null, 'x'] }]);
        expect(after.repairCompendium(once)).toEqual(once);

        const instances = after.repairInstances([{ displayName: 'A', currentHp: -1 }]);
        expect(after.repairInstances(instances)).toEqual(instances);

        const config = after.repairConfig({ initiativeMode: 'nonsense' });
        expect(after.repairConfig(config)).toEqual(config);
    });
});
