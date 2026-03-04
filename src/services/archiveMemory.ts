import type { ArchiveChunk, ChatMessage } from '../types';
import { countTokens } from './tokenizer';

// Common stop words to exclude from auto-extracted keywords
const STOP_WORDS = new Set([
    'the', 'and', 'for', 'are', 'but', 'not', 'you', 'all', 'can', 'has', 'her',
    'was', 'one', 'our', 'out', 'his', 'had', 'may', 'who', 'been', 'some',
    'them', 'than', 'its', 'into', 'only', 'with', 'from', 'this', 'that',
    'they', 'will', 'each', 'make', 'like', 'been', 'have', 'many', 'most',
    'also', 'made', 'after', 'being', 'their', 'much', 'very', 'when', 'what',
    'which', 'more', 'other', 'about', 'such', 'over', 'just', 'does', 'then',
    'could', 'would', 'should', 'where', 'there', 'those', 'these', 'still',
    'well', 'back', 'even', 'here', 'every', 'both', 'through', 'between',
    'before', 'after', 'during', 'without', 'again', 'because', 'under',
    'real', 'name', 'alias', 'note', 'key', 'class', 'status', 'location',
    'currently', 'known', 'anyone', 'power', 'none', 'variable',
]);

function extractKeywords(text: string, existingNPCNames: string[] = []): string[] {
    const keywords = new Set<string>();

    // 1. Existing NPCs
    for (const npc of existingNPCNames) {
        if (text.toLowerCase().includes(npc.toLowerCase())) {
            keywords.add(npc.toLowerCase());
            // Add individual parts of the name
            npc.split(' ').forEach(w => {
                if (w.length > 2 && !STOP_WORDS.has(w.toLowerCase())) {
                    keywords.add(w.toLowerCase());
                }
            });
        }
    }

    // 2. Proper nouns (capitalized words, 3+ chars)
    const properNouns = text.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g);
    if (properNouns) {
        for (const noun of properNouns) {
            const lower = noun.toLowerCase();
            if (!STOP_WORDS.has(lower)) {
                keywords.add(lower);
            }
        }
    }

    return Array.from(keywords).slice(0, 15); // Cap at 15
}

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function buildArchiveChunk(
    bulletPoints: string,
    sceneLabel: string,
    existingNPCNames: string[]
): ArchiveChunk {
    return {
        id: uid(),
        sceneRange: sceneLabel,
        timestamp: Date.now(),
        summary: bulletPoints,
        keywords: extractKeywords(bulletPoints, existingNPCNames),
        tokens: countTokens(`[${sceneLabel}]\n${bulletPoints}`)
    };
}

export function retrieveArchiveMemory(
    chunks: ArchiveChunk[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget = 3000
): ArchiveChunk[] {
    if (!chunks || chunks.length === 0) return [];

    // Extract search terms from current turn and recent history
    const contextText = [
        userMessage,
        ...recentMessages.slice(-3).map(m => m.content)
    ].join('\n').toLowerCase();

    // 1. Score each chunk
    const scored = chunks.map(chunk => {
        let score = 0;
        // Count keyword matches in the current context
        for (const kw of chunk.keywords) {
            if (contextText.includes(kw)) {
                // Exact word match gets more points (prevent "ash" matching "crash")
                const exactMatch = new RegExp(`\\b${kw}\\b`, 'i');
                if (exactMatch.test(contextText)) {
                    score += 2;
                } else {
                    score += 0.5; // partial match (substring)
                }
            }
        }

        // Bonus for recent temporal chunks if they score above 0
        if (score > 0) {
            const ageChunks = chunks.length;
            const chunkIndex = chunks.indexOf(chunk);
            score += (chunkIndex / ageChunks) * 0.5; // slight bias to more recent
        }

        return { chunk, score };
    });

    // 2. Filter non-zero scores and sort by descending score
    const candidates = scored
        .filter(s => s.score > 0)
        .sort((a, b) => b.score - a.score)
        .map(s => s.chunk);

    // 3. Fill budget
    const selected: ArchiveChunk[] = [];
    let usedTokens = 0;

    for (const chunk of candidates) {
        if (usedTokens + chunk.tokens > tokenBudget) break;
        selected.push(chunk);
        usedTokens += chunk.tokens;
    }

    // Sort selected chronologically so they make sense to the LLM
    selected.sort((a, b) => a.timestamp - b.timestamp);

    return selected;
}
