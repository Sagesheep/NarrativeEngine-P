import type { LoreChunk, ChatMessage, RuleChunkMeta } from '../../types';
import { computeIdf, fuseRRF } from '../retrieval/lexicalFusion';
import { makeScanTextGetter } from '../retrieval/retrievalCore';

function stripChunkPrefix(header: string): string {
    return header.replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
}

// ─── Classic algorithm (original) ──────────────────────────────────────────
function retrieveRelevantRulesClassic(
    chunks: LoreChunk[],
    chunkMeta: Record<string, RuleChunkMeta> | undefined,
    userMessage: string,
    tokenBudget: number,
    recentMessages: ChatMessage[],
    semanticRuleIds: string[] | undefined,
): { selected: LoreChunk[]; manifest: string } {
    const meta = chunkMeta ?? {};
    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    for (const chunk of chunks) {
        const cm = meta[chunk.id];
        const isAlways = cm ? cm.activationModes.includes('always') : chunk.alwaysInclude;
        if (isAlways) {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const history = recentMessages;
    const defaultDepth = 2;
    const getScanText = makeScanTextGetter(history, userMessage);

    const scored: { chunk: LoreChunk; score: number }[] = [];
    const semanticSet = new Set(semanticRuleIds || []);

    for (const chunk of chunks) {
        if (includedSet.has(chunk.id)) continue;

        const cm = meta[chunk.id];
        const modes = cm ? cm.activationModes : ['vector'];
        const isKeywordMode = modes.includes('keyword');
        const isVectorMode = modes.includes('vector');

        if (!isKeywordMode && !isVectorMode) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);
        const keywords = cm?.triggerKeywords ?? chunk.triggerKeywords ?? [];

        let matchCount = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
            if (regex.test(scanText)) matchCount++;
        }

        let score = 0;
        let keywordMatched = false;

        if (isKeywordMode && matchCount > 0) {
            const secondaryKws = cm?.secondaryKeywords ?? chunk.secondaryKeywords ?? [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const lower = kw.toLowerCase();
                    const regex = new RegExp(`\\b${lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            score += matchCount * 10;
            score += (cm?.priority ?? chunk.priority ?? 5);
            keywordMatched = true;
        }

        if (isVectorMode) {
            const isSemanticHit = semanticSet.has(chunk.id);
            if (isSemanticHit) {
                score += 25 + (cm?.priority ?? chunk.priority ?? 5);
                if (keywordMatched) score += 20;
            } else if (matchCount > 0 && !isKeywordMode) {
                score += matchCount * 10;
                score += (cm?.priority ?? chunk.priority ?? 5);
            }
        }

        if (score > 0) {
            scored.push({ chunk, score });
        }
    }

    scored.sort((a, b) => b.score - a.score);

    for (const { chunk } of scored) {
        if (includedSet.has(chunk.id)) continue;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        includedSet.add(chunk.id);
        usedTokens += chunk.tokens;
    }

    const unretrievedHeaders = chunks
        .filter(c => !includedSet.has(c.id))
        .map(c => `## ${stripChunkPrefix(c.header)}`)
        .join('\n');
    const manifest = unretrievedHeaders.length > 0
        ? `[Available rule sections not loaded this turn]\n${unretrievedHeaders}\n[End section list]`
        : '';

    return { selected: results, manifest };
}

// ─── IDF+RRF algorithm ────────────────────────────────────────────────────
function retrieveRelevantRulesIdfRrf(
    chunks: LoreChunk[],
    chunkMeta: Record<string, RuleChunkMeta> | undefined,
    userMessage: string,
    tokenBudget: number,
    recentMessages: ChatMessage[],
    semanticRuleIds: string[] | undefined,
): { selected: LoreChunk[]; manifest: string } {
    const meta = chunkMeta ?? {};
    const results: LoreChunk[] = [];
    const includedSet = new Set<string>();
    let usedTokens = 0;

    for (const chunk of chunks) {
        const cm = meta[chunk.id];
        const isAlways = cm ? cm.activationModes.includes('always') : chunk.alwaysInclude;
        if (isAlways) {
            results.push(chunk);
            includedSet.add(chunk.id);
            usedTokens += chunk.tokens;
        }
    }

    const history = recentMessages;
    const defaultDepth = 2;
    const getScanText = makeScanTextGetter(history, userMessage);

    const idf = computeIdf(chunks.map(c => (meta[c.id]?.triggerKeywords ?? c.triggerKeywords ?? [])));
    const chunkById = new Map(chunks.map(c => [c.id, c]));
    const semanticSet = new Set(semanticRuleIds ?? []);

    // Pass 1: keyword ranking (IDF-weighted)
    const keywordScored: { chunk: LoreChunk; score: number }[] = [];

    for (const chunk of chunks) {
        if (includedSet.has(chunk.id)) continue;

        const cm = meta[chunk.id];
        const modes = cm ? cm.activationModes : ['vector'];
        const isKeywordMode = modes.includes('keyword');
        const isVectorMode = modes.includes('vector');

        if (!isKeywordMode && !isVectorMode) continue;

        const depth = chunk.scanDepth || defaultDepth;
        const scanText = getScanText(depth);
        const keywords = cm?.triggerKeywords ?? chunk.triggerKeywords ?? [];

        let idfScore = 0;
        for (const kw of keywords) {
            const lower = kw.toLowerCase();
            const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const regex = new RegExp(`\\b${escaped}\\b`, 'i');
            if (regex.test(scanText)) {
                idfScore += idf[lower] ?? 1;
            }
        }

        if (isKeywordMode && idfScore > 0) {
            const secondaryKws = cm?.secondaryKeywords ?? chunk.secondaryKeywords ?? [];
            if (secondaryKws.length > 0) {
                const secondaryMatch = secondaryKws.some(kw => {
                    const lower = kw.toLowerCase();
                    const escaped = lower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const regex = new RegExp(`\\b${escaped}\\b`, 'i');
                    return regex.test(scanText);
                });
                if (!secondaryMatch) continue;
            }

            idfScore += (cm?.priority ?? chunk.priority ?? 5) * 0.1;
        }

        if (!isKeywordMode && idfScore > 0) {
            if (!semanticSet.has(chunk.id)) {
                idfScore *= 0.5;
            }
        }

        if (idfScore > 0) {
            keywordScored.push({ chunk, score: idfScore });
        }
    }

    keywordScored.sort((a, b) => b.score - a.score);
    const keywordRanked = keywordScored.map(s => s.chunk.id);

    // Pass 2: embedding ranking (already cosine-ranked)
    const embeddingRanked = (semanticRuleIds ?? []).filter(id => {
        const chunk = chunkById.get(id);
        if (!chunk) return false;
        const cm = meta[chunk.id];
        const modes = cm ? cm.activationModes : ['vector'];
        return modes.includes('vector');
    });

    // Pass 3: RRF fusion
    const fused = fuseRRF(keywordRanked, embeddingRanked);

    for (const id of fused) {
        const chunk = chunkById.get(id);
        if (!chunk || includedSet.has(chunk.id)) continue;
        if (usedTokens + chunk.tokens > tokenBudget) continue;
        results.push(chunk);
        includedSet.add(chunk.id);
        usedTokens += chunk.tokens;
    }

    const unretrievedHeaders = chunks
        .filter(c => !includedSet.has(c.id))
        .map(c => `## ${stripChunkPrefix(c.header)}`)
        .join('\n');
    const manifest = unretrievedHeaders.length > 0
        ? `[Available rule sections not loaded this turn]\n${unretrievedHeaders}\n[End section list]`
        : '';

    return { selected: results, manifest };
}

// ─── Main Retrieval Entry Point ────────────────────────────────────────────
export function retrieveRelevantRules(
    chunks: LoreChunk[],
    chunkMeta: Record<string, RuleChunkMeta> | undefined,
    userMessage: string,
    tokenBudget: number,
    recentMessages?: ChatMessage[],
    semanticRuleIds?: string[],
    algorithm: 'classic' | 'idf-rrf' = 'idf-rrf',
): { selected: LoreChunk[]; manifest: string } {
    if (chunks.length === 0) return { selected: [], manifest: '' };

    const messages = recentMessages ?? [];

    if (algorithm === 'classic') {
        return retrieveRelevantRulesClassic(
            chunks, chunkMeta, userMessage, tokenBudget,
            messages, semanticRuleIds,
        );
    }

    return retrieveRelevantRulesIdfRrf(
        chunks, chunkMeta, userMessage, tokenBudget,
        messages, semanticRuleIds,
    );
}
