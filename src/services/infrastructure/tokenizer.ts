import { getEncoding, type Tiktoken } from 'js-tiktoken';

/**
 * Accurate token count using the cl100k_base BPE tokenizer — far more accurate
 * than a length heuristic for DeepSeek, OpenAI and Anthropic models.
 *
 * Two things here are about cost, not correctness:
 *
 * 1. The encoder is built on first use, not at import. Constructing it takes
 *    ~96 ms and pulls in the rank table, which is the largest chunk in the
 *    build. This module is imported by the store, so every consumer used to
 *    pay that at startup whether or not it ever counted a token.
 *
 * 2. Results are memoised on the exact input string. `countTokens` is pure, so
 *    the cache is invisible to callers. It matters because the payload builder
 *    re-counts the same unchanged history window on every turn, and
 *    `trimToBudget` binary-searches by re-counting prefixes of the same block.
 */

let encoder: Tiktoken | null = null;

function getEncoder(): Tiktoken {
    if (!encoder) encoder = getEncoding('cl100k_base');
    return encoder;
}

// Bounded so a long session cannot grow it without limit. The keys are strings
// the caller already holds (message content, rendered blocks), so entries cost
// little beyond the count itself.
const MAX_CACHE_ENTRIES = 2000;
const cache = new Map<string, number>();

export function countTokens(text: string): number {
    if (!text) return 0;

    const hit = cache.get(text);
    if (hit !== undefined) {
        // Refresh recency: `trimToBudget` floods the cache with one-off prefix
        // slices, and without this they would evict the history window that
        // actually repeats turn over turn.
        cache.delete(text);
        cache.set(text, hit);
        return hit;
    }

    const count = getEncoder().encode(text).length;

    if (cache.size >= MAX_CACHE_ENTRIES) {
        // Map iterates in insertion order, so the first key is the coldest.
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(text, count);
    return count;
}

/** Test-only: drop the memo so a test can observe uncached behaviour. */
export function __resetTokenCacheForTests(): void {
    cache.clear();
}
