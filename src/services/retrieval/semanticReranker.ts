import type { EndpointConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';

export type RerankCandidate = {
    id: string;
    summary: string;
    type: 'scene' | 'lore';
};

export async function rerankCandidates(
    query: string,
    candidates: RerankCandidate[],
    utilityEndpoint: EndpointConfig | undefined,
    opts?: { maxCandidates?: number; topN?: number; timeoutMs?: number },
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<string[]> {
    const maxCandidates = opts?.maxCandidates ?? 30;
    const topN = opts?.topN ?? 12;

    if (candidates.length < 5) {
        return candidates.map(c => c.id);
    }

    const inputIds = new Set(candidates.map(c => c.id));
    const capped = candidates.slice(0, maxCandidates);

    const prompt = `You are filtering memory candidates for relevance.
User query: "${query}"

Candidates (id → summary):
${capped.map(c => `${c.id}: ${c.summary}`).join('\n')}

Return ONLY a JSON array of the candidate ids most relevant to the query, in descending order of relevance. Max ${topN} ids. No prose, no markdown.`;

    try {
        const raw = modelCall
            ? (await modelCall({ prompt, temperature: 0.1, priority: 'high', maxTokens: 500, trackingLabel: 'semantic-rerank', timeoutMs: opts?.timeoutMs ?? AI_CALL_TIMEOUT_MS })).content
            : utilityEndpoint
                ? await llmCall(utilityEndpoint, prompt, { temperature: 0.1, priority: 'high', maxTokens: 500, trackingLabel: 'semantic-rerank', timeoutMs: opts?.timeoutMs ?? AI_CALL_TIMEOUT_MS })
                : '';

        const { value: parsed, parseOk } = extractJsonRobust<string[]>(raw, []);
        if (!parseOk || !Array.isArray(parsed)) {
            console.warn('[Reranker] No JSON array found in response');
            return candidates.map(c => c.id);
        }

        const validIds: string[] = [];
        const dropped: string[] = [];
        for (const item of parsed) {
            if (typeof item === 'string' && inputIds.has(item)) {
                validIds.push(item);
            } else if (typeof item === 'string') {
                dropped.push(item);
            }
        }

        if (dropped.length > 0) {
            console.warn(`[Reranker] Dropped hallucinated ids: ${dropped.join(', ')}`);
        }

        return validIds.length > 0 ? validIds.slice(0, topN) : candidates.map(c => c.id);
    } catch (err) {
        console.warn('[Reranker] Error, returning input order:', err);
        return candidates.map(c => c.id);
    }
}
