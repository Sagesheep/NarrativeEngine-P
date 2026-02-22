import type { LoreChunk } from '../types';

/**
 * Extract proper nouns and key terms from Canon State, Header Index, and User Message.
 * Returns lowercase tokens for matching.
 */
function extractKeywords(canonState: string, headerIndex: string, userMessage: string): Set<string> {
    const keywords = new Set<string>();
    const combined = canonState + '\n' + headerIndex + '\n' + userMessage;

    // Extract values after known field labels
    const fieldPatterns = [
        /LOCATION:\s*(.+)/gi,
        /ATMOSPHERE:\s*(.+)/gi,
        /NARRATIVE_MODE:\s*(.+)/gi,
        /THREAD_TAG[:\s]*\[?(.+?)\]?$/gim,
        /ACTIVE_THREADS:\s*-\s*\[(.+?)\]/gi,
        /SCENE_ID:\s*(\S+)/gi,
        /SESSION_TITLE:\s*(.+)/gi,
    ];

    for (const pattern of fieldPatterns) {
        let match;
        while ((match = pattern.exec(combined)) !== null) {
            // Split comma-separated values and clean
            match[1].split(/[,;/]/).forEach((part) => {
                const clean = part.trim().toLowerCase().replace(/[\[\]()]/g, '');
                if (clean.length > 2) keywords.add(clean);
            });
        }
    }

    // Extract NPC names from "- Name:" or "Name (alignment)" patterns
    const npcPatterns = [
        /^[-•]\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/gm,
        /NPC.*?:\s*([A-Z][a-z]+(?:\s[A-Z][a-z]+)*)/gi,
    ];

    for (const pattern of npcPatterns) {
        let match;
        while ((match = pattern.exec(combined)) !== null) {
            const name = match[1].trim().toLowerCase();
            if (name.length > 2) keywords.add(name);
        }
    }

    // Extract capitalized proper nouns (2+ chars, appear with context)
    const properNouns = combined.match(/[A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})*/g);
    if (properNouns) {
        for (const noun of properNouns) {
            keywords.add(noun.toLowerCase());
        }
    }

    // Fallback/enhancement: extract any notable words from user message even if lowercase
    const stopWords = new Set(['about', 'retrieve', 'information', 'please', 'tell', 'what', 'where', 'when', 'who', 'how', 'why', 'there', 'their', 'they', 'this', 'that', 'from', 'with']);
    const userWords = userMessage.toLowerCase().split(/\s+/);
    for (const w of userWords) {
        const clean = w.replace(/[^a-z]/g, '');
        if (clean.length > 3 && !stopWords.has(clean)) {
            keywords.add(clean);
        }
    }

    return keywords;
}

/**
 * Score a lore chunk against extracted keywords.
 * Higher score = more relevant.
 */
function scoreChunk(chunk: LoreChunk, keywords: Set<string>): number {
    const searchText = (chunk.header + ' ' + chunk.content).toLowerCase();
    let score = 0;

    for (const keyword of keywords) {
        if (searchText.includes(keyword)) {
            // Header match is worth more
            if (chunk.header.toLowerCase().includes(keyword)) {
                score += 3;
            } else {
                score += 1;
            }
        }
    }

    return score;
}

/**
 * Retrieve relevant lore chunks based on Canon State + Header Index keywords.
 * Returns: all alwaysInclude chunks + keyword-matched chunks, sorted by relevance.
 */
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    canonState: string,
    headerIndex: string,
    userMessage: string,
    tokenBudget = 1200
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const keywords = extractKeywords(canonState, headerIndex, userMessage);
    const results: LoreChunk[] = [];
    let usedTokens = 0;

    // Always include flagged chunks first
    const alwaysOn = chunks.filter((c) => c.alwaysInclude);
    for (const chunk of alwaysOn) {
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    // Score and sort remaining chunks
    const dynamic = chunks
        .filter((c) => !c.alwaysInclude)
        .map((c) => ({ chunk: c, score: scoreChunk(c, keywords) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

    // Fill remaining budget
    for (const { chunk } of dynamic) {
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    return results;
}

/**
 * Specifically search lore chunks based on an explicit query string (from LLM tool call).
 * Enforces a strict maximum of 3 results or 1500 tokens.
 */
export function searchLoreByQuery(
    chunks: LoreChunk[],
    query: string,
    tokenBudget = 1500,
    maxResults = 3
): LoreChunk[] {
    if (chunks.length === 0 || !query.trim()) return [];

    const stopWords = new Set(['about', 'retrieve', 'information', 'please', 'tell', 'what', 'where', 'when', 'who', 'how', 'why', 'there', 'their', 'they', 'this', 'that', 'from', 'with', 'the', 'and', 'for']);
    const keywords = new Set<string>();

    // Extract keywords from the explicit query
    const words = query.toLowerCase().split(/\s+/);
    for (const w of words) {
        const clean = w.replace(/[^a-z0-9]/g, '');
        if (clean.length > 2 && !stopWords.has(clean)) {
            keywords.add(clean);
        }
    }

    // Score all chunks (including alwaysInclude, so we can return the top matches)
    const scoredChunks = chunks
        .map((c) => ({ chunk: c, score: scoreChunk(c, keywords) }))
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

    const results: LoreChunk[] = [];
    let usedTokens = 0;

    for (const { chunk } of scoredChunks) {
        if (results.length >= maxResults) break;
        if (usedTokens + chunk.tokens > tokenBudget) continue;

        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    return results;
}
