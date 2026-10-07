/**
 * Lore field labels that the keyword extractor used to pick up as trigger keywords.
 *
 * `extractTriggerKeywords` (loreChunker.ts) keeps every capitalised word, so the labels of a
 * structured entry — `**Type:**`, `**Aliases:**`, `**Appearance:**` — became keywords on most
 * chunks (measured 2026-10-05: `aliases`/`appearance`/`disposition` on 95 of 122 chunks in one
 * campaign, `type` on 111 of 153 in another). They say nothing about what an entry is about, take
 * slots from real names in the 15-keyword cap, and match ordinary chat text. New extraction
 * strips labels; the retriever also ignores these for chunks already stored with them.
 */
export const FIELD_LABEL_KEYWORDS: ReadonlySet<string> = new Set([
    'type', 'aliases', 'alias', 'appearance', 'disposition', 'personality', 'wears', 'voice',
    'carries', 'goals', 'geography', 'status', 'date', 'stance', 'key members',
]);

export function isFieldLabelKeyword(keyword: string): boolean {
    return FIELD_LABEL_KEYWORDS.has(keyword.trim().toLowerCase());
}
