import { describe, it, expect } from 'vitest';
import { buildLoreEntry } from '../loreChunker';
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
