import type { InventoryItem } from '../types';

/**
 * Search box grammar for the inventory list:
 *
 *   spire token       every word must match, in any order
 *   "silver pin"      exact phrase
 *   -key              exclude
 *   cat:currency      category (prefix, so cat:cur works)
 *   loc:base          location tag
 *   is:equipped       equipped only
 *
 * Plain words look at the name, keywords, notes, category and location, and
 * forgive small typos in the name and keywords. Scanned item names carry
 * markdown (**Copper Token**), so it is stripped before matching.
 */

interface Term {
    negated: boolean;
    field: 'cat' | 'loc' | 'is' | null;
    text: string;
}

const FIELD_ALIASES: Record<string, Term['field']> = {
    cat: 'cat',
    category: 'cat',
    loc: 'loc',
    location: 'loc',
    is: 'is',
};

const SCORE = {
    NAME_START: 12,
    NAME_WORD_START: 8,
    NAME_SUBSTRING: 6,
    KEYWORD: 5,
    FUZZY: 3,
    OTHER_FIELD: 2,
};

function normalize(text: string | undefined): string {
    return (text ?? '')
        .normalize('NFD')
        .replace(/\p{M}/gu, '')
        .replace(/[*_`~#]/g, '')
        .toLowerCase()
        .trim();
}

function toWords(text: string): string[] {
    return text.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function parseQuery(query: string): Term[] {
    const terms: Term[] = [];
    const pattern = /(-?)(?:([a-z]+):)?(?:"([^"]*)"?|(\S*))/gi;
    for (const match of query.matchAll(pattern)) {
        const [whole, minus, prefix, quoted, bare] = match;
        const field = prefix ? FIELD_ALIASES[prefix.toLowerCase()] : null;
        // An unknown prefix is just text containing a colon, like "Spire:".
        const raw = prefix && !field ? whole.slice(minus.length) : quoted ?? bare ?? '';
        const text = normalize(raw);
        if (text) terms.push({ negated: minus === '-', field: field ?? null, text });
    }
    return terms;
}

/** Optimal string alignment distance, stopping early once past `max`. */
function editDistance(a: string, b: string, max: number): number {
    if (Math.abs(a.length - b.length) > max) return max + 1;
    let prevPrev: number[] = [];
    let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
        const row = [i];
        let best = i;
        for (let j = 1; j <= b.length; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            let value = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + cost);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
                value = Math.min(value, prevPrev[j - 2] + 1);
            }
            row[j] = value;
            best = Math.min(best, value);
        }
        if (best > max) return max + 1;
        prevPrev = prev;
        prev = row;
    }
    return prev[b.length];
}

/**
 * Short words are never fuzzy ("key" would match "keg"), and the first letter
 * has to match, which keeps a long list from filling up with near misses.
 */
function fuzzyMatchesWord(term: string, words: string[]): boolean {
    if (term.length < 4 || /[^\p{L}\p{N}]/u.test(term)) return false;
    const max = term.length >= 8 ? 2 : 1;
    return words.some((word) => word[0] === term[0] && editDistance(term, word, max) <= max);
}

interface SearchableItem {
    name: string;
    nameWords: string[];
    keywords: string[];
    keywordWords: string[];
    notes: string;
    category: string;
    location: string;
    equipped: boolean;
}

function toSearchable(item: InventoryItem): SearchableItem {
    const name = normalize(item.name);
    const keywords = (item.keywords ?? []).map(normalize);
    return {
        name,
        nameWords: toWords(name),
        keywords,
        keywordWords: keywords.flatMap(toWords),
        notes: normalize(item.notes),
        category: normalize(item.category),
        location: normalize(item.locationTag),
        equipped: Boolean(item.equipped),
    };
}

/** How well a term matches: 0 means it does not. */
function scoreTerm(term: Term, item: SearchableItem): number {
    const { text } = term;
    if (term.field === 'cat') return item.category.startsWith(text) ? 1 : 0;
    if (term.field === 'loc') return item.location.includes(text) ? 1 : 0;
    if (term.field === 'is') return 'equipped'.startsWith(text) && item.equipped ? 1 : 0;

    if (item.name.startsWith(text)) return SCORE.NAME_START;
    if (item.nameWords.some((word) => word.startsWith(text))) return SCORE.NAME_WORD_START;
    if (item.name.includes(text)) return SCORE.NAME_SUBSTRING;
    if (item.keywords.some((keyword) => keyword.includes(text))) return SCORE.KEYWORD;
    if (fuzzyMatchesWord(text, item.nameWords) || fuzzyMatchesWord(text, item.keywordWords)) return SCORE.FUZZY;
    if (item.notes.includes(text) || item.category.startsWith(text) || item.location.includes(text)) return SCORE.OTHER_FIELD;
    if (item.equipped && 'equipped'.startsWith(text) && text.length >= 3) return SCORE.OTHER_FIELD;
    return 0;
}

const byName = (a: InventoryItem, b: InventoryItem) => a.name.localeCompare(b.name);

/** Items matching the query, best match first. A blank query returns them all, A-Z. */
export function searchInventory(items: InventoryItem[], query: string): InventoryItem[] {
    const terms = parseQuery(query);
    if (terms.length === 0) return items.slice().sort(byName);

    const scored: { item: InventoryItem; score: number }[] = [];
    for (const item of items) {
        const searchable = toSearchable(item);
        let total = 0;
        let matches = true;
        for (const term of terms) {
            const score = scoreTerm(term, searchable);
            if (term.negated ? score > 0 : score === 0) {
                matches = false;
                break;
            }
            if (!term.negated) total += score;
        }
        if (matches) scored.push({ item, score: total });
    }
    return scored
        .sort((a, b) => b.score - a.score || byName(a.item, b.item))
        .map(({ item }) => item);
}
