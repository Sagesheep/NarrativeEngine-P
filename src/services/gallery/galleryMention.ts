import type { GalleryEntry } from '../../types';

/**
 * `@mention` picking and local suggestion for the gallery.
 *
 * This is deliberately NOT a retrieval system. Everything here is a string
 * match over titles the app already holds in memory — no LLM call, no
 * embedding, no pass added to the turn's gather phase. The gallery does not
 * compete with lore, vector recall, the NPC recommender, rules or the location
 * ledger for the payload budget, because nothing here reaches the payload
 * unless the player picks it.
 *
 * Suggestions follow the same rule the NPC detector already follows: notice it,
 * offer it, never add it (see `NpcSuggestion` in types/character.ts).
 */

/** How far back from the caret an `@` token may start. Titles have spaces, so
 *  the query can span them — but not unboundedly, or a stray `@` early in a
 *  paragraph would swallow the rest of the sentence. */
const MAX_QUERY_LEN = 40;

export type MentionQuery = {
    /** Text typed after the `@`, may contain spaces. */
    query: string;
    /** Index of the `@` itself. */
    start: number;
    /** Caret position — end of the token. */
    end: number;
};

/**
 * Find the `@…` token the caret is currently inside, if any.
 *
 * Returns null when the caret is not in a token, when the `@` is glued to a
 * preceding word (so `user@example.com` is left alone), or when the token has
 * run past the length cap.
 */
export function parseMentionQuery(text: string, caret: number): MentionQuery | null {
    if (caret < 1 || caret > text.length) return null;

    const lowerBound = Math.max(0, caret - MAX_QUERY_LEN - 1);
    let at = -1;
    for (let i = caret - 1; i >= lowerBound; i--) {
        const ch = text[i];
        if (ch === '@') { at = i; break; }
        // A newline ends the search: a mention never spans lines.
        if (ch === '\n') return null;
    }
    if (at === -1) return null;

    // `@` must start a word — preceded by start-of-text or whitespace. Keeps
    // email addresses and `foo@bar` out of the picker.
    const before = at > 0 ? text[at - 1] : '';
    if (before && !/\s/.test(before)) return null;

    return { query: text.slice(at + 1, caret), start: at, end: caret };
}

function normalise(s: string): string {
    return s.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

/**
 * Rank gallery entries against a typed query.
 *
 * Prefix matches beat interior matches, shorter titles beat longer ones, and an
 * empty query lists everything (so a bare `@` opens the picker). Only entries
 * with a caption are offered — an undescribed image has nothing to hand the GM.
 */
export function matchEntries(entries: GalleryEntry[], query: string, limit = 6): GalleryEntry[] {
    const usable = entries.filter(e => e.caption.trim());
    const q = normalise(query);
    if (!q) return usable.slice(0, limit);

    const scored: { entry: GalleryEntry; score: number }[] = [];
    for (const entry of usable) {
        const title = normalise(entry.title);
        const idx = title.indexOf(q);
        if (idx === -1) continue;
        // Lower is better: prefix (0) wins, then earliest position, then brevity.
        scored.push({ entry, score: idx * 100 + title.length });
    }
    scored.sort((a, b) => a.score - b.score);
    return scored.slice(0, limit).map(s => s.entry);
}

/** Remove the `@…` token from the message once its entry has been picked. */
export function stripMention(text: string, mention: MentionQuery): { text: string; caret: number } {
    const before = text.slice(0, mention.start);
    const after = text.slice(mention.end);
    // Collapse the space the token leaves behind so the prose reads cleanly.
    const joined = (before + after).replace(/[ \t]{2,}/g, ' ');
    return { text: joined, caret: before.length };
}

/**
 * Entries whose title is mentioned in the message the player is writing.
 *
 * A local substring match, nothing more — this drives an offer, never an
 * injection. Single-word titles must match on a word boundary so "key" does
 * not fire on "monkey"; multi-word titles match as a phrase.
 */
export function suggestFromText(
    text: string,
    entries: GalleryEntry[],
    opts?: { dismissed?: Set<string>; armed?: Set<string>; limit?: number },
): GalleryEntry[] {
    const body = normalise(text);
    if (body.length < 3) return [];

    const dismissed = opts?.dismissed ?? new Set<string>();
    const armed = opts?.armed ?? new Set<string>();
    const hits: GalleryEntry[] = [];

    for (const entry of entries) {
        if (!entry.caption.trim()) continue;
        if (dismissed.has(entry.id) || armed.has(entry.id)) continue;

        const title = normalise(entry.title);
        // Very short titles are too noisy to match on.
        if (title.length < 4) continue;

        const pattern = new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
        if (pattern.test(body)) hits.push(entry);
    }
    return hits.slice(0, opts?.limit ?? 2);
}
