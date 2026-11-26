import { describe, it, expect } from 'vitest';
import { hexDelta } from './agencyDrift';
import type { PersonalityHex } from '../../../types';

describe('agencyDrift — hexDelta', () => {
    it('clamps at +3 ceiling: hexDelta(hex{boldness:3}, "boldness", +1) -> stays 3', () => {
        const hex: PersonalityHex = {
            drive: 0,
            diligence: 0,
            boldness: 3,
            warmth: 0,
            empathy: 0,
            composure: 0
        };
        const result = hexDelta(hex, 'boldness', 1);
        expect(result.boldness).toBe(3);
    });

    it('clamps at -3 floor: hexDelta(hex{composure:-3}, "composure", -1) -> stays -3', () => {
        const hex: PersonalityHex = {
            drive: 0,
            diligence: 0,
            boldness: 0,
            warmth: 0,
            empathy: 0,
            composure: -3
        };
        const result = hexDelta(hex, 'composure', -1);
        expect(result.composure).toBe(-3);
    });

    it('step cap: hexDelta(hex{drive:0}, "drive", +5) -> drive 1 (NOT 5)', () => {
        const hex: PersonalityHex = {
            drive: 0,
            diligence: 0,
            boldness: 0,
            warmth: 0,
            empathy: 0,
            composure: 0
        };
        const result = hexDelta(hex, 'drive', 5);
        expect(result.drive).toBe(1);
    });

    it('by:0 -> equal-valued new object', () => {
        const hex: PersonalityHex = {
            drive: 1,
            diligence: -1,
            boldness: 2,
            warmth: -2,
            empathy: 0,
            composure: 3
        };
        const result = hexDelta(hex, 'drive', 0);
        expect(result).toEqual(hex);
        expect(result).not.toBe(hex); // should be a new object reference
    });

    it('immutability: input object is unchanged after the call (assert input.boldness unchanged)', () => {
        const hex: PersonalityHex = {
            drive: 0,
            diligence: 0,
            boldness: 1,
            warmth: 0,
            empathy: 0,
            composure: 0
        };
        const result = hexDelta(hex, 'boldness', 1);
        expect(hex.boldness).toBe(1);
        expect(result.boldness).toBe(2);
    });

    it('other axes untouched: only the named axis differs', () => {
        const hex: PersonalityHex = {
            drive: 1,
            diligence: 2,
            boldness: -1,
            warmth: 0,
            empathy: -2,
            composure: 3
        };
        const result = hexDelta(hex, 'boldness', 1);
        expect(result).toEqual({
            drive: 1,
            diligence: 2,
            boldness: 0,
            warmth: 0,
            empathy: -2,
            composure: 3
        });
    });
});
