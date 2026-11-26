import { describe, it, expect } from 'vitest';
import { computeDynamicMax } from '../dynamicMax';

describe('computeDynamicMax', () => {
    it('honors an explicit maxScenes override regardless of consensus', () => {
        expect(computeDynamicMax(['a', 'b'], ['a', 'b'], 'standard', 100, 3)).toBe(3);
        expect(computeDynamicMax([], [], 'deep', 0, 1)).toBe(1);
    });

    // ─── Consensus path (embedding ranker present) ──────────────────────────
    describe('consensus path (embedding ranker present)', () => {
        it('high tier when ≥3 ids appear in both rankers', () => {
            const kw = ['a', 'b', 'c', 'd'];
            const emb = ['a', 'b', 'c', 'x'];
            expect(computeDynamicMax(kw, emb, 'standard', 0, undefined)).toBe(10); // standard.high
        });

        it('mid tier when 1-2 ids overlap', () => {
            const kw = ['a', 'b', 'c'];
            const emb = ['a', 'y', 'z'];
            expect(computeDynamicMax(kw, emb, 'standard', 0, undefined)).toBe(7); // standard.mid
        });

        it('low tier when there is no overlap', () => {
            const kw = ['a', 'b'];
            const emb = ['x', 'y'];
            expect(computeDynamicMax(kw, emb, 'standard', 0, undefined)).toBe(5); // standard.low
        });

        it('respects the depth tier (lean vs deep) for the same consensus', () => {
            const kw = ['a', 'b', 'c'];
            const emb = ['a', 'b', 'c'];
            expect(computeDynamicMax(kw, emb, 'lean', 0, undefined)).toBe(5);  // lean.high
            expect(computeDynamicMax(kw, emb, 'deep', 0, undefined)).toBe(12); // deep.high
        });

        it('ignores topKeywordRelevance entirely when an embedding ranker is present', () => {
            // Even a huge keyword relevance does not change the consensus-derived tier.
            const kw = ['a', 'b'];
            const emb = ['x', 'y'];
            expect(computeDynamicMax(kw, emb, 'standard', 9999, undefined)).toBe(5); // still low (no overlap)
        });
    });

    // ─── Keyword-only path (no embedding ranker) ────────────────────────────
    describe('keyword-only path (empty embedding ranker)', () => {
        it('sizes by keyword strength: >15 → high', () => {
            expect(computeDynamicMax(['a'], [], 'standard', 16, undefined)).toBe(10);
        });

        it('8 < relevance ≤ 15 → mid', () => {
            expect(computeDynamicMax(['a'], [], 'standard', 9, undefined)).toBe(7);
        });

        it('≤8 → low', () => {
            expect(computeDynamicMax(['a'], [], 'standard', 8, undefined)).toBe(5);
            expect(computeDynamicMax(['a'], [], 'standard', 0, undefined)).toBe(5);
        });

        it('boundary: exactly 15 is NOT high (uses >15)', () => {
            expect(computeDynamicMax(['a'], [], 'standard', 15, undefined)).toBe(7); // mid, not high
        });
    });
});
