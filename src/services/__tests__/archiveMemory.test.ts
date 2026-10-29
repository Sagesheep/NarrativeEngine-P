import { describe, it, expect, beforeEach } from 'vitest';
import {
    retrieveArchiveMemory,
    computeArchiveIdf,
    clearArchiveIdfCache,
} from '../archiveMemory';
import type { ArchiveIndexEntry } from '../../types';

// ─── Fixtures ─────────────────────────────────────────────────────────────

let ts = 1000;
function makeEntry(overrides: Partial<ArchiveIndexEntry> & { sceneId: string }): ArchiveIndexEntry {
    return {
        timestamp: ts++,
        keywords: [],
        npcsMentioned: [],
        witnesses: [],
        userSnippet: '',
        ...overrides,
    };
}

// The IDF cache is module-global; reset it between tests so fixtures don't bleed.
beforeEach(() => {
    clearArchiveIdfCache();
    ts = 1000;
});

// ─── IDF cache (signature-gated) ───────────────────────────────────────────

describe('computeArchiveIdf — signature-gated cache', () => {
    it('returns the cached result for the same index (and stays stale on in-place mutation)', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { dragon: 5 } }),
            makeEntry({ sceneId: '2', keywordStrengths: { sword: 5 } }),
        ];
        const first = computeArchiveIdf(index);
        // Mutate an entry in place — signature (length/first/last/lastTs) is unchanged,
        // so the cache must return the prior (now stale) object reference.
        index[0].keywordStrengths = { dragon: 5, newterm: 5 };
        const second = computeArchiveIdf(index);
        expect(second).toBe(first);
        expect(second.newterm).toBeUndefined();
    });

    it('recomputes when the index changes (scene appended)', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { dragon: 5 } }),
            makeEntry({ sceneId: '2', keywordStrengths: { sword: 5 } }),
        ];
        const first = computeArchiveIdf(index);
        const grown = [...index, makeEntry({ sceneId: '3', keywordStrengths: { newterm: 5 } })];
        const second = computeArchiveIdf(grown);
        expect(second).not.toBe(first);
        expect(second.newterm).toBeDefined();
    });

    it('weights a rare term higher than a common one', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { common: 1, rare: 1 } }),
            makeEntry({ sceneId: '2', keywordStrengths: { common: 1 } }),
            makeEntry({ sceneId: '3', keywordStrengths: { common: 1 } }),
            makeEntry({ sceneId: '4', keywordStrengths: { common: 1 } }),
        ];
        const idf = computeArchiveIdf(index);
        expect(idf.rare).toBeGreaterThan(idf.common);
    });

    it('does not share a cached IDF table across campaigns with an identical signature', () => {
        // Two campaigns whose indexes have the same length/first/last sceneId AND timestamps
        // would collide under the old (campaignId-less) signature. Scoping by campaignId keeps
        // them distinct.
        const tsA = 5000;
        const mk = (sceneId: string, strengths: Record<string, number>) =>
            ({ sceneId, timestamp: tsA, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '', keywordStrengths: strengths } as ArchiveIndexEntry);

        const campA = [mk('1', { alpha: 1 }), mk('2', { alpha: 1 })];
        const campB = [mk('1', { beta: 1 }), mk('2', { beta: 1 })];

        const idfA = computeArchiveIdf(campA, 'camp-a');
        const idfB = computeArchiveIdf(campB, 'camp-b');

        // Different campaignId → recomputed, not the camp-a object served for camp-b.
        expect(idfB).not.toBe(idfA);
        expect(idfB.beta).toBeDefined();
        expect(idfB.alpha).toBeUndefined();
    });
});

// ─── RRF fusion behaviour ──────────────────────────────────────────────────

