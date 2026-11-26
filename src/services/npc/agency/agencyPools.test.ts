import { describe, it, expect } from 'vitest';
import {
    TRAIT_VOCAB,
    WANT_POOL,
    ACTION_POOL,
    TRAIT_NAMES,
    SHORT_WANTS,
    MEDIUM_WANTS
} from './agencyPools';

describe('agencyPools', () => {
    describe('TRAIT_VOCAB integrity', () => {
        it('is non-empty', () => {
            expect(TRAIT_VOCAB.length).toBeGreaterThan(0);
        });

        it('has valid keys and structure for every entry', () => {
            for (const entry of TRAIT_VOCAB) {
                expect(entry).toHaveProperty('text');
                expect(entry).toHaveProperty('tier');
                expect(entry).toHaveProperty('hook');
                expect(typeof entry.text).toBe('string');
                expect(typeof entry.hook).toBe('string');
                expect(['default', 'mature']).toContain(entry.tier);
            }
        });

        it('has no duplicate texts', () => {
            const texts = TRAIT_VOCAB.map(e => e.text);
            const uniqueTexts = new Set(texts);
            expect(uniqueTexts.size).toBe(texts.length);
        });
    });

    describe('WANT_POOL integrity', () => {
        it('is non-empty', () => {
            expect(WANT_POOL.length).toBeGreaterThan(0);
        });

        it('has valid keys and structure for every entry', () => {
            for (const entry of WANT_POOL) {
                expect(entry).toHaveProperty('text');
                expect(entry).toHaveProperty('tier');
                expect(entry).toHaveProperty('kind');
                expect(typeof entry.text).toBe('string');
                expect(['default', 'mature']).toContain(entry.tier);
                expect(['short', 'medium']).toContain(entry.kind);
            }
        });

        it('has no duplicate texts', () => {
            const texts = WANT_POOL.map(e => e.text);
            const uniqueTexts = new Set(texts);
            expect(uniqueTexts.size).toBe(texts.length);
        });
    });

    describe('ACTION_POOL integrity', () => {
        it('is non-empty', () => {
            expect(ACTION_POOL.length).toBeGreaterThan(0);
        });

        it('has valid keys and structure for every entry', () => {
            for (const entry of ACTION_POOL) {
                expect(entry).toHaveProperty('text');
                expect(entry).toHaveProperty('tier');
                expect(entry).toHaveProperty('context');
                expect(typeof entry.text).toBe('string');
                expect(['default', 'mature']).toContain(entry.tier);
                expect(['peaceful', 'dangerous']).toContain(entry.context);
            }
        });

        it('has no duplicate texts', () => {
            const texts = ACTION_POOL.map(e => e.text);
            const uniqueTexts = new Set(texts);
            expect(uniqueTexts.size).toBe(texts.length);
        });
    });

    describe('TRAIT_NAMES structure', () => {
        it('matches the length of TRAIT_VOCAB', () => {
            expect(TRAIT_NAMES.length).toBe(TRAIT_VOCAB.length);
        });

        it('contains all trait texts in order', () => {
            for (let i = 0; i < TRAIT_VOCAB.length; i++) {
                expect(TRAIT_NAMES[i]).toBe(TRAIT_VOCAB[i].text);
            }
        });
    });

    describe('SHORT_WANTS and MEDIUM_WANTS partitioning', () => {
        it('partitions WANT_POOL exactly', () => {
            // 1. All short wants are from WANT_POOL with kind 'short'
            for (const w of SHORT_WANTS) {
                expect(w.kind).toBe('short');
                expect(WANT_POOL).toContain(w);
            }

            // 2. All medium wants are from WANT_POOL with kind 'medium'
            for (const w of MEDIUM_WANTS) {
                expect(w.kind).toBe('medium');
                expect(WANT_POOL).toContain(w);
            }

            // 3. Disjointness (intersection is empty)
            const shortTexts = new Set(SHORT_WANTS.map(w => w.text));
            const mediumTexts = new Set(MEDIUM_WANTS.map(w => w.text));
            const intersection = [...shortTexts].filter(t => mediumTexts.has(t));
            expect(intersection).toEqual([]);

            // 4. Together they form WANT_POOL (union size is WANT_POOL size)
            expect(SHORT_WANTS.length + MEDIUM_WANTS.length).toBe(WANT_POOL.length);
        });
    });
});
