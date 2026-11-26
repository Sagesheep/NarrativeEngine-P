import type { ChatMessage, ProviderConfig, EndpointConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';
import { renderPrompt } from '../prompts/promptRegistry';


export async function rateImportance(
    provider: ProviderConfig | EndpointConfig | undefined,
    userText: string,
    gmText: string,
    recentMessages?: ChatMessage[],
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<number> {
    const contextLines = recentMessages
        ?.slice(-4)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 200)}`)
        .join('\n') ?? '';

    const prompt = renderPrompt('memory.importance', {
        context: contextLines,
        userText: userText.slice(0, 600),
        gmText: gmText.slice(0, 1200),
    });

    try {
        const raw = modelCall
            ? (await modelCall({ prompt, priority: 'low', thinkingEffort: 'off', trackingLabel: 'importance-rating', timeoutMs: AI_CALL_TIMEOUT_MS })).content
            : provider
                ? await llmCall(provider, prompt, { priority: 'low', thinkingEffort: 'off', trackingLabel: 'importance-rating', timeoutMs: AI_CALL_TIMEOUT_MS })
                : '';
        const match = raw.trim().match(/\b([1-5])\b/);
        if (match) return parseInt(match[1], 10);
    } catch (err) {
        console.warn('[ImportanceRater] LLM call failed, using heuristic fallback:', err);
    }
    return heuristicImportance(`${userText}\n${gmText}`);
}

/**
 * The archive index stores importance on the server heuristic's 1–10 scale
 * (`server/lib/nlp.js` estimateImportance), and its readers threshold on that
 * scale: NPC knowledge limits at >= 6, the LOD importance bonus at >= 8. The rater
 * answers 1–5, so it is mapped 2r − 1 (1, 3, 5, 7, 9) before it is stored:
 * Significant (4) and Critical (5) clear the knowledge-limit bar, Critical alone
 * the LOD bonus. Stored unmapped, a Max-tier scene could never reach either.
 */
export function ratingToIndexImportance(rating: number): number {
    return Math.min(10, Math.max(1, 2 * Math.round(rating) - 1));
}

export function heuristicImportance(text: string): number {
    const lower = text.toLowerCase();
    let score = 3;
    if (/\b(killed|slain|died|defeated|destroyed|executed|murdered|sacrificed)\b/.test(lower)) score += 2;
    if (/\b(betrayal|betrayed|treason|revelation|twist|prophecy)\b/.test(lower)) score += 2;
    if (/\[MEMORABLE:/.test(text)) score += 1;
    if (/\b(king|queen|emperor|archmage|general|commander)\b/.test(lower)) score += 1;
    if (/\b(acquired|obtained|legendary|artifact|enchanted)\b/.test(lower)) score += 1;
    if (/\b(quest|mission|alliance|treaty|oath|vow)\b/.test(lower)) score += 1;
    return Math.min(5, Math.max(1, score));
}