describe('retrieveArchiveMemory — RRF fusion', () => {
    it('consensus: a scene ranked top by both keyword and embedding comes first', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { gryphon: 20 } }), // strongest keyword AND embedding-first
            makeEntry({ sceneId: '2', keywordStrengths: { mist: 5 } }),
            makeEntry({ sceneId: '3', keywordStrengths: { rune: 5 } }),
        ];
        const result = retrieveArchiveMemory(
            index, 'gryphon mist rune', [], undefined, undefined,
            undefined, undefined, undefined,
            ['1', '2', '3'], // embedding ranks 1 first
        );
        expect(result[0]).toBe('1');
    });

    it('disagreement: top of each ranker both surface near the front', () => {
        const index = [
            makeEntry({ sceneId: 'A', keywordStrengths: { keywordhit: 9 } }),
            makeEntry({ sceneId: 'B', keywordStrengths: { keywordhit: 1 } }),
            makeEntry({ sceneId: 'C', keywords: [] }), // embedding-only
            makeEntry({ sceneId: 'D', keywords: [] }), // embedding-only
        ];
        const result = retrieveArchiveMemory(
            index, 'keywordhit', [], undefined, undefined,
            undefined, undefined, undefined,
            ['C', 'D'], // embedding ranker likes C, D (no keyword match)
        );
        // A (keyword top) and C (embedding top) should both be present, near the front.
        expect(result).toContain('A');
        expect(result).toContain('C');
        expect(result.indexOf('A')).toBeLessThanOrEqual(1);
        expect(result.indexOf('C')).toBeLessThanOrEqual(1);
    });

    it('hard-filter removal: a keyword-only scene absent from the embedding result still appears', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { phoenix: 8 } }), // keyword only
            makeEntry({ sceneId: '2', keywordStrengths: { ember: 1 } }),
        ];
        // Embedding ranker returns only scene 2 — under the old hard-filter, scene 1 would be
        // unreachable. It must now surface.
        const result = retrieveArchiveMemory(
            index, 'phoenix', [], undefined, undefined,
            undefined, undefined, undefined,
            ['2'],
        );
        expect(result).toContain('1');
    });
});

// ─── Scope guard: embedding ranker must not bypass exclude / range filters ──

describe('retrieveArchiveMemory — embedding scope guard', () => {
    it('an excluded scene that IS in semanticCandidateIds does not appear', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { alpha: 5 } }),
            makeEntry({ sceneId: '2', keywordStrengths: { beta: 5 } }),
            makeEntry({ sceneId: '3', keywordStrengths: { gamma: 5 } }),
        ];
        const result = retrieveArchiveMemory(
            index, 'alpha beta gamma', [], undefined, undefined,
            undefined, undefined, undefined,
            ['1', '2', '3'],               // embedding includes scene 2
            undefined,
            new Set(['2']),                // …but scene 2 is excluded
        );
        expect(result).not.toContain('2');
    });

    it('an out-of-range scene in semanticCandidateIds does not appear', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { alpha: 5 } }),
            makeEntry({ sceneId: '2', keywordStrengths: { beta: 5 } }),
            makeEntry({ sceneId: '9', keywordStrengths: { gamma: 5 } }),
        ];
        const result = retrieveArchiveMemory(
            index, 'alpha beta gamma', [], undefined, undefined,
            undefined,
            [['1', '2']],                  // range only covers scenes 1-2
            undefined,
            ['1', '2', '9'],               // embedding includes out-of-range scene 9
        );
        expect(result).not.toContain('9');
    });
});

// ─── Planner scenes survive even with no keyword/embedding match ────────────

describe('retrieveArchiveMemory — planner boost', () => {
    it('surfaces a planner scene that matches no keyword and no embedding', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { unrelated: 5 } }),
            makeEntry({ sceneId: 'P', keywordStrengths: { somethingelse: 5 } }), // planner pick
        ];
        const result = retrieveArchiveMemory(
            index, 'unrelated', [], undefined, undefined,
            undefined, undefined, undefined,
            undefined, undefined, undefined,
            ['P'], // planner scene IDs
        );
        expect(result).toContain('P');
    });
});

