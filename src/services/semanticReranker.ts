import type { EndpointConfig } from '../types';
import { callLLM } from './callLLM';

export type RerankCandidate = {
    id: string;
    summary: string;
    type: 'scene' | 'lore';
};

export async function rerankCandidates(
    query: string,
    candidates: RerankCandidate[],
    utilityEndpoint: EndpointConfig,
    opts?: { maxCandidates?: number; topN?: number }
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
        const raw = await callLLM(utilityEndpoint, prompt, {
            temperature: 0.1,
            priority: 'high',
            maxTokens: 500,
        });

        let cleanContent = raw.replace(/<think[\s\S]*?<\/think>/gi, '');
        const mdMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) cleanContent = mdMatch[1];

        const bracketStart = cleanContent.indexOf('[');
        const bracketEnd = cleanContent.lastIndexOf(']');
        if (bracketStart === -1 || bracketEnd === -1 || bracketEnd <= bracketStart) {
            console.warn('[Reranker] No JSON array found in response');
            return candidates.map(c => c.id);
        }

        const arrayStr = cleanContent.substring(bracketStart, bracketEnd + 1);
        const parsed = JSON.parse(arrayStr);

        if (!Array.isArray(parsed)) {
            console.warn('[Reranker] Response is not an array');
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