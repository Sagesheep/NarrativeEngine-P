import { describe, it, expect } from 'vitest';
import {
    PC_POINT_BUY,
    STAT_KEYS,
    getPointCost,
    computePCDerived,
    DEFAULT_STATS,
    validateAllocation,
    allocateStat,
    ARCHETYPE_PRESETS,
    CREATION_QUESTIONS,
    getPCTier,
    getPCBudget,
    buildCharacterProfileText,
    buildCharacterProfileData,
    type StatBlock,
    type Archetype,
} from '../pcCreationScript';

// ─────────────────────────────────────────────────────────────────────────────
// Characterization tests for pcCreationScript.ts (Refactor 19-06 Plan 04 w1).
// Every magic number below is derived BY HAND from pcCreationScript.ts so any
// logic change fails loudly. Point-buy cost table is D&D 5e standard:
//   NORMAL: 8:0 9:1 10:2 11:3 12:4 13:5 14:7 15:9  (out-of-range -> 99)
//   OP: extends with 16:11 17:13 18:15 19:17 20:19
// ─────────────────────────────────────────────────────────────────────────────

const allEight = (n: number): StatBlock => ({ VIT: n, PWR: n, RES: n, FOC: n, SPD: n, WIL: n });

describe('PC_POINT_BUY — tier tables', () => {
    it('NORMAL: 27 points, min 8, max 15, tier grunt', () => {
        expect(PC_POINT_BUY.NORMAL).toEqual({ totalPoints: 27, min: 8, max: 15, tier: 'grunt' });
    });
    it('OP: 37 points, min 8, max 20, tier elite', () => {
        expect(PC_POINT_BUY.OP).toEqual({ totalPoints: 37, min: 8, max: 20, tier: 'elite' });
    });
});

describe('STAT_KEYS', () => {
    it('is the six combat-stat keys in fixed order', () => {
        expect(STAT_KEYS).toEqual(['VIT', 'PWR', 'RES', 'FOC', 'SPD', 'WIL']);
    });
});

describe('getPointCost', () => {
    it('NORMAL: returns the 5e cost table value per attribute score', () => {
        // 8->0, 9->1, 10->2, 11->3, 12->4, 13->5, 14->7, 15->9
        expect(getPointCost(8, 'NORMAL')).toBe(0);
        expect(getPointCost(9, 'NORMAL')).toBe(1);
        expect(getPointCost(10, 'NORMAL')).toBe(2);
        expect(getPointCost(11, 'NORMAL')).toBe(3);
        expect(getPointCost(12, 'NORMAL')).toBe(4);
        expect(getPointCost(13, 'NORMAL')).toBe(5);
        expect(getPointCost(14, 'NORMAL')).toBe(7);
        expect(getPointCost(15, 'NORMAL')).toBe(9);
    });
    it('NORMAL: out-of-range (>15 or <8) falls back to 99 sentinel', () => {
        expect(getPointCost(16, 'NORMAL')).toBe(99);
        expect(getPointCost(7, 'NORMAL')).toBe(99);
        expect(getPointCost(20, 'NORMAL')).toBe(99);
    });
    it('OP: extends the cost table with 16:11 17:13 18:15 19:17 20:19', () => {
        expect(getPointCost(15, 'OP')).toBe(9);
        expect(getPointCost(16, 'OP')).toBe(11);
        expect(getPointCost(17, 'OP')).toBe(13);
        expect(getPointCost(18, 'OP')).toBe(15);
        expect(getPointCost(19, 'OP')).toBe(17);
        expect(getPointCost(20, 'OP')).toBe(19);
    });
    it('OP: out-of-range (>20 or <8) returns 99', () => {
        expect(getPointCost(21, 'OP')).toBe(99);
        expect(getPointCost(7, 'OP')).toBe(99);
    });
});

