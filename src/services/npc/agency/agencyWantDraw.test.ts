import { describe, it, expect } from 'vitest';
import { drawShortWants, drawMediumWants } from './agencyWantDraw';
import { SHORT_WANTS, MEDIUM_WANTS } from './agencyPools';

describe('agencyWantDraw', () => {
    describe('drawShortWants', () => {
        it('returns 4 items by default when pool is large enough', () => {
            const result = drawShortWants({ matureMode: false, traits: [] });
            expect(result).toHaveLength(4);
            // Verify that all returned items are indeed in SHORT_WANTS
            const allShortTexts = SHORT_WANTS.map(w => w.text);
            for (const item of result) {
                expect(allShortTexts).toContain(item);
            }
        });

        it('respects the count parameter', () => {
            const count = 6;
            const result = drawShortWants({ matureMode: false, traits: [], count });
            expect(result).toHaveLength(count);
        });

        it('returns no duplicates in a single draw', () => {
            const count = SHORT_WANTS.length;
            const result = drawShortWants({ matureMode: true, traits: [], count });
            const unique = new Set(result);
            expect(result.length).toBe(unique.size);
        });

        it('returns at most the eligible pool size without repeating or padding when count is too large', () => {
            const count = SHORT_WANTS.length + 10;
            const result = drawShortWants({ matureMode: true, traits: [], count });
            expect(result.length).toBeLessThanOrEqual(SHORT_WANTS.length);
            expect(result.length).toBe(SHORT_WANTS.length);
        });

        it('is deterministic when custom rng is supplied', () => {
            // An RNG that always returns 0 (which results in no shuffle under Fisher-Yates)
            const rngZero = () => 0;
            const result1 = drawShortWants({ matureMode: false, traits: [], count: 3, rng: rngZero });
            const result2 = drawShortWants({ matureMode: false, traits: [], count: 3, rng: rngZero });
            expect(result1).toEqual(result2);

            // Verify it matches the first 3 elements in SHORT_WANTS
            const expectedTexts = SHORT_WANTS.slice(0, 3).map(w => w.text);
            expect(result1).toEqual(expectedTexts);
        });

        it('respects matureMode: false by excluding mature wants', () => {
            const matureShortWants = SHORT_WANTS.filter(w => w.tier === 'mature').map(w => w.text);
            const result = drawShortWants({
                matureMode: false,
                traits: [],
                count: SHORT_WANTS.length
            });
            for (const item of result) {
                expect(matureShortWants).not.toContain(item);
            }
            const defaultShortWantsCount = SHORT_WANTS.filter(w => w.tier !== 'mature').length;
            expect(result).toHaveLength(defaultShortWantsCount);
        });

        it('respects matureMode: true by including mature wants', () => {
            const result = drawShortWants({
                matureMode: true,
                traits: [],
                count: SHORT_WANTS.length
            });
            expect(result).toHaveLength(SHORT_WANTS.length);
        });
    });

    describe('drawMediumWants', () => {
        it('returns 3 items by default when pool is large enough', () => {
            const result = drawMediumWants({ matureMode: false, traits: [] });
            expect(result).toHaveLength(3);
            const allMediumTexts = MEDIUM_WANTS.map(w => w.text);
            for (const item of result) {
                expect(allMediumTexts).toContain(item);
            }
        });

        it('respects matureMode: false by excluding mature wants', () => {
            const matureMediumWants = MEDIUM_WANTS.filter(w => w.tier === 'mature').map(w => w.text);
            expect(matureMediumWants.length).toBeGreaterThan(0);

            // Draw all eligible medium wants with matureMode: false
            const result = drawMediumWants({
                matureMode: false,
                traits: [],
                count: MEDIUM_WANTS.length
            });

            // None of the drawn wants should be in matureMediumWants
            for (const item of result) {
                expect(matureMediumWants).not.toContain(item);
            }

            // The result length should be exactly the number of default wants
            const defaultMediumWantsCount = MEDIUM_WANTS.filter(w => w.tier !== 'mature').length;
            expect(result).toHaveLength(defaultMediumWantsCount);
        });

        it('respects matureMode: true by including mature wants', () => {
            const matureMediumWants = MEDIUM_WANTS.filter(w => w.tier === 'mature').map(w => w.text);

            // Draw all eligible medium wants with matureMode: true
            const result = drawMediumWants({
                matureMode: true,
                traits: [],
                count: MEDIUM_WANTS.length
            });

            // At least some drawn wants should be in matureMediumWants
            const hasMature = result.some(item => matureMediumWants.includes(item));
            expect(hasMature).toBe(true);
            expect(result).toHaveLength(MEDIUM_WANTS.length);
        });

        it('is deterministic when custom rng is supplied', () => {
            const rngZero = () => 0;
            const result1 = drawMediumWants({ matureMode: false, traits: [], count: 3, rng: rngZero });
            const result2 = drawMediumWants({ matureMode: false, traits: [], count: 3, rng: rngZero });
            expect(result1).toEqual(result2);

            const expectedTexts = MEDIUM_WANTS.filter(w => w.tier !== 'mature')
                .slice(0, 3)
                .map(w => w.text);
            expect(result1).toEqual(expectedTexts);
        });
    });
});
