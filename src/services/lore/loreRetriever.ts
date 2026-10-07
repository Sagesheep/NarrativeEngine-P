import type { LoreChunk, ChatMessage } from '../../types';
import { computeIdf, fuseRRF } from '../retrieval/lexicalFusion';
import { getCachedKeywordRegex as getKeywordRegex, makeScanTextGetter } from '../retrieval/retrievalCore';
import { isFieldLabelKeyword } from './fieldLabels';

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

// ─── IDF-weighted scoring helper ──────────────────────────────────────────
function categoryBoostIdf(category: string, scanText: string): number {
    if (category === 'power_system' && (scanText.includes('combat') || scanText.includes('attack') || scanText.includes('damage') || scanText.includes('cast'))) return 1.5;
    if (category === 'faction' && (scanText.includes('politics') || scanText.includes('war') || scanText.includes('guild') || scanText.includes('order'))) return 1.5;
    if (category === 'economy' && (scanText.includes('buy') || scanText.includes('sell') || scanText.includes('cost') || scanText.includes('gold') || scanText.includes('money'))) return 1.5;
    return 0;
}

// ─── Classic algorithm (original) ──────────────────────────────────────────
function retrieveRelevantLoreClassic(
    chunks: LoreChunk[],
    _canonState: string,
    _headerIndex: string,
    userMessage: string,
    tokenBudget: number,
    recentMessages: ChatMessage[],
    semanticCandidateIds: string[] | undefined,
): LoreChunk[] {
    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    for (const chunk of chunks) {
        if (chunk.disabled) continue;
        if (chunk.alwaysInclude || chunk.ragMode === 'always') {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const semanticSet = new Set(semanticCandidateIds ?? []);

    const history = recentMessages;
    const defaultDepth = 2;

    const getScanText = makeScanTextGetter(history, userMessage);
    getScanText(defaultDepth);

    const scored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (chunk.disabled) continue;
        if (chunk.alwaysInclude || chunk.ragMode === 'always') continue;

        const isSemantic = semanticSet.has(chunk.id);
        const keywords = chunk.triggerKeywords || [];
        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);

        const skipKeyword = chunk.ragMode === 'vector';
        const kwHits = skipKeyword ? 0 : countKeywordHits(keywords, scanText);

        if (kwHits > 0) {
            const secondaryKws = chunk.secondaryKeywords || [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const regex = getKeywordRegex(kw);
                    regex.lastIndex = 0;
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }
        }

        const skipSemantic = chunk.ragMode === 'keyword';
        const isSemanticHit = isSemantic && !skipSemantic;

        if (isSemanticHit) {
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
                if (chunk.disabled) continue;
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

// ─── IDF+RRF algorithm ────────────────────────────────────────────────────
function retrieveRelevantLoreIdfRrf(
    chunks: LoreChunk[],
    userMessage: string,
    tokenBudget: number,
    recentMessages: ChatMessage[],
    semanticCandidateIds: string[] | undefined,
    recommendedIds: string[] | undefined,
): LoreChunk[] {
    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    for (const chunk of chunks) {
        if (chunk.disabled) continue;
        if (chunk.alwaysInclude || chunk.ragMode === 'always') {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const history = recentMessages;
    const defaultDepth = 2;

    const getScanText = makeScanTextGetter(history, userMessage);
    getScanText(defaultDepth);

    // Field labels (`type`, `aliases`, `appearance`…) were extracted as keywords on most
    // structured chunks; they carry no meaning and match ordinary text. Ignore them.
    const keywordsOf = (c: LoreChunk) => (c.triggerKeywords ?? []).filter(kw => !isFieldLabelKeyword(kw));
    const idf = computeIdf(chunks.map(keywordsOf));
    const chunkById = new Map(chunks.map(c => [c.id, c]));
    const semanticSet = new Set(semanticCandidateIds ?? []);

    // Pass 1: keyword ranking (IDF-weighted)
    const keywordScored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (chunk.disabled) continue;
        if (includedSet.has(chunk.id)) continue;

        const isKeywordMode = chunk.ragMode !== 'vector';

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);
        const keywords = keywordsOf(chunk);

        let idfScore = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const regex = getKeywordRegex(kw);
            regex.lastIndex = 0;
            if (regex.test(scanText)) {
                idfScore += idf[lower] ?? 1;
            }
        }

        // Vector-only chunks with keyword overlap but no semantic hit get reduced weight
        if (idfScore > 0 && !isKeywordMode) {
            if (!semanticSet.has(chunk.id)) {
                idfScore *= 0.5;
            }
        }

        if (isKeywordMode && idfScore > 0) {
            const secondaryKws = chunk.secondaryKeywords || [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const regex = getKeywordRegex(kw);
                    regex.lastIndex = 0;
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            idfScore += (chunk.priority || 5) * 0.1;
        }

        if (idfScore > 0) {
            idfScore += categoryBoostIdf(chunk.category, scanText);
            keywordScored.push({ chunk, score: idfScore });
        }
    }

    keywordScored.sort((a, b) => b.score - a.score);
    const keywordRanked = keywordScored.map(s => s.chunk.id);

    // Pass 2: embedding ranking (already cosine-ranked)
    const embeddingRanked = (semanticCandidateIds ?? []).filter(id => {
        const c = chunkById.get(id);
        return c && c.ragMode !== 'keyword' && !c.disabled;
    });

    // Pass 2b: the Context Recommender's picks — a model that read the message and the lore
    // index. A third ranked list, fused like the other two: a pick the keyword and meaning
    // searches also found rises; a pick alone competes at its rank, it does not override them.
    // On the Turn Prep probes it found the named character's own entry ("I spot Helena
    // Broadmarsh") that keyword + meaning search ranked below unrelated characters.
    const recommendedRanked = (recommendedIds ?? []).filter(id => {
        const c = chunkById.get(id);
        return c && !c.disabled;
    });

    // Pass 3: RRF fusion
    const fusedTwo = fuseRRF(keywordRanked, embeddingRanked);
    const fused = [...fusedTwo, ...recommendedRanked.filter(id => !fusedTwo.includes(id))];

    // Pass 4: fill token budget in fused order, then group competition, then linked entities
    const fusedChunks = fused
        .map(id => chunkById.get(id))
        .filter((c): c is LoreChunk => c !== undefined && !includedSet.has(c.id));

    const kwRankMap = new Map<string, number>();
    for (let i = 0; i < keywordRanked.length; i++) {
        if (!kwRankMap.has(keywordRanked[i])) kwRankMap.set(keywordRanked[i], i);
    }
    const embRankMap = new Map<string, number>();
    for (let i = 0; i < embeddingRanked.length; i++) {
        if (!embRankMap.has(embeddingRanked[i])) embRankMap.set(embeddingRanked[i], i);
    }
    const recRankMap = new Map<string, number>();
    for (let i = 0; i < recommendedRanked.length; i++) {
        if (!recRankMap.has(recommendedRanked[i])) recRankMap.set(recommendedRanked[i], i);
    }
    const scoredForGroup = fusedChunks.map(c => {
        const kwRank = kwRankMap.get(c.id);
        const embRank = embRankMap.get(c.id);
        let score = 0;
        if (kwRank !== undefined) score += 1 / (60 + kwRank + 1);
        if (embRank !== undefined) score += 1 / (60 + embRank + 1);
        const recRank = recRankMap.get(c.id);
        if (recRank !== undefined) score += 1 / (60 + recRank + 1);
        return { chunk: c, score };
    });

    const grouped = applyGroupCompetition(scoredForGroup);
    grouped.sort((a, b) => b.score - a.score);

    for (const { chunk } of grouped) {
        if (includedSet.has(chunk.id)) continue;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        includedSet.add(chunk.id);
        usedTokens += chunk.tokens;
    }

    // Linked entities cross-pull
    if (usedTokens < tokenBudget) {
        const linkedNames = new Set<string>();
        for (const chunk of results) {
            (chunk.linkedEntities || []).forEach(e => linkedNames.add(e.toLowerCase()));
        }

        if (linkedNames.size > 0) {
            const remaining = chunks.filter(c => !includedSet.has(c.id)).sort((a, b) => (b.priority || 5) - (a.priority || 5));
            for (const chunk of remaining) {
                if (chunk.disabled) continue;
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

// ─── Main Retrieval Entry Point ────────────────────────────────────────────
export function retrieveRelevantLore(
    chunks: LoreChunk[],
    _canonState: string,
    _headerIndex: string,
    userMessage: string,
    tokenBudget = 1200,
    recentMessages?: ChatMessage[],
    semanticCandidateIds?: string[],
    algorithm: 'classic' | 'idf-rrf' = 'idf-rrf',
    recommendedIds?: string[],
): LoreChunk[] {
    if (chunks.length === 0) return [];

    const messages = recentMessages ?? [];

    if (algorithm === 'classic') {
        return retrieveRelevantLoreClassic(
            chunks, _canonState, _headerIndex, userMessage,
            tokenBudget, messages, semanticCandidateIds,
        );
    }

    return retrieveRelevantLoreIdfRrf(
        chunks, userMessage, tokenBudget,
        messages, semanticCandidateIds, recommendedIds,
    );
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
        .filter(chunk => !chunk.disabled)
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