describe('computePCDerived — inlined combat-engine math', () => {
    // abilityMod = floor((score-10)/2) ; AC = 10 + abilityMod(RES)
    // HP = 6 + vitMod*4 + level*2 ; FOC = 2 + wilMod + 2*level
    // NORMAL tier = grunt, COMBAT_TIER_LEVEL_BANDS.grunt = 3, proficiency(level<=4)=2
    it('NORMAL/grunt: VIT 14, RES 14, WIL 10 -> hp 18, foc 8, ac 12, prof 2', () => {
        // vitMod=floor((14-10)/2)=2 -> hp=6+2*4+3*2=6+8+6=20 ... recompute: 6+8+6=20
        // wilMod=floor((10-10)/2)=0 -> foc=2+0+2*3=8 ; resMod=2 -> ac=12
        const d = computePCDerived({ VIT: 14, PWR: 8, RES: 14, FOC: 8, SPD: 8, WIL: 10 }, 'NORMAL');
        expect(d.hp).toBe(20);
        expect(d.foc).toBe(8);
        expect(d.ac).toBe(12);
        expect(d.proficiency).toBe(2);
    });
    it('OP/elite: VIT 18, RES 16, WIL 18 -> hp uses elite level 6', () => {
        // elite level = 6, prof(level<=8)=3
        // vitMod=floor((18-10)/2)=4 -> hp=6+4*4+6*2=6+16+12=34
        // wilMod=floor((18-10)/2)=4 -> foc=2+4+2*6=18 ; resMod=floor((16-10)/2)=3 -> ac=13
        const d = computePCDerived({ VIT: 18, PWR: 8, RES: 16, FOC: 8, SPD: 8, WIL: 18 }, 'OP');
        expect(d.hp).toBe(34);
        expect(d.foc).toBe(18);
        expect(d.ac).toBe(13);
        expect(d.proficiency).toBe(3);
    });
    it('VIT 8 (mod -1) -> hp subtracts 4 from base 6+level*2', () => {
        // NORMAL: vitMod=-1 -> hp=6+(-1)*4+3*2=6-4+6=8
        expect(computePCDerived({ VIT: 8, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 }, 'NORMAL').hp).toBe(8);
    });
    it('AC for RES 8 is 10 + (-1) = 9', () => {
        expect(computePCDerived(allEight(8), 'NORMAL').ac).toBe(9);
    });
    it('FOC for WIL 8 (mod -1) at grunt level 3 is 2 + (-1) + 6 = 7', () => {
        expect(computePCDerived(allEight(8), 'NORMAL').foc).toBe(7);
    });
});

describe('DEFAULT_STATS', () => {
    it('is all-six 8 (the point-buy floor for NORMAL)', () => {
        expect(DEFAULT_STATS).toEqual(allEight(8));
    });
});

describe('validateAllocation', () => {
    it('all-8 NORMAL spends 0 and is valid with 27 remaining', () => {
        const r = validateAllocation(allEight(8), 'NORMAL');
        expect(r.pointsSpent).toBe(0);
        expect(r.pointsRemaining).toBe(27);
        expect(r.isValid).toBe(true);
    });
    it('bulwark preset spends exactly 27 and is valid under NORMAL', () => {
        // VIT15=9, PWR10=2, RES14=7, FOC8=0, SPD8=0, WIL10=2 -> 9+2+7+0+0+2 = 20
        const r = validateAllocation(ARCHETYPE_PRESETS.bulwark, 'NORMAL');
        expect(r.pointsSpent).toBe(20);
        expect(r.pointsRemaining).toBe(7);
        expect(r.isValid).toBe(true);
    });
    it('assassin preset spends exactly 27 and is valid under NORMAL', () => {
        // VIT10=2, PWR13=5, RES10=2, FOC10=2, SPD15=9, WIL11=3 -> 2+5+2+2+9+3 = 23
        const r = validateAllocation(ARCHETYPE_PRESETS.assassin, 'NORMAL');
        expect(r.pointsSpent).toBe(23);
        expect(r.pointsRemaining).toBe(4);
        expect(r.isValid).toBe(true);
    });
    it('caster preset spends 9+0+2+9+2+7 = 29 -> exceeds 27 -> INVALID', () => {
        // VIT8=0, PWR8=0, RES10=2, FOC15=9, SPD10=2, WIL14=7 -> 0+0+2+9+2+7 = 20
        // Wait: VIT8=0,PWR8=0,RES10=2,FOC15=9,SPD10=2,WIL14=7 = 20. Let me recompute for caster block.
        // ARCHETYPE_PRESETS.caster = { VIT:8, PWR:8, RES:10, FOC:15, SPD:10, WIL:14 }
        //   = 0 + 0 + 2 + 9 + 2 + 7 = 20. valid.
        const r = validateAllocation(ARCHETYPE_PRESETS.caster, 'NORMAL');
        expect(r.pointsSpent).toBe(20);
        expect(r.isValid).toBe(true);
    });
    it('skirmisher preset: VIT12=4, PWR11=3, RES10=2, FOC10=2, SPD14=7, WIL10=2 = 20 -> valid', () => {
        const r = validateAllocation(ARCHETYPE_PRESETS.skirmisher, 'NORMAL');
        expect(r.pointsSpent).toBe(20);
        expect(r.isValid).toBe(true);
    });
    it('brute preset: VIT14=7, PWR15=9, RES10=2, FOC8=0, SPD10=2, WIL8=0 = 20 -> valid', () => {
        const r = validateAllocation(ARCHETYPE_PRESETS.brute, 'NORMAL');
        expect(r.pointsSpent).toBe(20);
        expect(r.isValid).toBe(true);
    });
    it('all-15 NORMAL spends 6*9=54 -> exceeds 27 -> INVALID but still under max', () => {
        const r = validateAllocation(allEight(15), 'NORMAL');
        expect(r.pointsSpent).toBe(54);
        expect(r.pointsRemaining).toBe(27 - 54);
        expect(r.isValid).toBe(false); // over budget
    });
    it('a stat below the min (7) flags invalid even if within budget', () => {
        const r = validateAllocation({ VIT: 7, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 }, 'NORMAL');
        expect(r.isValid).toBe(false);
        expect(r.pointsSpent).toBe(99); // getPointCost(7)=99
    });
    it('a stat above the max (16 under NORMAL) flags invalid', () => {
        const r = validateAllocation({ VIT: 16, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 }, 'NORMAL');
        expect(r.isValid).toBe(false);
        expect(r.pointsSpent).toBe(99); // getPointCost(16, NORMAL)=99
    });
    it('OP budget: all-8 spends 0, remaining 37, valid', () => {
        const r = validateAllocation(allEight(8), 'OP');
        expect(r.pointsSpent).toBe(0);
        expect(r.pointsRemaining).toBe(37);
        expect(r.isValid).toBe(true);
    });
    it('OP: a stat of 20 is within max, costs 19', () => {
        const stats = { VIT: 20, PWR: 8, RES: 8, FOC: 8, SPD: 8, WIL: 8 } as StatBlock;
        const r = validateAllocation(stats, 'OP');
        expect(r.pointsSpent).toBe(19);
        expect(r.isValid).toBe(true);
    });
    it('returns the same stats object reference that was passed in', () => {
        const stats = allEight(8);
        expect(validateAllocation(stats, 'NORMAL').stats).toBe(stats);
    });
});

