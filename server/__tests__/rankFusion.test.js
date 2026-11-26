import { describe, expect, it } from 'vitest';
import { reciprocalRankFusion } from '../lib/rankFusion.js';

describe('reciprocalRankFusion', () => {
    it('a single list keeps its order', () => {
        expect(reciprocalRankFusion([['a', 'b', 'c']])).toEqual(['a', 'b', 'c']);
    });

    it('a rephrasing\'s best hit is not pushed behind the whole first list', () => {
        const original = Array.from({ length: 20 }, (_, i) => `o${i}`);
        const merged = reciprocalRankFusion([original, ['x', ...original.slice(0, 3)]]);
        // Appended merge put 'x' at rank 21; fused, it sits right after the ids both queries found.
        expect(merged.indexOf('x')).toBeLessThan(5);
    });

    it('an id several queries agree on rises', () => {
        expect(reciprocalRankFusion([['a', 'b', 'c'], ['c', 'd'], ['c']])[0]).toBe('c');
    });

    it('ties keep first-seen order', () => {
        expect(reciprocalRankFusion([['a'], ['b']])).toEqual(['a', 'b']);
    });
});
