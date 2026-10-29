import { describe, it, expect } from 'vitest';
import { retrieveRelevantLore } from '../lore/loreRetriever';
import { computeLoreBudget, loreRelevanceTopN, normalizeLoreDepth, LORE_DEPTH_PROFILES } from '../lore/loreBudget';
import type { LoreChunk } from '../../types';

function makeLoreChunk(overrides: Partial<LoreChunk> & { id: string }): LoreChunk {
    return {
        header: overrides.id,
        content: `content for ${overrides.id}`,
        tokens: 50,
        triggerKeywords: [],
        ...overrides,
    } as LoreChunk;
}

const ids = (chunks: LoreChunk[]) => chunks.map(c => c.id);

// ─── Ceiling ─────────────────────────────────────────────────────────────

describe('computeLoreBudget', () => {
    it('scales with the context window', () => {
        expect(computeLoreBudget(32_000, 'balanced')).toBe(3200);
        expect(computeLoreBudget(32_000, 'lean')).toBe(1600);
        expect(computeLoreBudget(32_000, 'deep')).toBe(4800);
    });

    it('never drops below the depth floor on small windows', () => {
        // Balanced keeps the old fixed 1200-token budget as its floor.
        expect(computeLoreBudget(8192, 'balanced')).toBe(1200);
        expect(computeLoreBudget(4096, 'lean')).toBe(LORE_DEPTH_PROFILES.lean.min);
        expect(computeLoreBudget(4096, 'deep')).toBe(LORE_DEPTH_PROFILES.deep.min);
    });

    it('caps on huge windows', () => {
        expect(computeLoreBudget(1_000_000, 'lean')).toBe(LORE_DEPTH_PROFILES.lean.max);
        expect(computeLoreBudget(1_000_000, 'balanced')).toBe(LORE_DEPTH_PROFILES.balanced.max);
        expect(computeLoreBudget(1_000_000, 'deep')).toBe(LORE_DEPTH_PROFILES.deep.max);
    });

    it('falls back to 8192 for a missing or invalid context limit', () => {
        expect(computeLoreBudget(undefined, 'balanced')).toBe(computeLoreBudget(8192, 'balanced'));
        expect(computeLoreBudget(0, 'deep')).toBe(computeLoreBudget(8192, 'deep'));
        expect(computeLoreBudget(NaN, 'lean')).toBe(computeLoreBudget(8192, 'lean'));
    });

    it('deeper settings never have a smaller ceiling', () => {
        for (const limit of [4096, 8192, 32_000, 128_000, 1_000_000]) {
            expect(computeLoreBudget(limit, 'lean')).toBeLessThanOrEqual(computeLoreBudget(limit, 'balanced'));
            expect(computeLoreBudget(limit, 'balanced')).toBeLessThanOrEqual(computeLoreBudget(limit, 'deep'));
        }
    });
});

describe('normalizeLoreDepth', () => {
    it('passes valid values and defaults everything else to balanced', () => {
        expect(normalizeLoreDepth('lean')).toBe('lean');
        expect(normalizeLoreDepth('deep')).toBe('deep');
        expect(normalizeLoreDepth(undefined)).toBe('balanced');
        expect(normalizeLoreDepth('high')).toBe('balanced');
        expect(normalizeLoreDepth(3)).toBe('balanced');
    });

    it('gets more lenient with depth', () => {
        expect(loreRelevanceTopN('lean')).toBeLessThan(loreRelevanceTopN('balanced'));
        expect(loreRelevanceTopN('balanced')).toBeLessThan(loreRelevanceTopN('deep'));
    });
});

// ─── Relevance floor ─────────────────────────────────────────────────────

