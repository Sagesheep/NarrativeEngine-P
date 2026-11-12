import { describe, it, expect } from 'vitest';
import {
    ABILITY_KEYS, TIER_LEVEL, abilityMod, proficiencyForLevel,
    PC_POINT_BUY, DEFAULT_ABILITIES, ARCHETYPE_KEYS, ARCHETYPE_PRESETS, INVALID_POINT_COST,
    getPointCost, validateAllocation, allocateAbility,
    createDefaultSheet, deriveSheet, createRng,
} from '../index';
import type { AbilityScores, CombatSheet } from '../index';

const all = (n: number): AbilityScores => ({ STR: n, DEX: n, CON: n, INT: n, WIS: n, CHA: n });

describe('abilities', () => {
    it('lists the six D&D ability keys in order', () => {
        expect(ABILITY_KEYS).toEqual(['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA']);
    });

    it('computes modifiers as floor((score - 10) / 2)', () => {
        const table: Array<[number, number]> = [
            [1, -5], [3, -4], [7, -2], [8, -1], [9, -1], [10, 0], [11, 0],
            [12, 1], [13, 1], [14, 2], [15, 2], [16, 3], [18, 4], [20, 5], [30, 10],
        ];
        for (const [score, mod] of table) expect(abilityMod(score)).toBe(mod);
    });

    it('maps level to proficiency by 5e bands', () => {
        const table: Array<[number, number]> = [
            [1, 2], [4, 2], [5, 3], [8, 3], [9, 4], [12, 4], [13, 5], [16, 5], [17, 6], [20, 6],
        ];
        for (const [level, prof] of table) expect(proficiencyForLevel(level)).toBe(prof);
    });

    it('keeps the existing tier level bands', () => {
        expect(TIER_LEVEL).toEqual({ minion: 1, grunt: 3, elite: 6, boss: 10, legendary: 15 });
    });
});

describe('point buy', () => {
    it('keeps the NORMAL and OP budgets', () => {
        expect(PC_POINT_BUY.NORMAL).toEqual({ totalPoints: 27, min: 8, max: 15, tier: 'grunt' });
        expect(PC_POINT_BUY.OP).toEqual({ totalPoints: 37, min: 8, max: 20, tier: 'elite' });
    });

    it('uses the 5e cost table and an out-of-range sentinel', () => {
        expect([8, 9, 10, 11, 12, 13, 14, 15].map(v => getPointCost(v, 'NORMAL'))).toEqual([0, 1, 2, 3, 4, 5, 7, 9]);
        expect(getPointCost(16, 'NORMAL')).toBe(INVALID_POINT_COST);
        expect(getPointCost(7, 'NORMAL')).toBe(INVALID_POINT_COST);
        expect([16, 17, 18, 19, 20].map(v => getPointCost(v, 'OP'))).toEqual([11, 13, 15, 17, 19]);
        expect(getPointCost(21, 'OP')).toBe(INVALID_POINT_COST);
    });

    it('defaults every ability to 8', () => {
        expect(DEFAULT_ABILITIES).toEqual(all(8));
        const result = validateAllocation({ ...DEFAULT_ABILITIES }, 'NORMAL');
        expect(result).toMatchObject({ pointsSpent: 0, pointsRemaining: 27, isValid: true });
    });

    it('accepts an allocation that spends exactly the budget', () => {
        const result = validateAllocation({ STR: 15, DEX: 15, CON: 15, INT: 8, WIS: 8, CHA: 8 }, 'NORMAL');
        expect(result).toMatchObject({ pointsSpent: 27, pointsRemaining: 0, isValid: true });
    });

    it('rejects an allocation over budget', () => {
        const result = validateAllocation({ STR: 15, DEX: 15, CON: 15, INT: 9, WIS: 8, CHA: 8 }, 'NORMAL');
        expect(result.pointsSpent).toBe(28);
        expect(result.pointsRemaining).toBe(-1);
        expect(result.isValid).toBe(false);
    });

    it('rejects scores out of range', () => {
        expect(validateAllocation({ ...all(8), STR: 16 }, 'NORMAL').isValid).toBe(false);
        expect(validateAllocation({ ...all(8), STR: 7 }, 'NORMAL').isValid).toBe(false);
        expect(validateAllocation({ ...all(8), STR: 21 }, 'OP').isValid).toBe(false);
        expect(validateAllocation({ ...all(8), STR: 20 }, 'OP').isValid).toBe(true);
    });

    it('clamps a single allocation to the budget range without mutating', () => {
        const base = { ...DEFAULT_ABILITIES };
        expect(allocateAbility(base, 'STR', 99, 'NORMAL').STR).toBe(15);
        expect(allocateAbility(base, 'DEX', 1, 'NORMAL').DEX).toBe(8);
        expect(allocateAbility(base, 'WIS', 18, 'OP').WIS).toBe(18);
        expect(base).toEqual(all(8));
    });

    it('makes every archetype preset cost exactly 27 on the standard table', () => {
        expect(Object.keys(ARCHETYPE_PRESETS).sort()).toEqual([...ARCHETYPE_KEYS].sort());
        for (const archetype of ARCHETYPE_KEYS) {
            const result = validateAllocation({ ...ARCHETYPE_PRESETS[archetype] }, 'NORMAL');
            expect(result.pointsSpent, archetype).toBe(27);
            expect(result.isValid, archetype).toBe(true);
        }
    });
});

