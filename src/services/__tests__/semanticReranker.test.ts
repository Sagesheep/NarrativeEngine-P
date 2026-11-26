/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/llmCall', () => ({
    llmCall: vi.fn(),
}));

import { llmCall } from '../../utils/llmCall';
import { rerankCandidates } from '../retrieval/semanticReranker';
import type { RerankCandidate } from '../retrieval/semanticReranker';

const mockLlmCall = vi.mocked(llmCall);

const makeCandidates = (count: number): RerankCandidate[] =>
    Array.from({ length: count }, (_, i) => ({
        id: `id-${String(i).padStart(3, '0')}`,
        summary: `Summary for candidate ${i}`,
        type: 'scene' as const,
    }));

const endpoint = { endpoint: 'http://localhost', modelName: 'test-model' } as any;

describe('rerankCandidates', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns input order without calling LLM when fewer than 5 candidates', async () => {
        const candidates = makeCandidates(4);
        const result = await rerankCandidates('query', candidates, endpoint);
        expect(mockLlmCall).not.toHaveBeenCalled();
        expect(result).toEqual(candidates.map(c => c.id));
    });

    it('parses a plain JSON array response', async () => {
        const candidates = makeCandidates(6);
        mockLlmCall.mockResolvedValueOnce('["id-002","id-000","id-004"]');

        const result = await rerankCandidates('query', candidates, endpoint);
        expect(result).toEqual(['id-002', 'id-000', 'id-004']);
    });

    it('parses a <think>-wrapped + fenced JSON array', async () => {
        const candidates = makeCandidates(6);
        mockLlmCall.mockResolvedValueOnce(
            '<think>Let me rank these carefully.</think>\n```json\n["id-005","id-001"]\n```'
        );

        const result = await rerankCandidates('query', candidates, endpoint);
        expect(result).toEqual(['id-005', 'id-001']);
    });

    it('recovers from a truncated JSON array (truncation recovery path)', async () => {
        const candidates = makeCandidates(6);
        // Truncated: third entry cut off mid-string
        mockLlmCall.mockResolvedValueOnce('["id-003","id-001","id-00');

        const result = await rerankCandidates('query', candidates, endpoint);
        // Should recover at least the first two complete entries
        expect(result).toContain('id-003');
        expect(result).toContain('id-001');
    });

    it('drops hallucinated ids not in input set', async () => {
        const candidates = makeCandidates(6);
        mockLlmCall.mockResolvedValueOnce('["id-000","hallucinated-id","id-002"]');

        const result = await rerankCandidates('query', candidates, endpoint);
        expect(result).toContain('id-000');
        expect(result).toContain('id-002');
        expect(result).not.toContain('hallucinated-id');
    });

    it('falls back to input order when no JSON array in response', async () => {
        const candidates = makeCandidates(6);
        mockLlmCall.mockResolvedValueOnce('I cannot rank these candidates.');

        const result = await rerankCandidates('query', candidates, endpoint);
        expect(result).toEqual(candidates.map(c => c.id));
    });

    it('respects topN cap', async () => {
        const candidates = makeCandidates(10);
        const ids = candidates.map(c => c.id);
        mockLlmCall.mockResolvedValueOnce(JSON.stringify(ids));

        const result = await rerankCandidates('query', candidates, endpoint, { topN: 3 });
        expect(result.length).toBeLessThanOrEqual(3);
    });
});

describe('rerankCandidates — thinking', () => {
    it('asks for no thinking, so a 500-token cap is not spent before the answer', async () => {
        const modelCall = vi.fn().mockResolvedValue({ content: '["id-001"]' });
        await rerankCandidates('query', makeCandidates(6), undefined, undefined, modelCall);
        expect(modelCall.mock.calls[0][0].thinkingEffort).toBe('off');
    });
});

describe('rerankCandidates — bare-number ids', () => {
    const scenes = ['062', '118', '119', '534', '533', '351'].map(id => ({ id, summary: `scene ${id}`, type: 'scene' as const }));

    it('accepts unquoted ids, including a leading zero that is not valid JSON', async () => {
        mockLlmCall.mockResolvedValueOnce('[534, 062, 118]');
        expect(await rerankCandidates('query', scenes, endpoint)).toEqual(['534', '062', '118']);
    });

    it('matches a number without its padding', async () => {
        mockLlmCall.mockResolvedValueOnce('[62, 533]');
        expect(await rerankCandidates('query', scenes, endpoint)).toEqual(['062', '533']);
    });

    it('still drops ids that are not candidates', async () => {
        mockLlmCall.mockResolvedValueOnce('[999, 118]');
        expect(await rerankCandidates('query', scenes, endpoint)).toEqual(['118']);
    });
});
