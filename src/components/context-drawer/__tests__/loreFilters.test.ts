import { describe, expect, it } from 'vitest';
import type { LoreChunk } from '../../../types';
import { buildLoreFilterChips, cleanFolder, folderNames, matchesLoreFilter } from '../loreFilters';
import { validateChunks } from '../../../services/lore/worldCard';

const chunk = (id: string, extra: Partial<LoreChunk> = {}): LoreChunk => ({
    id, header: id, content: 'body', tokens: 3, alwaysInclude: false, triggerKeywords: [],
    scanDepth: 3, category: 'misc', linkedEntities: [], priority: 3, ...extra,
});

describe('loreFilters', () => {
    it('cleans folder names and treats blank as none', () => {
        expect(cleanFolder('  Great   Houses ')).toBe('Great Houses');
        expect(cleanFolder('   ')).toBeUndefined();
        expect(cleanFolder(undefined)).toBeUndefined();
    });

    it('lists folders first, then categories, with counts', () => {
        const chips = buildLoreFilterChips([
            chunk('a', { category: 'rules' }),
            chunk('b', { category: 'rules', folder: 'Combat' }),
            chunk('c', { category: 'world_overview', folder: 'combat' }),
        ]);
        expect(chips.map(c => [c.kind, c.label, c.count])).toEqual([
            ['folder', 'Combat', 2],
            ['category', 'rules', 2],
            ['category', 'world overview', 1],
        ]);
    });

    it('matches by category or by folder key', () => {
        const c = chunk('a', { category: 'location', folder: 'Vehicles' });
        expect(matchesLoreFilter(c, null)).toBe(true);
        expect(matchesLoreFilter(c, 'category:location')).toBe(true);
        expect(matchesLoreFilter(c, 'category:rules')).toBe(false);
        expect(matchesLoreFilter(c, 'folder:vehicles')).toBe(true);
        expect(matchesLoreFilter(chunk('b'), 'folder:vehicles')).toBe(false);
        expect(folderNames([c])).toEqual(['Vehicles']);
    });

    it('keeps folders in world card export', () => {
        expect(validateChunks([chunk('a', { folder: 'Vehicles' })])[0].folder).toBe('Vehicles');
        expect(validateChunks([chunk('a')])[0].folder).toBeUndefined();
    });
});
