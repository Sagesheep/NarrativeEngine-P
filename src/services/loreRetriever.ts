import type { LoreChunk, ChatMessage } from '../types';

/**
 * Keyword-based World Info retrieval.
 * Scans the last N messages (per chunk's scanDepth) for exact keyword matches.
 * Only injects chunks whose trigger keywords appear in recent conversation.
 * alwaysInclude chunks bypass keyword matching entirely.
 * Enforces a token budget — ranked by keyword hit count, most relevant first.
 */
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    _canonState: string,
    _headerIndex: string,
    userMessage: string,
    tokenBudget = 1200,
    recentMessages?: ChatMessage[]
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    // Always-include chunks get priority (deducted from budget)
    for (const chunk of chunks) {
        if (chunk.alwaysInclude) {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const history = recentMessages || [];
    const defaultDepth = 2;

    const textByDepth = new Map<number, string>();
    for (const chunk of chunks) {
        if (chunk.alwaysInclude) continue;
        const depth = chunk.scanDepth || defaultDepth;
        if (!textByDepth.has(depth)) {
            const sliceForDepth = history.length > depth ? history.slice(-depth) : history;
            const text = sliceForDepth.map(m => (m.content || '').toLowerCase()).join(' ')
                + ' ' + userMessage.toLowerCase();
            textByDepth.set(depth, text);
        }
    }

    if (!textByDepth.has(defaultDepth)) {
        const slice = history.length > defaultDepth ? history.slice(-defaultDepth) : history;
        textByDepth.set(defaultDepth, slice.map(m => (m.content || '').toLowerCase()).join(' ')
            + ' ' + userMessage.toLowerCase());
    }

    // Score chunks
    const scored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (chunk.alwaysInclude) continue;

        const keywords = chunk.triggerKeywords || [];
        if (keywords.length === 0) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = textByDepth.get(depth) || userMessage.toLowerCase();

        let matchCount = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(scanText)) matchCount++;
        }

        if (matchCount > 0) {
            let score = matchCount * 10;
            
            // Boost by priority
            score += (chunk.priority || 5);

            // Context heuristics
            if (chunk.category === 'power_system' && (scanText.includes('combat') || scanText.includes('attack') || scanText.includes('damage') || scanText.includes('cast'))) {
                score += 15;
            }
            if (chunk.category === 'faction' && (scanText.includes('politics') || scanText.includes('war') || scanText.includes('guild') || scanText.includes('order'))) {
                score += 15;
            }
            if (chunk.category === 'economy' && (scanText.includes('buy') || scanText.includes('sell') || scanText.includes('cost') || scanText.includes('gold') || scanText.includes('money'))) {
                score += 15;
            }

            scored.push({ chunk, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    // Pass 1: Fill based on direct hits
    for (const { chunk } of scored) {
        if (includedSet.has(chunk.id)) continue;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        includedSet.add(chunk.id);
        usedTokens += chunk.tokens;
    }

    // Pass 2: Linked entities cross-pull
    // If we still have budget, pull in chunks that are referenced by included chunks
    if (usedTokens < tokenBudget) {
        const linkedNames = new Set<string>();
        for (const chunk of results) {
            (chunk.linkedEntities || []).forEach(e => linkedNames.add(e.toLowerCase()));
        }

        if (linkedNames.size > 0) {
            // Sort remaining chunks by priority just to be safe
            const remaining = chunks.filter(c => !includedSet.has(c.id)).sort((a, b) => (b.priority || 5) - (a.priority || 5));
            for (const chunk of remaining) {
                const headerLower = chunk.header.toLowerCase();
                const isLinked = Array.from(linkedNames).some(name => headerLower.includes(name));
                if (isLinked && usedTokens + chunk.tokens <= tokenBudget) {
                    results.push(chunk);
                    includedSet.add(chunk.id);
                    usedTokens += chunk.tokens;
                }
            }
        }
    }

    return results;
}

/**
 * Search lore chunks based on an explicit query string (from LLM tool call).
 * Uses keyword scoring against the query. Enforces max 3 results or 1500 tokens.
 */
export function searchLoreByQuery(
    chunks: LoreChunk[],
    query: string,
    tokenBudget = 1500,
    maxResults = 3
): LoreChunk[] {
    if (chunks.length === 0 || !query.trim()) return [];

    const stopWords = new Set(['about', 'retrieve', 'information', 'please', 'tell', 'what', 'where', 'when', 'who', 'how', 'why', 'there', 'their', 'they', 'this', 'that', 'from', 'with', 'the', 'and', 'for']);
    const queryKeywords = new Set<string>();

    const words = query.toLowerCase().split(/\s+/);
    for (const w of words) {
        const clean = w.replace(/[^a-z0-9]/g, '');
        if (clean.length > 2 && !stopWords.has(clean)) {
            queryKeywords.add(clean);
        }
    }

    // Score chunks by how many query keywords match their content + triggerKeywords
    const scored = chunks
        .map((chunk) => {
            const searchText = (chunk.header + ' ' + chunk.content).toLowerCase();
            const triggerSet = new Set((chunk.triggerKeywords || []).map(k => k.toLowerCase()));
            let score = 0;

            for (const kw of queryKeywords) {
                if (triggerSet.has(kw)) score += 3;        // trigger keyword match = high
                else if (chunk.header.toLowerCase().includes(kw)) score += 2;  // header match
                else if (searchText.includes(kw)) score += 1;                  // content match
            }
            return { chunk, score };
        })
        .filter((s) => s.score > 0)
        .sort((a, b) => b.score - a.score);

    const results: LoreChunk[] = [];
    let usedTokens = 0;

    for (const { chunk } of scored) {
        if (results.length >= maxResults) break;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        usedTokens += chunk.tokens;
    }

    return results;
}