describe('sheet', () => {
    it('creates a default sheet flagged for allocation', () => {
        expect(createDefaultSheet('NORMAL')).toEqual({
            abilities: all(8), budget: 'NORMAL', level: 3, needsAllocation: true,
        });
        expect(createDefaultSheet('OP').level).toBe(6);
        expect(createDefaultSheet().budget).toBe('NORMAL');
    });

    it('derives HP, AC, proficiency and initiative by 5e rules', () => {
        const sheet: CombatSheet = {
            abilities: { STR: 10, DEX: 14, CON: 14, INT: 10, WIS: 10, CHA: 10 },
            budget: 'NORMAL', level: 3, needsAllocation: false,
        };
        expect(deriveSheet(sheet)).toEqual({ maxHp: 28, ac: 12, proficiency: 2, initiativeMod: 2 });
        expect(deriveSheet({ ...sheet, level: 1 }).maxHp).toBe(12);
        expect(deriveSheet({ ...sheet, level: 5 }).proficiency).toBe(3);
    });

    it('derives defaults with negative modifiers', () => {
        expect(deriveSheet(createDefaultSheet('NORMAL'))).toEqual({ maxHp: 19, ac: 9, proficiency: 2, initiativeMod: -1 });
    });

    it('never yields less than 1 HP per level', () => {
        const sheet: CombatSheet = { abilities: all(1), budget: 'NORMAL', level: 4, needsAllocation: false };
        expect(deriveSheet(sheet).maxHp).toBe(5 + 1 + 1 + 1);
        expect(deriveSheet({ ...sheet, level: 1, abilities: { ...all(1), CON: -20 } }).maxHp).toBe(1);
    });
});

describe('rng', () => {
    it('is deterministic for a seed', () => {
        const a = createRng(42);
        const b = createRng(42);
        const seqA = Array.from({ length: 10 }, () => a.next());
        const seqB = Array.from({ length: 10 }, () => b.next());
        expect(seqA).toEqual(seqB);
        for (const v of seqA) {
            expect(v).toBeGreaterThanOrEqual(0);
            expect(v).toBeLessThan(1);
        }
    });

    it('differs between seeds', () => {
        expect(createRng(1).next()).not.toBe(createRng(2).next());
    });

    it('resumes a sequence from seed and cursor', () => {
        const first = createRng(1234);
        const full = Array.from({ length: 8 }, () => first.roll(20));
        const partial = createRng(1234);
        partial.roll(20);
        partial.roll(20);
        partial.roll(20);
        expect(partial.cursor).toBe(3);
        const resumed = createRng(partial.seed, partial.cursor);
        expect(Array.from({ length: 5 }, () => resumed.roll(20))).toEqual(full.slice(3));
        expect(resumed.cursor).toBe(8);
    });

    it('keeps int and roll within bounds', () => {
        const rng = createRng(7);
        const seen = new Set<number>();
        for (let i = 0; i < 2000; i++) {
            const d6 = rng.roll(6);
            expect(d6).toBeGreaterThanOrEqual(1);
            expect(d6).toBeLessThanOrEqual(6);
            seen.add(d6);
            const v = rng.int(-3, 3);
            expect(v).toBeGreaterThanOrEqual(-3);
            expect(v).toBeLessThanOrEqual(3);
        }
        expect(seen.size).toBe(6);
        expect(rng.int(5, 5)).toBe(5);
    });
});
