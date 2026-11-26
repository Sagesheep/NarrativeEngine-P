/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/llmCall', () => ({
    llmCall: vi.fn(),
}));
vi.mock('../../store/campaignStore', () => ({
    saveLoreChunks: vi.fn().mockResolvedValue(undefined),
}));

import { llmCall } from '../../utils/llmCall';
import { saveLoreChunks } from '../../store/campaignStore';
import { enrichLoreKeywords } from '../lore/loreKeywordEnricher';
import type { LoreChunk } from '../../types';

const mockLlmCall = vi.mocked(llmCall);
const mockSave = vi.mocked(saveLoreChunks);

function makeChunk(id: string): LoreChunk {
    return {
        id,
        header: `Header for ${id}`,
        content: `Content for ${id}`,
        category: 'world' as any,
        summary: '',
        alwaysInclude: false,
        triggerKeywords: [],
        secondaryKeywords: [],
        keywordsEnriched: false,
        enrichedVersion: 0,
    } as unknown as LoreChunk;
}

const endpoint = { endpoint: 'http://localhost', modelName: 'test-model' } as any;

describe('enrichLoreKeywords', () => {
    beforeEach(() => vi.clearAllMocks());

    it('skips chunks that are already enriched', async () => {
        const chunk = { ...makeChunk('lore-01'), enrichedVersion: 2 };
        await enrichLoreKeywords('campaign-1', [chunk], endpoint);
        expect(mockLlmCall).not.toHaveBeenCalled();
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('parses a plain JSON object response', async () => {
        const chunks = [makeChunk('lore-01'), makeChunk('lore-02')];
        mockLlmCall.mockResolvedValueOnce(
            '{"lore-01":{"primary":["dragon","scales"],"secondary":["fire","cave"]},' +
            '"lore-02":{"primary":["guild","thieves"],"secondary":["shadow","coin"]}}'
        );

        await enrichLoreKeywords('campaign-1', chunks, endpoint);

        expect(mockSave).toHaveBeenCalledOnce();
        const savedChunks: LoreChunk[] = mockSave.mock.calls[0][1];
        const c1 = savedChunks.find(c => c.id === 'lore-01')!;
        expect(c1.triggerKeywords).toContain('dragon');
        expect(c1.triggerKeywords).toContain('scales');
    });

    it('parses a <think>-wrapped + fenced JSON object response', async () => {
        const chunks = [makeChunk('lore-03')];
        mockLlmCall.mockResolvedValueOnce(
            '<think>Analyzing the lore entry.</think>\n```json\n' +
            '{"lore-03":{"primary":["elven","ruins","sunken"],"secondary":["ancient","magic"]}}\n```'
        );

        await enrichLoreKeywords('campaign-1', chunks, endpoint);

        expect(mockSave).toHaveBeenCalledOnce();
        const saved: LoreChunk[] = mockSave.mock.calls[0][1];
        expect(saved[0].triggerKeywords).toContain('elven');
        expect(saved[0].triggerKeywords).toContain('ruins');
    });

    it('recovers keywords from a truncated JSON object (truncation recovery path)', async () => {
        const chunks = [makeChunk('lore-04'), makeChunk('lore-05')];
        // Truncated after the first chunk's closing brace — second chunk missing
        mockLlmCall.mockResolvedValueOnce(
            '{"lore-04":{"primary":["kraken","depths","sea"],"secondary":["salt","wave"]}'
        );

        await enrichLoreKeywords('campaign-1', chunks, endpoint);

        // lore-04 should still be enriched (truncation recovery returns partial object)
        expect(mockSave).toHaveBeenCalledOnce();
        const saved: LoreChunk[] = mockSave.mock.calls[0][1];
        const c4 = saved.find(c => c.id === 'lore-04');
        expect(c4?.triggerKeywords).toContain('kraken');
    });

    it('skips a batch gracefully when LLM returns unparseable response', async () => {
        const chunks = [makeChunk('lore-06')];
        mockLlmCall.mockResolvedValueOnce('I cannot generate keywords right now.');

        await enrichLoreKeywords('campaign-1', chunks, endpoint);

        // parseEnrichmentResponse throws → batch is skipped, save is not called
        expect(mockSave).not.toHaveBeenCalled();
    });

    it('handles the old flat-array keyword shape', async () => {
        const chunks = [makeChunk('lore-07')];
        // Old format: flat array instead of {primary, secondary}
        mockLlmCall.mockResolvedValueOnce('{"lore-07":["volcano","forge","dwarven"]}');

        await enrichLoreKeywords('campaign-1', chunks, endpoint);

        const saved: LoreChunk[] = mockSave.mock.calls[0][1];
        const c = saved.find(c => c.id === 'lore-07');
        expect(c?.triggerKeywords).toContain('volcano');
        expect(c?.secondaryKeywords).toEqual([]);
    });
});
