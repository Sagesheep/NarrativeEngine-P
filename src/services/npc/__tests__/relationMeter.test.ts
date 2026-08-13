import { describe, it, expect } from 'vitest';
import type { NPCEntry } from '../../types';
import { applyRelationTone, isRelationTone } from '../relationMeter';

const npc = (over: Partial<NPCEntry> = {}): NPCEntry => ({
    id: 'n', name: 'Test', aliases: '', appearance: '', faction: '', storyRelevance: '',
    disposition: '', status: '', goals: '', voice: '', personality: '', exampleOutput: '',
    affinity: 50, pcRelation: 0, relationMeter: 0, ...over,
} as NPCEntry);

// Fixed rng. friendly[5,12]: 5+floor(rng*8) → 0.99⇒+12, 0⇒+5.
// tense[-12,-5]: -12+floor(rng*8) → 0⇒-12, 0.99⇒-5.
// betrayal[-100,-50]: -100+floor(rng*51) → 0⇒-100, 0.99⇒-50.
const r = (v: number) => () => v;

describe('relationMeter — isRelationTone', () => {
    it('accepts the five labels and rejects others', () => {
        expect(isRelationTone('friendly')).toBe(true);
        expect(isRelationTone('bonding')).toBe(true);
        expect(isRelationTone('hostile')).toBe(false);
        expect(isRelationTone(2)).toBe(false);
    });
});

describe('relationMeter — ordinary accumulation', () => {
    it('friendly nudges the meter without flipping the band', () => {
        const patch = applyRelationTone(npc({ relationMeter: 0 }), 'friendly', r(0.99)); // +12
        expect(patch.pcRelation).toBeUndefined();
        expect(patch.relationMeter).toBe(12);
    });

    it('friendly flips the band when it crosses +100, carrying the remainder', () => {
        const patch = applyRelationTone(npc({ pcRelation: 0, relationMeter: 95 }), 'friendly', r(0.99)); // +12 → 107
        expect(patch.pcRelation).toBe(1);
        expect(patch.relationMeter).toBe(7); // 107 − 100 carried
    });

    it('neutral is a no-op', () => {
        expect(applyRelationTone(npc(), 'neutral', r(0.5))).toEqual({});
    });

    it('tense drops faster — only −50 needed to fall a band', () => {
        const patch = applyRelationTone(npc({ pcRelation: 0, relationMeter: -45 }), 'tense', r(0)); // −12 → −57
        expect(patch.pcRelation).toBe(-1);
        expect(patch.relationMeter).toBe(-7); // −57 + 50 carried
    });
});

describe('relationMeter — bonding (comrade) cap', () => {
    it('lifts a neutral NPC exactly one band, to Friendly', () => {
        const patch = applyRelationTone(npc({ pcRelation: 0, relationMeter: 0 }), 'bonding', r(0));
        expect(patch.pcRelation).toBe(1);
        expect(patch.relationMeter).toBeUndefined(); // 100 fully consumed → meter back to 0 (unchanged)
    });

    it('lifts only one band from distrustful (no instant jump to Friendly)', () => {
        const patch = applyRelationTone(npc({ pcRelation: -2, relationMeter: 0 }), 'bonding', r(0));
        expect(patch.pcRelation).toBe(-1); // −2 → −1, not all the way to +1
    });

    it('is a no-op once already at/above Friendly — devotion is earned, not bonded', () => {
        expect(applyRelationTone(npc({ pcRelation: 1 }), 'bonding', r(0))).toEqual({});
        expect(applyRelationTone(npc({ pcRelation: 3 }), 'bonding', r(0))).toEqual({});
    });
});

describe('relationMeter — betrayal (uncapped, fast)', () => {
    it('craters multiple bands instantly with no floor cap', () => {
        const patch = applyRelationTone(npc({ pcRelation: 2, relationMeter: 0 }), 'betrayal', r(0)); // −100
        expect(patch.pcRelation).toBe(0); // 2 → 1 → 0 (two −50 steps)
    });

    it('a devoted ally can be dropped toward enemy by betrayal', () => {
        const patch = applyRelationTone(npc({ pcRelation: 3, relationMeter: 0 }), 'betrayal', r(0)); // −100
        expect(patch.pcRelation).toBe(1); // 3 → 2 → 1
    });
});

describe('relationMeter — clamps & bounds', () => {
    it('does not promote past +3 and bounds the parked meter', () => {
        const patch = applyRelationTone(npc({ pcRelation: 3, relationMeter: 95 }), 'friendly', r(0.99)); // +12 → 107
        expect(patch.pcRelation).toBeUndefined(); // already MAX
        expect(patch.relationMeter).toBe(99);     // bounded to RISE_THRESHOLD − 1
    });

    it('does not demote past −3 and bounds the parked meter', () => {
        const patch = applyRelationTone(npc({ pcRelation: -3, relationMeter: 0 }), 'betrayal', r(0)); // −100
        expect(patch.pcRelation).toBeUndefined(); // already MIN
        expect(patch.relationMeter).toBe(-49);    // bounded to −(FALL_THRESHOLD − 1)
    });
});

describe('relationMeter — band fallback', () => {
    it('derives the starting band from legacy affinity when pcRelation is unset', () => {
        // affinity 70 → +1 band (Friendly); bonding should then be a no-op (already at cap)
        const n = npc({ pcRelation: undefined, affinity: 70 });
        expect(applyRelationTone(n, 'bonding', r(0))).toEqual({});
    });

    it('never mutates the input npc', () => {
        const n = npc({ relationMeter: 10 });
        applyRelationTone(n, 'friendly', r(0.99));
        expect(n.relationMeter).toBe(10);
    });
});

describe('relationMeter — relationship memory freeze', () => {
    it('does not write pcRelation or relationMeter when the stance feature is enabled', () => {
        expect(applyRelationTone(npc({ pcRelation: 2, relationMeter: 40 }), 'betrayal', r(0), true)).toEqual({});
    });
});
