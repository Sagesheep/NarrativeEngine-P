import type { LoreChunk, LoreCategory, EndpointConfig, ProviderConfig } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';

/**
 * WO-A2 §2.2 — endpoint + lore selection for AI-Guided creation (zero LLM).
 *
 * Endpoint chain (deliberately differs from useSelectionActions.ts:180's
 * `summarizer ?? utility ?? story` — NOT an accident, do not "harmonize"):
 *   getActiveUtilityEndpoint() ?? getActiveAuxiliaryEndpoint() ??
 *   getActiveSummarizerEndpoint() ?? getActiveStoryEndpoint()
 * Cheap models first; story AI is the last resort.
 */

export type EndpointGetter = () => EndpointConfig | ProviderConfig | undefined;

export function resolveGuidedCreationEndpoint(
    getUtility: EndpointGetter,
    getAuxiliary: EndpointGetter,
    getSummarizer: EndpointGetter,
    getStory: EndpointGetter,
): EndpointConfig | ProviderConfig | undefined {
    return getUtility() ?? getAuxiliary() ?? getSummarizer() ?? getStory();
}

/**
 * The lore categories that matter for character creation. Missing categories
 * are a feature (§2.2): if `economy` or `faction` produce no chunks, the
 * corresponding slot falls back to its stock open-ended wording.
 */
const WANTED: LoreCategory[] = ['world_overview', 'power_system', 'economy', 'faction', 'culture'];

const FULL_CONTENT_TOP_N = 3;

/**
 * Excerpt budget = 20% of the model's context window, floored at 1,200 tokens.
 * A 4k context yields the 1,200 floor; a 200k context yields 40k. Passing
 * nothing (or 0) yields the floor — used by tests and the no-config fallback.
 */
export function creationExcerptBudget(maxContextTokens?: number): number {
    return Math.max(1200, Math.floor(0.2 * (maxContextTokens ?? 0)));
}

/**
 * Build the lore excerpt for the guided-creation prompt.
 *
 * Selects WANTED categories, sorts by priority (desc), then packs under
 * ~1,200 tokens (measured by `countTokens` — never by character count):
 *   - Top N (default 3) chunks by priority → full `content`
 *   - Remaining chunks → `chunk.summary` (≤100 chars, already generated)
 *
 * Returns the excerpt string AND whether any chunks were selected. The caller
 * uses the latter to implement the failure ladder (§2.4: zero lore chunks →
 * do not call).
 */
export function buildGuidedCreationLoreExcerpt(
    loreChunks: LoreChunk[],
    maxContextTokens?: number,
): { excerpt: string; chunkCount: number; tokenCount: number } {
    const TOKEN_BUDGET = creationExcerptBudget(maxContextTokens);
    const picked = (loreChunks ?? [])
        .filter(c => !c.disabled && WANTED.includes(c.category))
        .sort((a, b) => b.priority - a.priority);

    if (picked.length === 0) return { excerpt: '', chunkCount: 0, tokenCount: 0 };

    const parts: string[] = [];
    let tokens = 0;
    let count = 0;

    for (let i = 0; i < picked.length; i++) {
        const chunk = picked[i];
        // Try full content for top N; else summary (or a truncated slice).
        // If the full content alone blows the budget, fall back to the
        // summary even for a top-N chunk — the cap is hard, not advisory.
        // If there is no summary either, truncate the content to fit.
        let body = i < FULL_CONTENT_TOP_N ? chunk.content : (chunk.summary || chunk.content.slice(0, 200));
        let piece = `## ${chunk.header || 'Untitled'}\n${body}`;
        let pieceTokens = countTokens(piece);

        if (pieceTokens > TOKEN_BUDGET) {
            // Too big even alone. Try summary first, then a hard truncation.
            if (chunk.summary) {
                body = chunk.summary;
                piece = `## ${chunk.header || 'Untitled'}\n${body}`;
                pieceTokens = countTokens(piece);
            }
            if (pieceTokens > TOKEN_BUDGET) {
                // Hard truncate: ~4 chars per token is a safe upper bound.
                const maxChars = Math.max(200, TOKEN_BUDGET * 3);
                body = body.slice(0, maxChars);
                piece = `## ${chunk.header || 'Untitled'}\n${body}`;
                pieceTokens = countTokens(piece);
            }
        }

        // Always include at least the first chunk (even a truncated one)
        // so the model has something to work with.
        if (i > 0 && tokens + pieceTokens > TOKEN_BUDGET) break;

        parts.push(piece);
        tokens += pieceTokens;
        count++;
    }

    return { excerpt: parts.join('\n\n'), chunkCount: count, tokenCount: tokens };
}

// ── Header pre-pass (2026-07-23) ─────────────────────────────────────────────
// The category-filter excerpt above is depth-first (top-N full content by global
// priority), which lets a big world_overview eat the budget before faction /
// power_system get a turn. The pre-pass fixes coverage: send the AI the LIST of
// headers, let it pick the most relevant, then pack THOSE breadth-first.

/**
 * The lore chunks eligible for the creation header menu: everything except
 * `character` (individual NPC bios — `### Character` / `[CHUNK: HERO]` — are not
 * world-building and must be skipped), highest priority first.
 */
export function listCreationHeaders(loreChunks: LoreChunk[]): LoreChunk[] {
    return (loreChunks ?? [])
        .filter(c => !c.disabled && c.category !== 'character')
        .sort((a, b) => b.priority - a.priority);
}

/**
 * Breadth-first packer for a pre-selected chunk set (the header-pick path).
 * GUARANTEES every selected chunk is represented — pass 1 gives each one its
 * header + summary; pass 2 upgrades the highest-priority ones to full content
 * while budget allows. So faction / power_system never get dropped behind a
 * large world_overview.
 */
export function packSelectedChunks(chunks: LoreChunk[], budget = creationExcerptBudget()): { excerpt: string; tokenCount: number } {
    if (!chunks.length) return { excerpt: '', tokenCount: 0 };
    const ordered = [...chunks].sort((a, b) => b.priority - a.priority);

    // Pass 1 — breadth: header + summary for every chunk.
    const parts = ordered.map(c => {
        const body = c.summary || c.content.slice(0, 160);
        return { chunk: c, text: `## ${c.header || 'Untitled'}\n${body}`, full: false };
    });
    let tokens = parts.reduce((sum, p) => sum + countTokens(p.text), 0);

    // If even the summaries overflow, drop lowest-priority until we fit.
    while (tokens > budget && parts.length > 1) {
        const removed = parts.pop()!;
        tokens -= countTokens(removed.text);
    }

    // Pass 2 — depth: upgrade top chunks summary → full content while budget allows.
    for (const p of parts) {
        const fullText = `## ${p.chunk.header || 'Untitled'}\n${p.chunk.content}`;
        const delta = countTokens(fullText) - countTokens(p.text);
        if (delta > 0 && tokens + delta <= budget) {
            p.text = fullText;
            p.full = true;
            tokens += delta;
        }
    }

    return { excerpt: parts.map(p => p.text).join('\n\n'), tokenCount: tokens };
}