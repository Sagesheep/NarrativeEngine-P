import { describe, expect, it, vi } from 'vitest';
import type { LoreChunk } from '../../../types';
import {
    applyAiSummaries,
    buildLoreIndexText,
    chunksNeedingAiIndex,
    cleanAiSummary,
    hasFreshAiSummary,
    loreIndexHash,
    LORE_SHORTLIST_SIZE,
    normalizeLoreShortlistTokens,
    readAiIndexReply,
    shortlistLore,
} from '../loreAiIndex';
import { runAiLoreIndexing } from '../loreAiIndexRunner';
import { rankLoreByKeywords } from '../loreRetriever';
import { recommendContext } from '../../turn/contextRecommender';

const chunk = (id: string, over: Partial<LoreChunk> = {}): LoreChunk => ({
    id, header: `Entry ${id}`, content: `Text of ${id}`, tokens: 10, alwaysInclude: false,
    triggerKeywords: [], scanDepth: 3, category: 'misc', linkedEntities: [], priority: 5,
    summary: `first line of ${id}`, ...over,
});

const indexed = (c: LoreChunk, line: string): LoreChunk => ({ ...c, aiSummary: line, aiSummaryHash: loreIndexHash(c) });

describe('AI index freshness', () => {
    it('a line is fresh until the entry text changes', () => {
        const c = indexed(chunk('a'), 'The mill. Relevant when: the river.');
        expect(hasFreshAiSummary(c)).toBe(true);
        expect(hasFreshAiSummary({ ...c, content: 'rewritten' })).toBe(false);
        expect(hasFreshAiSummary({ ...c, header: 'Renamed' })).toBe(false);
        // A keyword or mode change does not touch the text, so the line stays fresh.
        expect(hasFreshAiSummary({ ...c, triggerKeywords: ['mill'], ragMode: 'vector' })).toBe(true);
    });

    it('lists entries with no fresh line, skipping always-on and disabled ones', () => {
        const chunks = [
            indexed(chunk('fresh'), 'line'),
            { ...indexed(chunk('stale'), 'line'), content: 'edited' },
            chunk('none'),
            chunk('always', { alwaysInclude: true }),
            chunk('off', { disabled: true }),
        ];
        expect(chunksNeedingAiIndex(chunks).map(c => c.id)).toEqual(['stale', 'none']);
    });
});

describe('the lore index text', () => {
    it('uses the fresh AI line only when the switch is on', () => {
        const chunks = [indexed(chunk('a'), 'The mill. Relevant when: the river.'), chunk('b')];
        expect(buildLoreIndexText(chunks).text).toContain('first line of a');
        const on = buildLoreIndexText(chunks, { useAiSummaries: true }).text;
        expect(on).toContain('The mill. Relevant when: the river.');
        expect(on).not.toContain('first line of a');
        expect(on).toContain('first line of b'); // no line yet: falls back
    });

    it('falls back to the first line when the AI line is outdated', () => {
        const stale = { ...indexed(chunk('a'), 'Old line'), content: 'edited' };
        expect(buildLoreIndexText([stale], { useAiSummaries: true }).text).toContain('first line of a');
    });

    it('leaves out always-on and disabled entries', () => {
        const idx = buildLoreIndexText([chunk('a'), chunk('b', { alwaysInclude: true }), chunk('c', { disabled: true })]);
        expect(idx.total).toBe(1);
        expect(idx.text).toContain('ID:a');
        expect(idx.text).not.toContain('ID:b');
        expect(idx.text).not.toContain('ID:c');
    });

    it('shortlists to the ranked top 50 only when over the token limit', () => {
        const chunks = Array.from({ length: 80 }, (_, i) => chunk(`c${i}`));
        const rankIds = vi.fn(() => ['c70', 'c3']);
        const countTokens = (t: string) => t.length / 4;

        const under = buildLoreIndexText(chunks, { shortlistTokenLimit: 1_000_000, rankIds, countTokens });
        expect(under.shortlisted).toBe(false);
        expect(under.listed).toBe(80);
        expect(rankIds).not.toHaveBeenCalled();

        const over = buildLoreIndexText(chunks, { shortlistTokenLimit: 10, rankIds, countTokens });
        expect(over.shortlisted).toBe(true);
        expect(over.listed).toBe(LORE_SHORTLIST_SIZE);
        expect(over.total).toBe(80);
        const ids = [...over.text.matchAll(/ID:(\S+)/g)].map(m => m[1]);
        expect(ids.slice(0, 2)).toEqual(['c70', 'c3']);
    });

    it('never shortlists 50 entries or fewer', () => {
        const chunks = Array.from({ length: 50 }, (_, i) => chunk(`c${i}`));
        const idx = buildLoreIndexText(chunks, { shortlistTokenLimit: 1, rankIds: () => [], countTokens: () => 999 });
        expect(idx.shortlisted).toBe(false);
    });
});

