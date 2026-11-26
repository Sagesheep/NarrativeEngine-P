import { describe, it, expect } from 'vitest';
import { resolveManualRoll } from '../engineRolls';
import { buildDefaultDiceSystem } from '../../../types';
import type { DiceSystemConfig, ManualRollRequest } from '../../../types';

const SYS: DiceSystemConfig = buildDefaultDiceSystem();
const d20 = SYS.dieTypes.find(d => d.name === 'd20')!;

describe('resolveManualRoll — generalized 3-gate', () => {
    it('1d20 none: rolls exactly one die and maps to a tier', () => {
        const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } };
        const r = resolveManualRoll(req, SYS);
        expect(r.rolls).toHaveLength(1);
        expect(r.faceValue).toBe(r.rolls[0]);
        expect(r.tier).toBeTypeOf('string');
        expect(r.tier!.length).toBeGreaterThan(0);
    });

    it('adv: rolls two dice and takes the higher', () => {
        const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'adv', count: 2, aggregation: 'pick_one' } };
        const r = resolveManualRoll(req, SYS);
        expect(r.rolls).toHaveLength(2);
        expect(r.faceValue).toBe(Math.max(r.rolls[0], r.rolls[1]));
    });

    it('disadv: rolls two dice and takes the lower', () => {
        const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'disadv', count: 2, aggregation: 'pick_one' } };
        const r = resolveManualRoll(req, SYS);
        expect(r.rolls).toHaveLength(2);
        expect(r.faceValue).toBe(Math.min(r.rolls[0], r.rolls[1]));
    });

    it('faceValue is always 1..20 for d20', () => {
        const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } };
        for (let i = 0; i < 50; i++) {
            const r = resolveManualRoll(req, SYS);
            expect(r.faceValue).toBeGreaterThanOrEqual(1);
            expect(r.faceValue).toBeLessThanOrEqual(20);
        }
    });

    it('maps a 20 to Narrative Boon (top band)', () => {
        const orig = Math.random;
        Math.random = () => 0.9999;
        try {
            const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } };
            const r = resolveManualRoll(req, SYS);
            expect(r.faceValue).toBe(20);
            expect(r.tier).toBe('Narrative Boon');
        } finally {
            Math.random = orig;
        }
    });

    it('maps a 1 to Catastrophe tier', () => {
        const orig = Math.random;
        Math.random = () => 0.0;
        try {
            const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } };
            const r = resolveManualRoll(req, SYS);
            expect(r.faceValue).toBe(1);
            expect(r.tier).toBe('Catastrophe');
        } finally {
            Math.random = orig;
        }
    });

    it('total_all: sums the dice and ignores modifier', () => {
        const req: ManualRollRequest = { dieTypeId: d20.id, rollDef: { modifier: 'adv', count: 3, aggregation: 'total_all' } };
        const orig = Math.random;
        Math.random = () => 0.5; // each die = 11
        try {
            const r = resolveManualRoll(req, SYS);
            expect(r.rolls).toHaveLength(3);
            expect(r.faceValue).toBe(33); // 11+11+11
        } finally {
            Math.random = orig;
        }
    });

    it('d6 die type: faceValue is 1..6', () => {
        const d6 = SYS.dieTypes.find(d => d.name === 'd6')!;
        const req: ManualRollRequest = { dieTypeId: d6.id, rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } };
        for (let i = 0; i < 50; i++) {
            const r = resolveManualRoll(req, SYS);
            expect(r.faceValue).toBeGreaterThanOrEqual(1);
            expect(r.faceValue).toBeLessThanOrEqual(6);
        }
    });

    it('d6 maps a 6 to Success (top band)', () => {
        const d6 = SYS.dieTypes.find(d => d.name === 'd6')!;
        const orig = Math.random;
        Math.random = () => 0.9999;
        try {
            const req: ManualRollRequest = { dieTypeId: d6.id, rollDef: { modifier: 'none', count: 1, aggregation: 'pick_one' } };
            const r = resolveManualRoll(req, SYS);
            expect(r.faceValue).toBe(6);
            expect(r.tier).toBe('Success');
        } finally {
            Math.random = orig;
        }
    });

    it('falls back gracefully when diceSystem is null (legacy string)', () => {
        const r = resolveManualRoll('1d20', null);
        expect(r.tier).toBeTypeOf('string');
        expect(r.faceValue).toBeGreaterThanOrEqual(1);
        expect(r.faceValue).toBeLessThanOrEqual(20);
    });

    it('legacy string adv mode still works', () => {
        const r = resolveManualRoll('adv', SYS);
        expect(r.rolls).toHaveLength(2);
        expect(r.faceValue).toBe(Math.max(r.rolls[0], r.rolls[1]));
        expect(r.detail).toBe('Advantage');
    });
});