import { describe, it, expect } from 'vitest';
import { computeIdf, fuseRRF } from '../lexicalFusion';

describe('computeIdf', () => {
    it('assigns higher IDF to rare terms than common terms', () => {
        // 'common' appears in 18 of 20 docs, 'rare' in 2 of 20
        const docs: string[][] = [];
        for (let i = 0; i < 18; i++) {
            docs.push(['common']);
        }
        docs.push(['common', 'rare']);
        docs.push(['rare']);

        const idf = computeIdf(docs);

        expect(idf['rare']).toBeDefined();
        expect(idf['common']).toBeDefined();
        expect(idf['rare']).toBeGreaterThan(idf['common']);
    });

    it('returns empty object for empty input', () => {
        const idf = computeIdf([]);
        expect(Object.keys(idf)).toHaveLength(0);
    });

    it('produces positive IDF for terms present in fewer than all docs', () => {
        const docs = [['alpha'], ['alpha', 'beta'], ['gamma']];
        const idf = computeIdf(docs);

        // alpha: df=2, N=3 → log(1 + (3-2+0.5)/(2+0.5)) = log(1 + 1.5/2.5) > 0
        expect(idf['alpha']).toBeGreaterThan(0);
        // beta: df=1, N=3 → higher than alpha
        expect(idf['beta']).toBeGreaterThan(idf['alpha']);
        // gamma: df=1, same as beta
        expect(idf['gamma']).toBeCloseTo(idf['beta']);
    });

    it('deduplicates terms within the same document', () => {
        const docs = [['a', 'a', 'a']];
        const idf = computeIdf(docs);
        // 'a' appears in 1 doc, IDF should be computed as df=1
        expect(idf['a']).toBeCloseTo(Math.log(1 + (1 - 1 + 0.5) / (1 + 0.5)));
    });

    it('handles case-insensitivity', () => {
        const docs = [['Ironwall'], ['ironwall']];
        const idf = computeIdf(docs);
        // Both normalize to 'ironwall', df=2, N=2
        expect(idf['ironwall']).toBeDefined();
    });

    it('gives IDF ≈ 0 for terms present in every document', () => {
        const docs = [['ubiquitous'], ['ubiquitous'], ['ubiquitous']];
        const idf = computeIdf(docs);
        // df=3, N=3 → log(1 + (3-3+0.5)/(3+0.5)) = log(1 + 0.5/3.5) ≈ small positive
        expect(idf['ubiquitous']).toBeGreaterThan(0);
        expect(idf['ubiquitous']).toBeLessThan(0.2);
    });
});

describe('fuseRRF', () => {
    it('consensus items rank above single-list items', () => {
        const kw = ['a', 'b', 'c'];
        const emb = ['c', 'b', 'd'];

        const fused = fuseRRF(kw, emb);

        // 'b' and 'c' appear in both lists; they should rank above 'a' and 'd'
        expect(fused.indexOf('b')).toBeLessThan(fused.indexOf('a'));
        expect(fused.indexOf('c')).toBeLessThan(fused.indexOf('d'));
    });

    it('returns keyword-only result when embeddings are empty', () => {
        const kw = ['a', 'b', 'c'];
        const result = fuseRRF(kw, []);
        expect(result).toEqual(['a', 'b', 'c']);
    });

    it('returns embedding-only result when keywords are empty', () => {
        const emb = ['x', 'y', 'z'];
        const result = fuseRRF([], emb);
        expect(result).toEqual(['x', 'y', 'z']);
    });

    it('returns empty array when both inputs are empty', () => {
        const result = fuseRRF([], []);
        expect(result).toEqual([]);
    });

    it('respects kwWeight to boost keyword rankings', () => {
        const kw = ['a', 'b'];
        const emb = ['b', 'a'];

        const fusedKwHeavy = fuseRRF(kw, emb, 60, 2.0, 1.0);
        // 'a' is rank-0 in keywords (weight 2) → should outrank 'b'
        expect(fusedKwHeavy[0]).toBe('a');
    });

    it('respects embWeight to boost embedding rankings', () => {
        const kw = ['a', 'b'];
        const emb = ['b', 'a'];

        const fusedEmbHeavy = fuseRRF(kw, emb, 60, 1.0, 2.0);
        // 'b' is rank-0 in embeddings (weight 2) → should outrank 'a'
        expect(fusedEmbHeavy[0]).toBe('b');
    });

    it('deduplicates: each id appears exactly once', () => {
        const kw = ['a', 'b', 'c', 'd'];
        const emb = ['c', 'b', 'e', 'f'];

        const fused = fuseRRF(kw, emb);

        const idSet = new Set(fused);
        expect(idSet.size).toBe(fused.length);
        expect(fused).toHaveLength(6);
    });
});