describe('Lore retriever — relevance floor (IDF+RRF)', () => {
    // Ten chunks that each match one keyword in the message, so all ten land in the keyword
    // list. Ranks are decided by IDF ties + priority; what matters is that most are weak.
    const weakChunks = Array.from({ length: 10 }, (_, i) => makeLoreChunk({
        id: `weak-${i}`,
        triggerKeywords: [`word${i}`],
        priority: 10 - i, // stable keyword ordering: weak-0 ranks first
        tokens: 50,
    }));
    const message = weakChunks.map((_, i) => `word${i}`).join(' ');

    it('does not fill the budget with weak keyword-only matches', () => {
        const result = retrieveRelevantLore(
            weakChunks, '', '', message, 100_000, [], undefined, 'idf-rrf', undefined, 'balanced',
        );
        // Balanced topN = 3: only the top three keyword ranks pass on keyword alone.
        expect(result).toHaveLength(loreRelevanceTopN('balanced'));
        expect(ids(result)).toEqual(['weak-0', 'weak-1', 'weak-2']);
    });

    it('lets more through on deep and fewer on lean', () => {
        const deep = retrieveRelevantLore(weakChunks, '', '', message, 100_000, [], undefined, 'idf-rrf', undefined, 'deep');
        const lean = retrieveRelevantLore(weakChunks, '', '', message, 100_000, [], undefined, 'idf-rrf', undefined, 'lean');
        expect(deep).toHaveLength(loreRelevanceTopN('deep'));
        expect(lean).toHaveLength(loreRelevanceTopN('lean'));
    });

    it('admits a low-ranked chunk that both keyword and meaning search found', () => {
        const result = retrieveRelevantLore(
            weakChunks, '', '', message, 100_000, [], ['weak-9'], 'idf-rrf', undefined, 'balanced',
        );
        expect(ids(result)).toContain('weak-9');
    });

    it('admits any chunk the recommender picked', () => {
        const unmatched = makeLoreChunk({ id: 'recommended-only', triggerKeywords: ['nothing-here'] });
        const result = retrieveRelevantLore(
            [...weakChunks, unmatched], '', '', message, 100_000, [], undefined, 'idf-rrf', ['recommended-only'], 'balanced',
        );
        expect(ids(result)).toContain('recommended-only');
    });

    it('admits top meaning-search ranks without a keyword hit, but not deep ones', () => {
        const semanticOnly = Array.from({ length: 6 }, (_, i) => makeLoreChunk({ id: `sem-${i}`, triggerKeywords: [`x${i}`] }));
        const result = retrieveRelevantLore(
            semanticOnly, '', '', 'no keyword overlap at all', 100_000, [], semanticOnly.map(c => c.id), 'idf-rrf', undefined, 'balanced',
        );
        expect(ids(result)).toEqual(['sem-0', 'sem-1', 'sem-2']);
    });

    it('never filters always-include chunks', () => {
        const always = makeLoreChunk({ id: 'always', alwaysInclude: true });
        const result = retrieveRelevantLore(
            [always, ...weakChunks], '', '', 'unrelated', 1200, [], undefined, 'idf-rrf', undefined, 'lean',
        );
        expect(ids(result)).toEqual(['always']);
    });

    it('returns no retrieved lore for a turn nothing matches', () => {
        const result = retrieveRelevantLore(weakChunks, '', '', 'a quiet morning', 5000, [], undefined, 'idf-rrf', undefined, 'deep');
        expect(result).toHaveLength(0);
    });
});

// ─── Oversized top chunk ─────────────────────────────────────────────────

describe('Lore retriever — oversized top match', () => {
    const big = makeLoreChunk({ id: 'october-calendar', triggerKeywords: ['shinjiro'], tokens: 2500 });
    const small = makeLoreChunk({ id: 'small', triggerKeywords: ['tartarus'], tokens: 100 });
    const second = makeLoreChunk({ id: 'second-big', triggerKeywords: ['ken'], tokens: 2500 });

    it('includes the best match even when it exceeds the budget (idf-rrf)', () => {
        const result = retrieveRelevantLore([big], '', '', 'what happens to Shinjiro', 1200, [], ['october-calendar'], 'idf-rrf');
        expect(ids(result)).toEqual(['october-calendar']);
    });

    it('includes the best match even when it exceeds the budget (classic)', () => {
        const result = retrieveRelevantLore([big], '', '', 'what happens to Shinjiro', 1200, [], undefined, 'classic');
        expect(ids(result)).toEqual(['october-calendar']);
    });

    it('only the first match may overflow; later ones still respect the budget', () => {
        const result = retrieveRelevantLore(
            [big, second, small], '', '', 'Shinjiro and Ken in Tartarus', 1200, [],
            ['october-calendar', 'second-big', 'small'], 'idf-rrf',
        );
        expect(ids(result)).toContain('october-calendar');
        expect(ids(result)).not.toContain('second-big');
    });
});
