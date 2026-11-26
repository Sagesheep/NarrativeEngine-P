import { describe, it, expect } from 'vitest';
import { buildLoreEntry, reviseLoreEntry } from '../loreChunker';
import type { LoreChunk } from '../../../types';

const existing = [{
    id: 'x', header: 'FACTION -- Ember Lords', content: '', tokens: 1, alwaysInclude: false,
    triggerKeywords: [], scanDepth: 3, category: 'faction', linkedEntities: [], priority: 7,
}] as LoreChunk[];

describe('buildLoreEntry', () => {
    it('builds a complete chunk from a typed entry', () => {
        const entry = buildLoreEntry({
            header: '  The Ashen Pact ',
            content: 'A secret treaty signed by the Ember Lords after the fall of Vessara.',
            keywords: ['Pact ', '', 'treaty'],
        }, existing, 'id1');
        expect(entry.id).toBe('id1');
        expect(entry.header).toBe('The Ashen Pact');
        expect(entry.tokens).toBeGreaterThan(0);
        expect(entry.triggerKeywords.slice(0, 2)).toEqual(['pact', 'treaty']);
        expect(new Set(entry.triggerKeywords).size).toBe(entry.triggerKeywords.length);
        expect(entry.linkedEntities).toEqual(['Ember Lords']);
        expect(entry.alwaysInclude).toBe(false);
        expect(entry.scanDepth).toBe(3);
    });

    it('keeps a chosen category and gives it that category\'s priority', () => {
        const entry = buildLoreEntry({ header: 'Old Mill', content: 'A mill.', category: 'location' }, [], 'id2');
        expect(entry.category).toBe('location');
        expect(entry.priority).toBe(6);
    });

    it('treats the always match mode as always on', () => {
        const entry = buildLoreEntry({ header: 'Law', content: 'No magic in town.', ragMode: 'always' }, [], 'id3');
        expect(entry.alwaysInclude).toBe(true);
        expect(entry.ragMode).toBe('always');
        expect(entry.priority).toBe(10);
    });
});

describe('reviseLoreEntry', () => {
    const base = buildLoreEntry({ header: 'Old Mill', content: 'A mill.', category: 'location', keywords: ['mill'], ragMode: 'keyword' }, [], 'm1');

    it('changes the text and refreshes what is derived from it, keeping the rest', () => {
        const edited = reviseLoreEntry({ ...base, scanDepth: 5 }, {
            header: ' Old Mill ', content: 'A burned mill the Ember Lords torched.',
        }, [...existing, base]);
        expect(edited.id).toBe('m1');
        expect(edited.header).toBe('Old Mill');
        expect(edited.content).toBe('A burned mill the Ember Lords torched.');
        expect(edited.tokens).toBeGreaterThan(base.tokens);
        expect(edited.linkedEntities).toEqual(['Ember Lords']);
        expect(edited.triggerKeywords).toEqual(base.triggerKeywords);
        expect(edited.ragMode).toBe('keyword');
        expect(edited.scanDepth).toBe(5);
        expect(edited.category).toBe('location');
        expect(edited.priority).toBe(base.priority);
    });

    it('re-prioritises when the category changes', () => {
        const edited = reviseLoreEntry(base, { header: 'Old Mill', content: 'A mill.', category: 'faction' }, [base]);
        expect(edited.category).toBe('faction');
        expect(edited.priority).toBe(7);
    });
});
