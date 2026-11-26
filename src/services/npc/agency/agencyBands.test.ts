import { describe, it, expect } from 'vitest';
import { relationBand, hexBand, describeHex, affinityToPcRelation } from './agencyBands';

describe('agencyBands', () => {
    describe('relationBand', () => {
        it('returns correct words for valid range -3..+3', () => {
            expect(relationBand(-3)).toBe('Arch-enemy');
            expect(relationBand(-2)).toBe('Hostile');
            expect(relationBand(-1)).toBe('Cold');
            expect(relationBand(0)).toBe('Neutral');
            expect(relationBand(1)).toBe('Friendly');
            expect(relationBand(2)).toBe('Close');
            expect(relationBand(3)).toBe('Devoted');
        });

        it('clamps out of range values', () => {
            expect(relationBand(-5)).toBe('Arch-enemy');
            expect(relationBand(9)).toBe('Devoted');
        });
    });

    describe('hexBand', () => {
        const axes = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'] as const;

        it('checks extremes and center against tables', () => {
            // drive: ['Listless', 'Apathetic', 'Idle', 'Steady', 'Motivated', 'Driven', 'Relentless']
            expect(hexBand('drive', -3)).toBe('Listless');
            expect(hexBand('drive', 0)).toBe('Steady');
            expect(hexBand('drive', 3)).toBe('Relentless');

            // diligence: ['Negligent', 'Lazy', 'Lax', 'Reliable', 'Diligent', 'Meticulous', 'Exacting']
            expect(hexBand('diligence', -3)).toBe('Negligent');
            expect(hexBand('diligence', 0)).toBe('Reliable');
            expect(hexBand('diligence', 3)).toBe('Exacting');

            // boldness: ['Timid', 'Cautious', 'Wary', 'Measured', 'Bold', 'Daring', 'Reckless']
            expect(hexBand('boldness', -3)).toBe('Timid');
            expect(hexBand('boldness', 0)).toBe('Measured');
            expect(hexBand('boldness', 3)).toBe('Reckless');

            // warmth: ['Frigid', 'Cold', 'Aloof', 'Even', 'Warm', 'Affable', 'Effusive']
            expect(hexBand('warmth', -3)).toBe('Frigid');
            expect(hexBand('warmth', 0)).toBe('Even');
            expect(hexBand('warmth', 3)).toBe('Effusive');

            // empathy: ['Callous', 'Hard', 'Detached', 'Fair', 'Kind', 'Compassionate', 'Selfless']
            expect(hexBand('empathy', -3)).toBe('Callous');
            expect(hexBand('empathy', 0)).toBe('Fair');
            expect(hexBand('empathy', 3)).toBe('Selfless');

            // composure: ['Volatile', 'Excitable', 'Tense', 'Calm', 'Composed', 'Serene', 'Unflappable']
            expect(hexBand('composure', -3)).toBe('Volatile');
            expect(hexBand('composure', 0)).toBe('Calm');
            expect(hexBand('composure', 3)).toBe('Unflappable');
        });

        it('clamps out of range values to nearest end', () => {
            for (const axis of axes) {
                expect(hexBand(axis, -10)).toBe(hexBand(axis, -3));
                expect(hexBand(axis, 10)).toBe(hexBand(axis, 3));
            }
        });
    });

    describe('describeHex', () => {
        it('returns a non-empty comma-joined string for a full hex object', () => {
            const hex = {
                drive: 1,
                diligence: -1,
                boldness: 2,
                warmth: -2,
                empathy: 0,
                composure: 3
            };
            const result = describeHex(hex);
            expect(result).toBeTruthy();
            expect(typeof result).toBe('string');
            expect(result.split(', ').length).toBe(6);
            expect(result).toBe('Motivated, Lax, Daring, Cold, Fair, Unflappable');
        });
    });

    describe('affinityToPcRelation', () => {
        it('maps affinity to pcRelation based on boundaries', () => {
            // <=15 -> -3
            expect(affinityToPcRelation(0)).toBe(-3);
            expect(affinityToPcRelation(15)).toBe(-3);

            // <=30 -> -2
            expect(affinityToPcRelation(16)).toBe(-2);
            expect(affinityToPcRelation(30)).toBe(-2);

            // <=45 -> -1
            expect(affinityToPcRelation(31)).toBe(-1);
            expect(affinityToPcRelation(45)).toBe(-1);

            // 46..55 -> 0
            expect(affinityToPcRelation(46)).toBe(0);
            expect(affinityToPcRelation(50)).toBe(0);
            expect(affinityToPcRelation(55)).toBe(0);

            // <=70 -> 1
            expect(affinityToPcRelation(56)).toBe(1);
            expect(affinityToPcRelation(70)).toBe(1);

            // <=85 -> 2
            expect(affinityToPcRelation(71)).toBe(2);
            expect(affinityToPcRelation(85)).toBe(2);

            // >85 -> 3
            expect(affinityToPcRelation(86)).toBe(3);
            expect(affinityToPcRelation(100)).toBe(3);
        });

        it('defaults NaN or non-finite affinity to Neutral (0)', () => {
            expect(affinityToPcRelation(NaN)).toBe(0);
            expect(affinityToPcRelation(Infinity)).toBe(0);
            expect(affinityToPcRelation(-Infinity)).toBe(0);
            // also test undefined (casted to any/number)
            expect(affinityToPcRelation(undefined as unknown as number)).toBe(0);
        });
    });
});