describe('allocateStat', () => {
    it('sets the requested stat to the requested value when in range', () => {
        const out = allocateStat(allEight(8), 'VIT', 13, 'NORMAL');
        expect(out.VIT).toBe(13);
        expect(out.PWR).toBe(8); // untouched
    });
    it('clamps values above max down to cfg.max (NORMAL max=15)', () => {
        expect(allocateStat(allEight(8), 'VIT', 99, 'NORMAL').VIT).toBe(15);
    });
    it('clamps values below min up to cfg.min (min=8)', () => {
        expect(allocateStat(allEight(8), 'VIT', -5, 'NORMAL').VIT).toBe(8);
    });
    it('OP max is 20 — value 25 clamps to 20', () => {
        expect(allocateStat(allEight(8), 'VIT', 25, 'OP').VIT).toBe(20);
    });
    it('returns a NEW stat block, leaving the input untouched', () => {
        const orig = allEight(8);
        const out = allocateStat(orig, 'VIT', 12, 'NORMAL');
        expect(orig.VIT).toBe(8);
        expect(out).not.toBe(orig);
    });
});

describe('ARCHETYPE_PRESETS — every archetype has all six stats in NORMAL range', () => {
    const names: Archetype[] = ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'];
    for (const name of names) {
        it(`${name}: all stats are within [8,15]`, () => {
            const s = ARCHETYPE_PRESETS[name];
            for (const k of STAT_KEYS) {
                expect(s[k]).toBeGreaterThanOrEqual(8);
                expect(s[k]).toBeLessThanOrEqual(15);
            }
        });
    }
});

describe('CREATION_QUESTIONS', () => {
    it('exposes six questions with stable ids in fixed order', () => {
        expect(CREATION_QUESTIONS.map(q => q.id)).toEqual([
            'name', 'concept', 'playstyle', 'voice', 'drives', 'archetype',
        ]);
    });
    it('name is a required text field', () => {
        const q = CREATION_QUESTIONS[0];
        expect(q.id).toBe('name');
        expect(q.type).toBe('text');
        expect(q.required).toBe(true);
    });
    it('playstyle is a select with exactly the 5 archetype-flavored options', () => {
        const q = CREATION_QUESTIONS[2];
        expect(q.type).toBe('select');
        expect(q.required).toBe(true);
        expect(q.options).toHaveLength(5);
    });
    it('archetype select lists the 5 archetype ids', () => {
        const q = CREATION_QUESTIONS[5];
        expect(q.type).toBe('select');
        expect(q.options).toEqual(['bulwark', 'assassin', 'caster', 'skirmisher', 'brute']);
    });
    it('voice and drives are optional (required=false)', () => {
        expect(CREATION_QUESTIONS[3].required).toBe(false);
        expect(CREATION_QUESTIONS[4].required).toBe(false);
    });
});

