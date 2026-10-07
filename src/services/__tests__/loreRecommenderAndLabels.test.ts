import { describe, expect, it } from 'vitest';
import { retrieveRelevantLore } from '../lore/loreRetriever';
import { chunkLoreFile } from '../lore/loreChunker';
import type { LoreChunk } from '../../types';

const chunk = (id: string, triggerKeywords: string[], tokens = 200): LoreChunk =>
    ({ id, header: id, content: `content for ${id}`, tokens, triggerKeywords } as LoreChunk);

// Budget fits two 200-token chunks.
const BUDGET = 400;
const ids = (r: LoreChunk[]) => r.map(c => c.id);

describe('lore selection — the Context Recommender\'s picks', () => {
    // A chunk only the recommender picked competes at its rank; one the keyword search also
    // found rises above keyword-only matches. (Turn Prep probe P5: "I spot Helena Broadmarsh"
    // got two unrelated character entries while the recommender picked Helena's own.)
    const lore = [
        chunk('fenwick', ['young', 'everything']),
        chunk('cost-of-living', ['everything', 'food']),
        chunk('helena', ['helena broadmarsh', 'marken']),
    ];
    const message = 'Everything is quiet. I spot Helena Broadmarsh across the square.';

    it('a pick the keyword search also found takes the top slot', () => {
        const picked = retrieveRelevantLore(lore, '', '', message, BUDGET, [], undefined, 'idf-rrf', ['helena']);
        expect(ids(picked)[0]).toBe('helena');
    });

    it('a pick no search found still gets a slot when it ranks high enough', () => {
        // The message never names Helena; only the recommender knows she matters here.
        const quiet = 'Everything is quiet on the walk back.';
        expect(ids(retrieveRelevantLore(lore, '', '', quiet, BUDGET, [], undefined, 'idf-rrf'))).not.toContain('helena');
        expect(ids(retrieveRelevantLore(lore, '', '', quiet, BUDGET, [], undefined, 'idf-rrf', ['helena']))).toContain('helena');
    });

    it('unknown or disabled ids are ignored', () => {
        const withDisabled = [...lore, { ...chunk('gone', []), disabled: true } as LoreChunk];
        const picked = retrieveRelevantLore(withDisabled, '', '', message, BUDGET, [], undefined, 'idf-rrf', ['character-therese-soll', 'gone']);
        expect(ids(picked)).not.toContain('gone');
        expect(picked.length).toBeGreaterThan(0);
    });

    it('without picks, behaviour is unchanged', () => {
        const a = retrieveRelevantLore(lore, '', '', message, BUDGET, [], undefined, 'idf-rrf');
        const b = retrieveRelevantLore(lore, '', '', message, BUDGET, [], undefined, 'idf-rrf', []);
        expect(ids(a)).toEqual(ids(b));
    });
});

describe('lore selection — field-label keywords', () => {
    it('stored field labels (type, aliases, appearance…) no longer match chat text', () => {
        const lore = [chunk('labels-only', ['type', 'appearance', 'aliases', 'disposition'])];
        const picked = retrieveRelevantLore(lore, '', '', 'What type of appearance does she have? Any aliases?', BUDGET, [], undefined, 'idf-rrf');
        expect(ids(picked)).toEqual([]);
    });

    it('new chunks do not get field labels as trigger keywords', () => {
        const [c] = chunkLoreFile([
            '### CHARACTER -- Helena Broadmarsh',
            '**Type:** Investigator',
            '**Aliases:** The Iron Matron',
            '**Appearance:** Tall, grey eyes.',
            '**Disposition:** Wary.',
            'Helena works the Marken docks.',
        ].join('\n'));
        expect(c.triggerKeywords).toEqual(expect.arrayContaining(['helena broadmarsh']));
        for (const label of ['type', 'aliases', 'appearance', 'disposition']) {
            expect(c.triggerKeywords).not.toContain(label);
        }
    });
});