describe('shortlistLore', () => {
    it('fills past the ranked ids by priority, then stored order', () => {
        const chunks = [chunk('a', { priority: 2 }), chunk('b', { priority: 9 }), chunk('c'), chunk('d', { priority: 9 })];
        expect(shortlistLore(chunks, ['c', 'missing', 'c'], 3).map(c => c.id)).toEqual(['c', 'b', 'd']);
    });
});

describe('AI index replies', () => {
    it('keeps lines for known ids only and cleans them', () => {
        const batch = [chunk('a'), chunk('b')];
        const lines = readAiIndexReply({ a: '  **The mill**.\nRelevant when: the river. ', b: 42, zzz: 'unknown id line' }, batch);
        expect([...lines.keys()]).toEqual(['a']);
        expect(lines.get('a')).toBe('The mill. Relevant when: the river.');
    });

    it('cuts long lines at a word', () => {
        const long = cleanAiSummary('word '.repeat(100))!;
        expect(long.length).toBeLessThanOrEqual(221);
        expect(long.endsWith('…')).toBe(true);
        expect(cleanAiSummary('short')).toBeUndefined();
    });

    it('does not apply a line to an entry edited while it was written', () => {
        const a = chunk('a');
        const b = chunk('b');
        const hashes = new Map([['a', loreIndexHash(a)], ['b', loreIndexHash(b)]]);
        const lines = new Map([['a', 'Line for a, long enough'], ['b', 'Line for b, long enough']]);
        const current = [a, { ...b, content: 'edited mid-run' }];
        const next = applyAiSummaries(current, lines, hashes);
        expect(next[0].aiSummary).toBe('Line for a, long enough');
        expect(hasFreshAiSummary(next[0])).toBe(true);
        expect(next[1].aiSummary).toBeUndefined();
        expect(applyAiSummaries(current, new Map(), new Map())).toBe(current);
    });
});

describe('runAiLoreIndexing', () => {
    it('indexes in batches, skips a failed batch, and reports progress', async () => {
        const chunks = ['a', 'b', 'c', 'd', 'e'].map(id => chunk(id));
        const call = vi.fn(async (prompt: string) => {
            if (prompt.includes('ID: c')) throw new Error('timeout');
            const ids = [...prompt.matchAll(/^ID: (\S+)$/gm)].map(m => m[1]);
            return JSON.stringify(Object.fromEntries(ids.map(id => [id, `Entry ${id}. Relevant when: ${id} comes up.`])));
        });
        const applied: string[] = [];
        const result = await runAiLoreIndexing({
            chunks, call, batchSize: 2,
            onBatch: lines => applied.push(...lines.keys()),
        });
        expect(call).toHaveBeenCalledTimes(3);
        expect(applied).toEqual(['a', 'b', 'e']);
        expect(result).toEqual({ done: 5, total: 5, written: 3, failedBatches: 1 });
    });

    it('stops when aborted', async () => {
        const controller = new AbortController();
        const call = vi.fn(async () => { controller.abort(); return '{}'; });
        const result = await runAiLoreIndexing({
            chunks: ['a', 'b', 'c'].map(id => chunk(id)), call, batchSize: 1,
            onBatch: () => {}, signal: controller.signal,
        });
        expect(call).toHaveBeenCalledTimes(1);
        expect(result.done).toBe(1);
    });
});

describe('rankLoreByKeywords', () => {
    it('ranks entries whose keywords appear in the scene, best first', () => {
        const chunks = [
            chunk('dock', { triggerKeywords: ['docks', 'veyra'] }),
            chunk('mill', { triggerKeywords: ['mill'] }),
            chunk('off', { triggerKeywords: ['docks'], disabled: true }),
        ];
        const ids = rankLoreByKeywords(chunks, 'I head to the docks to find Veyra', []);
        expect(ids).toEqual(['dock']);
    });
});

describe('normalizeLoreShortlistTokens', () => {
    it('defaults and clamps', () => {
        expect(normalizeLoreShortlistTokens(undefined)).toBe(4000);
        expect(normalizeLoreShortlistTokens(10)).toBe(500);
        expect(normalizeLoreShortlistTokens(1e9)).toBe(100_000);
        expect(normalizeLoreShortlistTokens(2500.4)).toBe(2500);
    });
});

describe('recommendContext with the index options', () => {
    it('sends the shortlist heading and AI lines in the prompt', async () => {
        const chunks = Array.from({ length: 60 }, (_, i) => indexed(chunk(`c${i}`), `AI line for c${i}, long enough`));
        let prompt = '';
        await recommendContext(undefined, [], chunks, [], 'hello', undefined, undefined, undefined, undefined, undefined,
            async req => { prompt = req.prompt; return { content: '{"npcs":[],"lore":[]}' } as never; },
            false, '',
            { useAiSummaries: true, shortlistTokenLimit: 500, rankIds: () => ['c59'], countTokens: t => t.length });
        expect(prompt).toContain('[LORE INDEX — 50 of 60 entries, the best keyword matches for this turn]');
        expect(prompt).toContain('AI line for c59, long enough');
        expect(prompt.indexOf('ID:c59')).toBeLessThan(prompt.indexOf('ID:c0 '));
    });
});
