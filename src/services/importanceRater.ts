import type { ChatMessage, ProviderConfig, EndpointConfig } from '../types';
import { callLLM } from './callLLM';

const IMPORTANCE_PROMPT = `Rate the narrative importance of the scene below on a 1-5 scale.

CRITERIA:
1 — Trivial: passing greeting, mundane travel, routine shopping, small talk
2 — Minor: routine conversation, minor discovery, atmospheric description
3 — Notable: meaningful dialogue, new NPC introduced, new location explored, skill check
4 — Significant: combat encounter, major reveal, relationship shift, item acquired/lost, plot milestone
5 — Critical: character death, betrayal, major plot twist, world-changing event, irreversible consequence

RULES:
- Output ONLY a single digit 1-5, nothing else
- When uncertain, round DOWN (prefer lower importance)

RECENT CONTEXT:
{context}

SCENE TO RATE:
User: {userText}
GM: {gmText}`;

export async function rateImportance(
    provider: ProviderConfig | EndpointConfig,
    userText: string,
    gmText: string,
    recentMessages?: ChatMessage[],
): Promise<number> {
    const contextLines = recentMessages
        ?.slice(-4)
        .map(m => `[${m.role.toUpperCase()}]: ${m.content.slice(0, 200)}`)
        .join('\n') ?? '';

    const prompt = IMPORTANCE_PROMPT
        .replace('{context}', contextLines)
        .replace('{userText}', userText.slice(0, 600))
        .replace('{gmText}', gmText.slice(0, 1200));

    try {
        const raw = await callLLM(provider, prompt, { priority: 'low' });
        const match = raw.trim().match(/\b([1-5])\b/);
        if (match) return parseInt(match[1], 10);
    } catch (err) {
        console.warn('[ImportanceRater] LLM call failed, using heuristic fallback:', err);
    }
    return heuristicImportance(`${userText}\n${gmText}`);
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
