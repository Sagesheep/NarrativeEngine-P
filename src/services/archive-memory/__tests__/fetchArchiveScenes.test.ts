import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchArchiveScenes } from '../recall';
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
