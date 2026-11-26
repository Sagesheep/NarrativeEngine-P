/**
 * loreAiIndex.ts
 * --------------
 * The lore index the Context Recommender reads each turn: one line per entry, which the
 * model uses to pick relevant lore. Two opt-in improvements, both switched on the Lore tab:
 *
 * - AI index lines (`aiLoreIndex`): a utility model writes one line per entry saying what it
 *   covers and when it matters, in place of the heuristic `summary` (often just a field line
 *   such as "**Type:** Faction"). Written once by "Run AI indexing" (loreAiIndexRunner.ts) and
 *   stored on the chunk with a hash of its header + content; an edit changes the hash, so the
 *   line counts as stale and the entry falls back to its `summary` until it is indexed again.
 * - Shortlist (`aiLoreShortlist`): when the full index is over a token limit, only the top
 *   `LORE_SHORTLIST_SIZE` entries by keyword match go to the recommender. Entries left out can
 *   still be found by keyword and meaning search in lore selection (loreRetriever.ts).
 *
 * Pure: no store, network or model imports (the settings store imports this module).
 */

import type { LoreChunk } from '../../types';

export const LORE_SHORTLIST_SIZE = 50;
export const DEFAULT_LORE_SHORTLIST_TOKENS = 4000;
export const MIN_LORE_SHORTLIST_TOKENS = 500;
export const MAX_LORE_SHORTLIST_TOKENS = 100_000;
/** Longest AI index line kept. Longer replies are cut at a word boundary. */
export const AI_SUMMARY_MAX_CHARS = 220;

export function normalizeLoreShortlistTokens(raw: unknown): number {
    const n = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : DEFAULT_LORE_SHORTLIST_TOKENS;
    return Math.min(MAX_LORE_SHORTLIST_TOKENS, Math.max(MIN_LORE_SHORTLIST_TOKENS, n));
}

/** FNV-1a over header + content, as 8 hex digits. Identifies the text an AI line was written from. */
export function loreIndexHash(chunk: Pick<LoreChunk, 'header' | 'content'>): string {
    const text = `${chunk.header}\n${chunk.content}`;
    let h = 0x811c9dc5;
    for (let i = 0; i < text.length; i++) {
        h ^= text.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, '0');
}

export function hasFreshAiSummary(chunk: LoreChunk): boolean {
    return !!chunk.aiSummary && chunk.aiSummaryHash === loreIndexHash(chunk);
}

/** Entries the recommender's index lists: not always-on (those are always sent), not disabled. */
export function isIndexedLore(chunk: LoreChunk): boolean {
    return !chunk.alwaysInclude && !chunk.disabled;
}

/** Entries "Run AI indexing" would write a line for: listed in the index, with no fresh line. */
export function chunksNeedingAiIndex(chunks: LoreChunk[]): LoreChunk[] {
    return chunks.filter(c => isIndexedLore(c) && !hasFreshAiSummary(c));
}

export type LoreIndexOptions = {
    /** Read fresh AI lines in place of `summary`. */
    useAiSummaries?: boolean;
    /** Shortlist when the full index is over this many tokens. Absent = never shortlist. */
    shortlistTokenLimit?: number;
    /** Lore ids best match first (keyword ranking). Called only when the shortlist applies. */
    rankIds?: () => string[];
    /** Token counter for the index text. */
    countTokens?: (text: string) => number;
};

export type LoreIndex = {
    text: string;
    /** Entries listed in `text`. */
    listed: number;
    /** Entries eligible for the index (before any shortlist). */
    total: number;
    shortlisted: boolean;
};

function oneLine(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

export function loreIndexLine(chunk: LoreChunk, useAiSummaries: boolean): string {
    const desc = useAiSummaries && hasFreshAiSummary(chunk) ? chunk.aiSummary : chunk.summary;
    const sum = desc ? ` — ${oneLine(desc)}` : '';
    return `- ID:${chunk.id} | ${chunk.category} | ${chunk.header}${sum}`;
}

/**
 * The top `size` eligible entries in `rankedIds` order. When fewer rank, the rest are filled
 * by priority (highest first), then in stored order, so the list is always `size` long when
 * there are that many entries.
 */
export function shortlistLore(chunks: LoreChunk[], rankedIds: string[], size = LORE_SHORTLIST_SIZE): LoreChunk[] {
    const byId = new Map(chunks.map(c => [c.id, c]));
    const picked: LoreChunk[] = [];
    const seen = new Set<string>();
    for (const id of rankedIds) {
        if (picked.length >= size) break;
        const c = byId.get(id);
        if (!c || seen.has(id)) continue;
        seen.add(id);
        picked.push(c);
    }
    if (picked.length < size) {
        const rest = chunks
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => !seen.has(c.id))
            .sort((a, b) => (b.c.priority || 5) - (a.c.priority || 5) || a.i - b.i);
        for (const { c } of rest) {
            if (picked.length >= size) break;
            picked.push(c);
        }
    }
    return picked;
}