// ─── Divergence front-loading (replaces the old +5, no double-count) ────────

describe('retrieveArchiveMemory — divergence front-loading', () => {
    it('forces an unmatched divergence scene to the front of the result', () => {
        const index = [
            makeEntry({ sceneId: '1', keywordStrengths: { topic: 5 } }),
            makeEntry({ sceneId: '2', keywordStrengths: { topic: 5 } }),
            makeEntry({ sceneId: 'DIV', keywordStrengths: { offtopic: 5 } }), // no match this turn
        ];
        const result = retrieveArchiveMemory(
            index, 'topic', [], undefined, undefined,
            undefined, undefined, undefined,
            undefined,
            new Set(['DIV']), // divergence scene
        );
        expect(result[0]).toBe('DIV');
    });
});

// ─── Dynamic max: un-caged for desktop, no keyword-only regression ──────────

describe('retrieveArchiveMemory — un-caged dynamic max', () => {
    // 8 scenes, each with a unique rare keyword (high IDF) → strong keyword relevance,
    // no embeddings.
    function eightDistinctMatches(): { index: ArchiveIndexEntry[]; query: string } {
        const kws = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
        const index = kws.map((kw, i) =>
            makeEntry({ sceneId: String(i + 1), keywordStrengths: { [kw]: 10 } })
        );
        return { index, query: kws.join(' ') };
    }

    it('standard depth returns more than the mobile cap of 5 (keyword-only path)', () => {
        const { index, query } = eightDistinctMatches();
        const result = retrieveArchiveMemory(
            index, query, [], undefined, undefined,
            undefined, undefined, undefined, undefined,
            undefined, undefined, undefined,
            'standard',
        );
        expect(result.length).toBe(8); // high tier (10) ≥ 8 available → all 8
        expect(result.length).toBeGreaterThan(5);
    });

    it('lean depth reproduces the mobile cap of 5', () => {
        const { index, query } = eightDistinctMatches();
        const result = retrieveArchiveMemory(
            index, query, [], undefined, undefined,
            undefined, undefined, undefined, undefined,
            undefined, undefined, undefined,
            'lean',
        );
        expect(result.length).toBe(5);
    });

    it('explicit maxScenes overrides the depth ceiling', () => {
        const { index, query } = eightDistinctMatches();
        const result = retrieveArchiveMemory(
            index, query, [], undefined, 3,
            undefined, undefined, undefined, undefined,
            undefined, undefined, undefined,
            'standard',
        );
        expect(result.length).toBe(3);
    });

    it('consensus of 3+ between rankers uses the high tier', () => {
        const kws = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel'];
        const index = kws.map((kw, i) =>
            makeEntry({ sceneId: String(i + 1), keywordStrengths: { [kw]: 10 } })
        );
        // Embedding agrees on 3 scenes already in the keyword list → consensus 3 → high (10).
        const result = retrieveArchiveMemory(
            index, kws.join(' '), [], undefined, undefined,
            undefined, undefined, undefined,
            ['1', '2', '3'],
            undefined, undefined, undefined,
            'standard',
        );
        expect(result.length).toBe(8);
    });
});

// ─── POV-aware scoring still orders witness > absent ────────────────────────

describe('retrieveArchiveMemory — POV perspective', () => {
    it('a witnessed scene outranks a scene the perspective NPC was absent from', () => {
        const index = [
            makeEntry({ sceneId: 'WIT', keywordStrengths: { battle: 5 }, witnesses: ['aldric'] }),
            makeEntry({ sceneId: 'ABS', keywordStrengths: { battle: 5 }, witnesses: ['someone'] }),
        ];
        const result = retrieveArchiveMemory(
            index, 'battle', [], undefined, undefined,
            undefined, undefined,
            'aldric', // npcPerspective
        );
        expect(result.indexOf('WIT')).toBeLessThan(result.indexOf('ABS'));
    });
});
