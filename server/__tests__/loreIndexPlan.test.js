import { describe, it, expect } from 'vitest';
import { planLoreIndex } from '../lib/loreIndexPlan.js';

const chunk = (id, extra = {}) => ({ id, header: `Header ${id}`, content: 'body', triggerKeywords: ['a'], linkedEntities: [], ...extra });

describe('planLoreIndex', () => {
    it('embeds only a newly added chunk when the rest are unchanged and indexed', () => {
        const prev = [chunk('a'), chunk('b')];
        const next = [...prev, chunk('c')];
        const { toEmbed, toDelete } = planLoreIndex(prev, next, ['a', 'b']);
        expect(toEmbed.map(c => c.id)).toEqual(['c']);
        expect(toDelete).toEqual([]);
    });

    it('embeds nothing for a change that does not touch the embedded text', () => {
        const prev = [chunk('a')];
        const next = [chunk('a', { scanDepth: 5, ragMode: 'vector', content: 'new body' })];
        expect(planLoreIndex(prev, next, ['a']).toEmbed).toEqual([]);
    });

    it('re-embeds a chunk whose keywords or header changed', () => {
        const prev = [chunk('a'), chunk('b')];
        const next = [chunk('a', { triggerKeywords: ['a', 'b'] }), chunk('b', { header: 'Renamed' })];
        expect(planLoreIndex(prev, next, ['a', 'b']).toEmbed.map(c => c.id)).toEqual(['a', 'b']);
    });

    it('embeds an unchanged chunk that has no current vector', () => {
        const prev = [chunk('a'), chunk('b')];
        expect(planLoreIndex(prev, prev, ['a']).toEmbed.map(c => c.id)).toEqual(['b']);
    });

    it('embeds everything on the first save', () => {
        const next = [chunk('a'), chunk('b')];
        expect(planLoreIndex([], next, []).toEmbed).toHaveLength(2);
    });

    it('removes vectors for chunks that left the list', () => {
        const prev = [chunk('a'), chunk('b')];
        const { toDelete } = planLoreIndex(prev, [chunk('a')], ['a', 'b']);
        expect(toDelete).toEqual(['b']);
    });

    it('tolerates a non-array previous file', () => {
        expect(planLoreIndex(null, [chunk('a')], []).toEmbed).toHaveLength(1);
    });
});