export function buildLoreIndexText(allChunks: LoreChunk[], options: LoreIndexOptions = {}): LoreIndex {
    const eligible = allChunks.filter(isIndexedLore);
    if (eligible.length === 0) return { text: 'No lore chunks available.', listed: 0, total: 0, shortlisted: false };
    const useAi = !!options.useAiSummaries;
    const render = (chunks: LoreChunk[]) => chunks.map(c => loreIndexLine(c, useAi)).join('\n');
    const full = render(eligible);
    const limit = options.shortlistTokenLimit;
    if (limit === undefined || eligible.length <= LORE_SHORTLIST_SIZE || !options.countTokens || !options.rankIds) {
        return { text: full, listed: eligible.length, total: eligible.length, shortlisted: false };
    }
    if (options.countTokens(full) <= limit) {
        return { text: full, listed: eligible.length, total: eligible.length, shortlisted: false };
    }
    const picked = shortlistLore(eligible, options.rankIds());
    return { text: render(picked), listed: picked.length, total: eligible.length, shortlisted: true };
}

// ─── AI line generation: prompt + parse (the call itself is in loreAiIndexRunner.ts) ───

export const AI_INDEX_CONTENT_CHARS = 1200;

export function buildAiIndexPrompt(batch: LoreChunk[]): string {
    const entries = batch.map(c => {
        const preview = oneLine(c.content.slice(0, AI_INDEX_CONTENT_CHARS));
        return `---\nID: ${c.id}\nCATEGORY: ${c.category}\nHEADER: ${c.header}\nCONTENT: ${preview}`;
    }).join('\n');

    return `You are writing index lines for a tabletop RPG lore library. Each turn, another model reads ONLY these lines (not the full entries) to decide which entries the story needs, so each line must tell it what the entry is and when it matters.

For each entry write ONE line, at most 30 words, in this shape:
<what it is, with its key names>. Relevant when: <the places, people, events or topics that should bring it up>.

Use names and terms from the entry itself. Do not invent facts. No markdown.

Return ONLY a JSON object mapping each ID to its line. No prose, no code fences.
Format: {"<id>": "<line>", ...}

LORE ENTRIES:
${entries}
---

Respond with the JSON object now:`;
}

export function cleanAiSummary(raw: string): string | undefined {
    const text = oneLine(raw.replace(/[*_`#]/g, ''));
    if (text.length < 8) return undefined;
    if (text.length <= AI_SUMMARY_MAX_CHARS) return text;
    const cut = text.slice(0, AI_SUMMARY_MAX_CHARS);
    const space = cut.lastIndexOf(' ');
    return `${(space > AI_SUMMARY_MAX_CHARS * 0.6 ? cut.slice(0, space) : cut).trim()}…`;
}

/** Map of chunk id → cleaned line, from a parsed model reply. Unknown ids and non-strings are dropped. */
export function readAiIndexReply(parsed: unknown, batch: LoreChunk[]): Map<string, string> {
    const out = new Map<string, string>();
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return out;
    const ids = new Set(batch.map(c => c.id));
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (!ids.has(id) || typeof value !== 'string') continue;
        const line = cleanAiSummary(value);
        if (line) out.set(id, line);
    }
    return out;
}

/**
 * Apply written lines to the current chunks. A line is kept only if the chunk still has the
 * text it was written from (`hashes`); an entry edited or deleted mid-run is left alone.
 * Returns the same array when nothing changed.
 */
export function applyAiSummaries(
    current: LoreChunk[],
    lines: Map<string, string>,
    hashes: Map<string, string>,
): LoreChunk[] {
    let changed = false;
    const next = current.map(c => {
        const line = lines.get(c.id);
        const hash = hashes.get(c.id);
        if (!line || !hash || loreIndexHash(c) !== hash) return c;
        changed = true;
        return { ...c, aiSummary: line, aiSummaryHash: hash };
    });
    return changed ? next : current;
}