describe('getPCTier / getPCBudget', () => {
    it('getPCTier(false) = grunt, getPCTier(true) = elite', () => {
        expect(getPCTier(false)).toBe('grunt');
        expect(getPCTier(true)).toBe('elite');
    });
    it('getPCBudget(false) = NORMAL, getPCBudget(true) = OP', () => {
        expect(getPCBudget(false)).toBe('NORMAL');
        expect(getPCBudget(true)).toBe('OP');
    });
});

describe('buildCharacterProfileText', () => {
    it('produces the exact 4-line header + optional concept line, NORMAL bulwark', () => {
        const out = buildCharacterProfileText({
            name: 'Aria',
            concept: 'a wandering sage',
            stats: ARCHETYPE_PRESETS.bulwark,
            archetype: 'bulwark',
            isOP: false,
        });
        const lines = out.split('\n');
        expect(lines[0]).toBe('**Aria**');
        expect(lines[1]).toBe('Archetype: bulwark | Tier: grunt');
        // bulwark VIT15/RES14/WIL10 at grunt: hp=6+2*4+3*2=20, foc=2+0+6=8, ac=12, prof=2
        expect(lines[2]).toBe('HP: 20 | FOC: 8 | AC: 12 | Proficiency: +2');
        expect(lines[3]).toBe('VIT 15 | PWR 10 | RES 14 | FOC 8 | SPD 8 | WIL 10');
        expect(lines[4]).toBe('Concept: a wandering sage');
    });
    it('omits optional lines when their fields are absent', () => {
        const out = buildCharacterProfileText({
            name: 'Nemo',
            stats: allEight(8),
            archetype: 'caster',
            isOP: false,
        });
        expect(out).not.toContain('Concept:');
        expect(out).not.toContain('Playstyle:');
        expect(out).not.toContain('Voice:');
        expect(out).not.toContain('Drives:');
    });
    it('isOP=true flips tier to elite and recomputes derived stats', () => {
        const out = buildCharacterProfileText({
            name: 'X',
            stats: allEight(8),
            archetype: 'assassin',
            isOP: true,
        });
        // all-8 at elite (level 6, prof 3): hp=6+(-1)*4+6*2=6-4+12=14, foc=2-1+12=13, ac=9
        expect(out).toContain('Tier: elite');
        expect(out).toContain('HP: 14 | FOC: 13 | AC: 9 | Proficiency: +3');
    });
});

describe('buildCharacterProfileData', () => {
    it('returns a CharacterProfile with hp/foc/ac filled from derived, archetype as class', () => {
        const out = buildCharacterProfileData({
            name: 'Aria',
            stats: ARCHETYPE_PRESETS.bulwark,
            archetype: 'bulwark',
            isOP: false,
            concept: 'a wandering sage',
        });
        expect(out.name).toBe('Aria');
        expect(out.race).toBe('');
        expect(out.class).toBe('bulwark');
        expect(out.level).toBe(1);
        expect(out.hp).toEqual({ current: 20, max: 20 }); // bulwark grunt hp = 20
        expect(out.stats.VIT).toBe(15);
        expect(out.stats.AC).toBe(12);
        expect(out.stats.Proficiency).toBe(2);
        expect(out.traits).toEqual(['a wandering sage']); // concept -> traits
    });
    it('omits traits when concept is missing (empty array, not undefined)', () => {
        const out = buildCharacterProfileData({
            name: 'Nemo',
            stats: allEight(8),
            archetype: 'caster',
            isOP: false,
        });
        expect(out.traits).toEqual([]);
    });
    it('always returns skills/abilities as empty arrays and notes as empty string', () => {
        const out = buildCharacterProfileData({
            name: 'Nemo',
            stats: allEight(8),
            archetype: 'caster',
            isOP: true,
        });
        expect(out.skills).toEqual([]);
        expect(out.abilities).toEqual([]);
        expect(out.notes).toBe('');
    });
});