import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArchiveScenes, fetchRecallScenes, recallShortForm } from '../recall';
import type { ArchiveIndexEntry } from '../../../types';
import { countTokens } from '../../infrastructure/tokenizer';

// The server answers in archive order, whatever order the ids were asked in.
function serve(scenes: { sceneId: string; content: string }[]) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(scenes), { status: 200 })));
}

const prose = (label: string, words: number) => `${label} ${'word '.repeat(words)}`.trim();

afterEach(() => vi.unstubAllGlobals());

describe('fetchArchiveScenes', () => {
    it('fills the budget best-ranked first, then returns the chosen scenes in scene order', async () => {
        const scenes = [
            { sceneId: '115', content: prose('old one', 400) },
            { sceneId: '207', content: prose('old two', 400) },
            { sceneId: '533', content: prose('the deal', 400) },
        ];
        serve(scenes);
        const budget = countTokens(scenes[2].content) + countTokens(scenes[0].content) + 50;

        const result = await fetchArchiveScenes('c1', ['533', '115', '207'], budget);

        expect(result.map(s => s.sceneId)).toEqual(['115', '533']);
        expect(result.every(s => !s.content.includes('[...scene truncated'))).toBe(true);
    });

    it('a scene that no longer fits is truncated in rank order, not the oldest one', async () => {
        const scenes = [
            { sceneId: '115', content: prose('old one', 400) },
            { sceneId: '533', content: prose('the deal', 400) },
        ];
        serve(scenes);
        const budget = countTokens(scenes[1].content) + 200;

        const result = await fetchArchiveScenes('c1', ['533', '115'], budget);

        expect(result.map(s => s.sceneId)).toEqual(['115', '533']);
        expect(result.find(s => s.sceneId === '533')!.content).toBe(scenes[1].content);
        expect(result.find(s => s.sceneId === '115')!.content).toContain('[...scene truncated for context budget...]');
    });

    it('matches ids whatever their zero padding', async () => {
        serve([{ sceneId: '007', content: 'seven' }, { sceneId: '012', content: 'twelve' }]);
        const result = await fetchArchiveScenes('c1', ['12', '7'], 3000);
        expect(result.map(s => s.sceneId)).toEqual(['007', '012']);
    });
});

const entry = (sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry => ({
    sceneId, timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '', ...over,
});
const def = (sceneId: string) => entry(sceneId, { definition: `Grey and Rin settle matter ${sceneId} at the ford.` });

describe('fetchRecallScenes', () => {
    it('gives the best scene in full and the rest as short lines when full text would not fit', async () => {
        const ids = ['533', '115', '207', '300'];
        serve(ids.map(sceneId => ({ sceneId, content: prose(`scene ${sceneId}`, 1600) })));
        const result = await fetchRecallScenes('c1', ids, 3000, ids.map(def));

        expect(result.map(s => [s.sceneId, s.form])).toEqual([['115', 'short'], ['207', 'short'], ['300', 'short'], ['533', 'full']]);
        expect(result.find(s => s.sceneId === '115')!.content).toBe('Grey and Rin settle matter 115 at the ford.');
        expect(result.reduce((sum, s) => sum + s.tokens, 0)).toBeLessThanOrEqual(3000);
    });

    it('still gives a later scene in full when it fits whole after the short lines are reserved', async () => {
        serve([{ sceneId: '001', content: prose('small', 100) }, { sceneId: '002', content: prose('big', 1200) }, { sceneId: '003', content: prose('huge', 4000) }]);
        const result = await fetchRecallScenes('c1', ['002', '003', '001'], 3000, [def('001'), def('002'), def('003')]);
        expect(result.map(s => [s.sceneId, s.form])).toEqual([['001', 'full'], ['002', 'full'], ['003', 'short']]);
    });

    it('cuts a huge best scene to fit, keeping room for the short lines', async () => {
        serve([{ sceneId: '001', content: prose('epic', 6000) }, { sceneId: '002', content: prose('other', 1200) }]);
        const result = await fetchRecallScenes('c1', ['001', '002'], 3000, [def('001'), def('002')]);
        expect(result.find(s => s.sceneId === '001')!.content).toContain('[...scene truncated for context budget...]');
        expect(result.find(s => s.sceneId === '002')!.form).toBe('short');
    });

    it('drops a scene with no short form that does not fit, as before', async () => {
        serve([{ sceneId: '001', content: prose('a', 1500) }, { sceneId: '002', content: prose('b', 1500) }, { sceneId: '003', content: prose('c', 1500) }]);
        const result = await fetchRecallScenes('c1', ['001', '002', '003'], 3000, [entry('001'), entry('002'), def('003')]);
        expect(result.map(s => [s.sceneId, s.form])).toEqual([['001', 'full'], ['003', 'short']]);
    });

    it('behaves exactly like fetchArchiveScenes when no scene has a short form', async () => {
        const scenes = [{ sceneId: '115', content: prose('old one', 400) }, { sceneId: '533', content: prose('the deal', 400) }];
        serve(scenes);
        const budget = countTokens(scenes[1].content) + 200;
        const result = await fetchRecallScenes('c1', ['533', '115'], budget, [entry('115'), entry('533')]);
        expect(result.map(s => s.form)).toEqual([undefined, undefined]);
        expect(result.find(s => s.sceneId === '115')!.content).toContain('[...scene truncated for context budget...]');
    });
});

describe('recallShortForm', () => {
    it('uses the definition, else the scene events, else nothing', () => {
        expect(recallShortForm(def('001'))).toBe('Grey and Rin settle matter 001 at the ford.');
        expect(recallShortForm(entry('002', { events: [{ eventType: 'combat', importance: 5, text: 'Bandits ambush Grey.' }, { eventType: 'other', importance: 2, text: 'Rin is hurt.' }] }))).toBe('Bandits ambush Grey. Rin is hurt.');
        expect(recallShortForm(entry('003'))).toBeUndefined();
        expect(recallShortForm(undefined)).toBeUndefined();
    });
});
