/**
 * retrievalCore.ts
 *
 * Shared scaffolding for the chunk-based retrievers (loreRetriever, rulesRetriever),
 * which both follow the same shape:
 *
 *   always-include pass → depth-cached scan text → IDF keyword scoring →
 *   RRF fusion with the embedding ranker → token-budget fill
 *
 * Only the genuinely-identical mechanics live here. Domain-specific scoring (lore's
 * group competition / category boost / linked-entity cross-pull, rules' activation
 * modes / manifest) stays in each retriever. Extracting this shell means a fix to the
 * scan-text cache, keyword matching, or budget fill lands once instead of twice.
 *
 * NOTE: archiveMemory.ts is intentionally NOT routed through here — it ranks
 * ArchiveIndexEntry strength-matrices with POV/event/planner/divergence signals, a
 * different shape. It already shares `computeIdf`/`fuseRRF` from lexicalFusion.ts.
 */

import type { ChatMessage } from '../../types';

// ─── Keyword regex cache ───────────────────────────────────────────────────
// Anchored (\b…\b), case-insensitive. `.test()` callers reset lastIndex, so the
// global flag does not change match results vs a non-global regex.
const regexCache = new Map<string, RegExp>();

export function getCachedKeywordRegex(keyword: string): RegExp {
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

/** True if `keyword` occurs as a whole word in `text` (case-insensitive). */
export function keywordMatches(keyword: string, text: string): boolean {
    const regex = getCachedKeywordRegex(keyword);
    regex.lastIndex = 0;
    return regex.test(text);
}

// ─── Depth-cached scan text ─────────────────────────────────────────────────
// Builds (and memoizes per depth) the lowercased concatenation of the last
// `depth` messages plus the user message. Identical in lore + rules.
export function makeScanTextGetter(
    history: ChatMessage[],
    userMessage: string,
): (depth: number) => string {
    const cache = new Map<number, string>();
    return (depth: number): string => {
        let text = cache.get(depth);
        if (text === undefined) {
            const slice = history.length > depth ? history.slice(-depth) : history;
            text = slice.map(m => (m.content || '').toLowerCase()).join(' ')
                + ' ' + userMessage.toLowerCase();
            cache.set(depth, text);
        }
        return text;
    };
}

// ─── Token-budget fill ──────────────────────────────────────────────────────
// Walk `ordered` items, adding each whose token cost fits the remaining budget.
// Mutates `results`, `includedSet`, and returns the new usedTokens total.
export function fillByTokenBudget<T>(
    ordered: T[],
    opts: {
        idOf: (item: T) => string;
        tokensOf: (item: T) => number;
        budget: number;
        usedTokens: number;
        includedSet: Set<string>;
        results: T[];
    },
): number {
    let { usedTokens } = opts;
    const { idOf, tokensOf, budget, includedSet, results } = opts;
    for (const item of ordered) {
        const id = idOf(item);
        if (includedSet.has(id)) continue;
        const tokens = tokensOf(item);
        if (usedTokens + tokens > budget) continue;
        results.push(item);
        includedSet.add(id);
        usedTokens += tokens;
    }
    return usedTokens;
}
