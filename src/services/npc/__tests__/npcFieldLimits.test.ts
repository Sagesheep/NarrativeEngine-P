import { describe, it, expect } from 'vitest';
import {
    npcFieldLimits, npcBudgetFor, npcFieldRange, clipText, clipLine,
    NPC_FIELD_FLOORS, NPC_FIELD_CEILING,
} from '../npcFieldLimits';

describe('npcFieldLimits', () => {
    it('falls back to the floors with no budget', () => {
        expect(npcFieldLimits(0, 3)).toEqual(NPC_FIELD_FLOORS);
        expect(npcFieldLimits(NaN, 3)).toEqual(NPC_FIELD_FLOORS);
    });

    it('never goes below the floors on a small context', () => {
        // 8k context → ~360t NPC budget; four NPCs share it.
        expect(npcFieldLimits(npcBudgetFor(8_192), 4)).toEqual(NPC_FIELD_FLOORS);
    });

    it('scales up on a 64k context and shrinks as more NPCs share the scene', () => {
        const budget = npcBudgetFor(64_000);
        const two = npcFieldLimits(budget, 2);
        const six = npcFieldLimits(budget, 6);
        expect(two.personality).toBeGreaterThan(six.personality);
        expect(six.personality).toBeGreaterThan(NPC_FIELD_FLOORS.personality);
    });

    it('caps at the ceiling however large the budget', () => {
        const huge = npcFieldLimits(npcBudgetFor(1_000_000), 1);
        expect(huge.appearance).toBe(NPC_FIELD_FLOORS.appearance * NPC_FIELD_CEILING);
    });

    it('keeps the fields in their floor proportions', () => {
        const l = npcFieldLimits(npcBudgetFor(64_000), 3);
        expect(l.appearance / l.now).toBeCloseTo(NPC_FIELD_FLOORS.appearance / NPC_FIELD_FLOORS.now, 1);
    });

    it('reports the range a form field can take', () => {
        expect(npcFieldRange('personality', 4_096)).toEqual({ min: 60, max: 60 });
        const big = npcFieldRange('personality', 128_000);
        expect(big.min).toBe(60);
        expect(big.max).toBe(60 * NPC_FIELD_CEILING);
    });
});

describe('clipText', () => {
    it('returns short text unchanged', () => {
        expect(clipText('Calm.', 60)).toBe('Calm.');
    });

    it('ends on a sentence when one fits', () => {
        expect(clipText('Patient and precise. Quietly warm toward strangers.', 30)).toBe('Patient and precise.');
    });

    it('otherwise ends on a word, with an ellipsis', () => {
        expect(clipText('Patient precise quietly warm toward strangers', 30)).toBe('Patient precise quietly warm…');
    });

    it('hard-cuts a single long word', () => {
        expect(clipText('x'.repeat(50), 10)).toBe('x'.repeat(10) + '…');
    });
});

describe('clipLine', () => {
    it('collapses newlines so the NPC line stays one line', () => {
        expect(clipLine('You: Which shelf?\nLyra: The top one.', 80)).toBe('You: Which shelf? Lyra: The top one.');
    });
});
