// Rules indexer — re-indexing an already-indexed ruleset.
//
// indexRules keeps a chunk's existing metadata when it already has an embedding,
// so an author who changes a section's `<!-- rag: ... -->` hint (say `vector` to
// `always`) must still see that change honoured. A mode the user set by hand in
// the Rules tab (activationModesUserEdited) is never overwritten.
//
// The sections below are three of the default ruleset's (defaultRules.ts), with
// short bodies.
import { describe, it, expect, vi } from 'vitest';
import type { RuleChunkMeta } from '../../../types';

const upsertEmbedding = vi.fn(async (..._args: unknown[]) => ({ modelId: 'test-embed', version: 1 }));
const deleteEmbedding = vi.fn(async (..._args: unknown[]) => undefined);

vi.mock('../../llm/apiClient', () => ({
    api: { rules: { upsertEmbedding: (...args: unknown[]) => upsertEmbedding(...args), deleteEmbedding: (...args: unknown[]) => deleteEmbedding(...args) } },
}));
vi.mock('../../../utils/llmCall', () => ({ llmCall: vi.fn(async () => '{}') }));

import { indexRules } from '../rulesIndexer';

const RULES = [
    '### Engine Tags',
    '<!-- rag: always, priority: 10 -->',
    'Never state a tag, tier, or stage.',
    '',
    '### Perception Limits',
    '<!-- rag: always, triggers: see, hear, priority: 9 -->',
    'Characters know only what they could perceive.',
    '',
    '### Turn Discipline',
    '<!-- rag: vector, triggers: wait, watch, priority: 9 -->',
    'Stop at the first decision point.',
].join('\n');

describe('indexRules — re-indexing with changed rag hints', () => {
    it('adopts a changed hint for metadata the user never edited, keeps a hand-set mode, and derives missing metadata', async () => {
        const existing: Record<string, RuleChunkMeta> = {
            // Indexed when the hint still said `vector`; the file now says `always`.
            'perception-limits': { id: 'perception-limits', activationModes: ['vector'], triggerKeywords: ['see'], hasEmbedding: true, activationModesUserEdited: false },
            // The user forced this one to always-on in the Rules tab; the hint says `vector`.
            'turn-discipline': { id: 'turn-discipline', activationModes: ['always'], triggerKeywords: ['wait'], hasEmbedding: true, activationModesUserEdited: true },
        };

        const result = await indexRules('camp-1', RULES, existing, undefined, false);

        expect(result.chunks.map(c => c.id)).toEqual(['engine-tags', 'perception-limits', 'turn-discipline']);
        expect(result.chunkMeta['perception-limits'].activationModes).toEqual(['always']);
        expect(result.chunkMeta['perception-limits'].hasEmbedding).toBe(true);
        expect(result.chunkMeta['perception-limits'].triggerKeywords).toEqual(['see']);
        expect(result.chunkMeta['turn-discipline'].activationModes).toEqual(['always']);
        expect(result.chunkMeta['turn-discipline'].activationModesUserEdited).toBe(true);
        expect(result.chunkMeta['engine-tags'].activationModes).toEqual(['always']);
        expect(result.chunkMeta['engine-tags'].hasEmbedding).toBe(true);

        // Only the chunk without an embedding is embedded; the two existing ones are left alone.
        expect(upsertEmbedding).toHaveBeenCalledTimes(1);
        expect(upsertEmbedding.mock.calls[0]?.[0]).toBe('camp-1');
        expect(upsertEmbedding.mock.calls[0]?.[1]).toBe('engine-tags');
        // The caller's metadata object is not mutated.
        expect(existing['perception-limits'].activationModes).toEqual(['vector']);
    });

    it('leaves metadata alone when the hint has not changed', async () => {
        upsertEmbedding.mockClear();
        const existing: Record<string, RuleChunkMeta> = {
            'engine-tags': { id: 'engine-tags', activationModes: ['always'], hasEmbedding: true },
            'perception-limits': { id: 'perception-limits', activationModes: ['always'], hasEmbedding: true },
            'turn-discipline': { id: 'turn-discipline', activationModes: ['vector'], hasEmbedding: true },
        };
        const result = await indexRules('camp-1', RULES, existing, undefined, false);
        expect(result.chunkMeta).toEqual(existing);
        expect(upsertEmbedding).not.toHaveBeenCalled();
    });
});
