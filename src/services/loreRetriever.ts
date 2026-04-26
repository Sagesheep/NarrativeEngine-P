import type { LoreChunk, ChatMessage } from '../types';

// ─── Regex Cache ──────────────────────────────────────────────────────────
const regexCache = new Map<string, RegExp>();

function getKeywordRegex(keyword: string): RegExp {
    let regex = regexCache.get(keyword);
    if (!regex) {
        const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        try {
            regex = new RegExp(`\\b${escaped}\\b`, 'gi');
        } catch {
            regex = new RegExp(escaped, 'gi');
        }
        regexCache.set(keyword, regex);
    }
    return regex;
}

// ─── Group Competition ────────────────────────────────────────────────────
function applyGroupCompetition(
    scored: { chunk: LoreChunk; score: number }[]
): { chunk: LoreChunk; score: number }[] {
    const groupMap = new Map<string, { chunk: LoreChunk; score: number }>();
    const ungrouped: { chunk: LoreChunk; score: number }[] = [];

    for (const entry of scored) {
        const group = entry.chunk.group;
        if (!group) {
            ungrouped.push(entry);
            continue;
        }
        const existing = groupMap.get(group);
        const entryWeight = entry.chunk.groupWeight ?? 0;
        if (!existing) {
            groupMap.set(group, entry);
            continue;
        }
        const existingWeight = existing.chunk.groupWeight ?? 0;
        if (entryWeight > existingWeight || (entryWeight === existingWeight && entry.score > existing.score)) {
            groupMap.set(group, entry);
        }
    }

    return [...ungrouped, ...groupMap.values()];
}

// ─── Keyword Scoring Helper ───────────────────────────────────────────────
function countKeywordHits(keywords: string[], scanText: string): number {
    let matchCount = 0;
    for (const kw of keywords) {
        const regex = getKeywordRegex(kw);
        regex.lastIndex = 0;
        if (regex.test(scanText)) matchCount++;
    }
    return matchCount;
}

function categoryBoost(category: string, scanText: string): number {
    if (category === 'power_system' && (scanText.includes('combat') || scanText.includes('attack') || scanText.includes('damage') || scanText.includes('cast'))) return 15;
    if (category === 'faction' && (scanText.includes('politics') || scanText.includes('war') || scanText.includes('guild') || scanText.includes('order'))) return 15;
    if (category === 'economy' && (scanText.includes('buy') || scanText.includes('sell') || scanText.includes('cost') || scanText.includes('gold') || scanText.includes('money'))) return 15;
    return 0;
}

// ─── Main Retrieval (Semantic-First) ──────────────────────────────────────
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    _canonState: string,
    _headerIndex: string,
    userMessage: string,
    tokenBudget = 1200,
    recentMessages?: ChatMessage[],
    semanticCandidateIds?: string[],
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    for (const chunk of chunks) {
        if (chunk.alwaysInclude) {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const semanticSet = new Set(semanticCandidateIds ?? []);

    const history = recentMessages || [];
    const defaultDepth = 2;

    const textByDepth = new Map<number, string>();
    function getScanText(depth: number): string {
        if (!textByDepth.has(depth)) {
            const slice = history.length > depth ? history.slice(-depth) : history;
            textByDepth.set(depth, slice.map(m => (m.content || '').toLowerCase()).join(' ') + ' ' + userMessage.toLowerCase());
        }
        return textByDepth.get(depth)!;
    }
    getScanText(defaultDepth);

    const scored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (chunk.alwaysInclude) continue;

        const isSemantic = semanticSet.has(chunk.id);
        const keywords = chunk.triggerKeywords || [];
        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);

        const kwHits = countKeywordHits(keywords, scanText);

        if (isSemantic) {
            let score = 15;
            score += kwHits * 10;
            score += (chunk.priority || 5);
            score += categoryBoost(chunk.category, scanText);
            scored.push({ chunk, score });
        } else if (kwHits > 0) {
            let score = kwHits * 10;
            score += Math.floor((chunk.priority || 5) * 0.5);
            score += categoryBoost(chunk.category, scanText);
            scored.push({ chunk, score });
        }
    }

    const grouped = applyGroupCompetition(scored);
    grouped.sort((a, b) => b.score - a.score);

    for (const { chunk } of grouped) {
        if (includedSet.has(chunk.id)) continue;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        includedSet.add(chunk.id);
        usedTokens += chunk.tokens;
    }

    if (usedTokens < tokenBudget) {
        const linkedNames = new Set<string>();
        for (const chunk of results) {
            (chunk.linkedEntities || []).forEach(e => linkedNames.add(e.toLowerCase()));
        }

        if (linkedNames.size > 0) {
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

// ─── Query-based search (LLM tool call) ───────────────────────────────────
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

    const scored = chunks
        .map((chunk) => {
            const searchText = (chunk.header + ' ' + chunk.content).toLowerCase();
            const triggerSet = new Set((chunk.triggerKeywords || []).map(k => k.toLowerCase()));
            let score = 0;

            for (const kw of queryKeywords) {
                if (triggerSet.has(kw)) score += 3;
                else if (chunk.header.toLowerCase().includes(kw)) score += 2;
                else if (searchText.includes(kw)) score += 1;
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
