/**
 * WO-C §2 — SillyTavern card parser.
 *
 * Pure module: no store access, no network, no LLM, no npm dependencies.
 * Everything here is total — nothing throws. PNG walks report *why* they
 * failed (§9.5) so the wizard can tell "this isn't a PNG" apart from
 * "your image lost its metadata".
 *
 * Reads the contract in `stCardTypes.ts` and nothing else.
 */

import type {
    STCard,
    STCardSpec,
    STCharacterBook,
    STLoreEntry,
    STMacroContext,
    STParseResult,
} from './stCardTypes';

/* ------------------------------------------------------------------ *
 * PNG chunk walk (§2.1)
 * ------------------------------------------------------------------ */

/** `89 50 4E 47 0D 0A 1A 0A` */
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;

/** tEXt keywords that carry a card payload, in precedence order (§2.1: V3 wins). */
const CARD_KEYWORDS = ['ccv3', 'chara'] as const;

/**
 * Walk a PNG's chunk table for an embedded character card.
 *
 * CRC validation is deliberately skipped — cards re-saved by image tools
 * routinely carry stale CRCs and are otherwise perfectly readable.
 */
export function parsePngCard(buf: ArrayBuffer): STParseResult {
    const bytes = new Uint8Array(buf);

    if (bytes.length < PNG_SIGNATURE.length) return { ok: false, reason: 'not-png' };
    for (let i = 0; i < PNG_SIGNATURE.length; i++) {
        if (bytes[i] !== PNG_SIGNATURE[i]) return { ok: false, reason: 'not-png' };
    }

    /** keyword -> text, first occurrence wins */
    const textChunks = new Map<string, string>();
    let offset = PNG_SIGNATURE.length;

    // A chunk needs at least its 4-byte length + 4-byte type header to exist.
    while (offset + 8 <= bytes.length) {
        const length = readUint32(bytes, offset);
        const typeStart = offset + 4;
        const dataStart = typeStart + 4;
        const dataEnd = dataStart + length;

        // Declared length (plus its trailing CRC) runs past the end: corrupt
        // file. Fail fast even if a payload was already collected — a clipped
        // download is a different user problem from stripped metadata, and
        // §9.5 wants to say so rather than half-import it.
        if (dataEnd + 4 > bytes.length) return { ok: false, reason: 'truncated' };

        const type = readLatin1(bytes, typeStart, typeStart + 4);
        if (type === 'tEXt') {
            const entry = readTextChunk(bytes, dataStart, dataEnd);
            if (entry && !textChunks.has(entry.keyword)) textChunks.set(entry.keyword, entry.text);
        }
        if (type === 'IEND') break;

        offset = dataEnd + 4;
    }

    let payload: string | undefined;
    for (const keyword of CARD_KEYWORDS) {
        const found = textChunks.get(keyword);
        if (found !== undefined) {
            payload = found;
            break;
        }
    }
    if (payload === undefined) return { ok: false, reason: 'no-card-payload' };

    const json = decodeBase64Utf8(payload);
    if (json === null) return { ok: false, reason: 'malformed-payload' };

    const raw = safeJsonParse(json);
    if (raw === undefined) return { ok: false, reason: 'malformed-payload' };

    const card = normalizeCard(raw);
    if (!card) return { ok: false, reason: 'malformed-payload' };

    return { ok: true, card };
}

function readUint32(bytes: Uint8Array, offset: number): number {
    return (
        ((bytes[offset] << 24) >>> 0) +
        (bytes[offset + 1] << 16) +
        (bytes[offset + 2] << 8) +
        bytes[offset + 3]
    );
}

/** PNG text-ish fields are latin-1, one byte per code point. */
function readLatin1(bytes: Uint8Array, start: number, end: number): string {
    let out = '';
    for (let i = start; i < end; i++) out += String.fromCharCode(bytes[i]);
    return out;
}

/** tEXt data is `keyword\0text`; a chunk with no NUL separator is not usable. */
function readTextChunk(
    bytes: Uint8Array,
    dataStart: number,
    dataEnd: number,
): { keyword: string; text: string } | null {
    let separator = -1;
    for (let i = dataStart; i < dataEnd; i++) {
        if (bytes[i] === 0) {
            separator = i;
            break;
        }
    }
    if (separator === -1) return null;
    return {
        keyword: readLatin1(bytes, dataStart, separator),
        text: readLatin1(bytes, separator + 1, dataEnd),
    };
}

/**
 * base64 -> UTF-8. `atob` alone yields a *binary string*: every byte becomes a
 * code unit, so "Renée" comes back mojibake. Rebuilding a Uint8Array and running
 * it through TextDecoder is the only correct path (§2.1).
 */
function decodeBase64Utf8(base64: string): string | null {
    try {
        const binary = atob(base64.replace(/\s+/g, ''));
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i) & 0xff;
        return new TextDecoder('utf-8').decode(bytes);
    } catch {
        return null;
    }
}

/** `undefined` on failure — `null` is a legitimate JSON value. */
function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text) as unknown;
    } catch {
        return undefined;
    }
}

/* ------------------------------------------------------------------ *
 * JSON file path (§2.2)
 * ------------------------------------------------------------------ */

/** Bare `.json` card exports. `null` covers both bad JSON and "not a card". */
export function parseJsonCard(text: string): STCard | null {
    const raw = safeJsonParse(text);
    if (raw === undefined) return null;
    return normalizeCard(raw);
}

/* ------------------------------------------------------------------ *
 * Normalizer (§2.3)
 * ------------------------------------------------------------------ */

/**
 * Fold V1 (flat), V2 (`spec: 'chara_card_v2'`) and V3 (`spec: 'chara_card_v3'`)
 * into the one internal `STCard`. A bare `{ data: {...} }` with no `spec` is
 * treated as V2 — that is what half the exporters in the wild emit.
 *
 * Returns `null` when there is no usable `name`; that is what separates a card
 * from an arbitrary JSON object (an NPC-roster export array, say).
 */
export function normalizeCard(raw: unknown): STCard | null {
    if (!isRecord(raw)) return null;

    const declared = typeof raw.spec === 'string' ? raw.spec.trim().toLowerCase() : '';
    const nested = isRecord(raw.data) ? raw.data : null;

    let spec: STCardSpec;
    let src: Record<string, unknown>;
    if (declared === 'chara_card_v3') {
        spec = 'v3';
        src = nested ?? raw;
    } else if (declared === 'chara_card_v2') {
        spec = 'v2';
        src = nested ?? raw;
    } else if (nested) {
        // No spec string, but the V2/V3 envelope shape — treat as V2.
        spec = 'v2';
        src = nested;
    } else {
        spec = 'v1';
        src = raw;
    }

    // Pre-V2 TavernAI exports carry their own spellings. Consulted on flat V1
    // cards only, and only where the modern key is absent or blank.
    const read = spec === 'v1' ? readWithV1Aliases(src) : (key: string) => toText(src[key]);

    const name = read('name').trim();
    if (!name) return null;

    const card: STCard = {
        name,
        description: read('description'),
        personality: toText(src.personality),
        scenario: read('scenario'),
        first_mes: read('first_mes'),
        mes_example: read('mes_example'),
        alternate_greetings: toStringArray(src.alternate_greetings),
        system_prompt: toText(src.system_prompt),
        post_history_instructions: toText(src.post_history_instructions),
        tags: toKeyList(src.tags),
        creator: toText(src.creator),
        creator_notes: toText(src.creator_notes),
        spec,
    };

    const book = normalizeCharacterBook(src.character_book);
    if (book) card.character_book = book;

    return card;
}

/**
 * Legacy TavernAI (pre-V2) field spellings. `personality` has no counterpart —
 * old cards folded everything into `char_persona`, which lands on `description`
 * and feeds the converter's tags fallback from there.
 */
const V1_ALIASES: Record<string, string> = {
    name: 'char_name',
    description: 'char_persona',
    scenario: 'world_scenario',
    first_mes: 'char_greeting',
    mes_example: 'example_dialogue',
};

/** Modern key wins whenever it holds something; otherwise fall to the alias. */
function readWithV1Aliases(src: Record<string, unknown>): (key: string) => string {
    return (key) => {
        const modern = toText(src[key]);
        if (modern.trim() !== '') return modern;
        const alias = V1_ALIASES[key];
        return alias ? toText(src[alias]) : modern;
    };
}

function normalizeCharacterBook(raw: unknown): STCharacterBook | null {
    if (!isRecord(raw)) return null;

    const rawEntries = Array.isArray(raw.entries) ? raw.entries : [];
    const entries: STLoreEntry[] = [];
    for (const rawEntry of rawEntries) {
        const entry = normalizeLoreEntry(rawEntry);
        if (entry) entries.push(entry);
    }
    // A book with nothing injectable in it is the same as no book at all.
    if (entries.length === 0) return null;

    const book: STCharacterBook = { entries };
    const bookName = toText(raw.name).trim();
    if (bookName) book.name = bookName;
    return book;
}

/** Content-less entries are dropped: nothing to inject, nothing to recall. */
function normalizeLoreEntry(raw: unknown): STLoreEntry | null {
    if (!isRecord(raw)) return null;

    const content = toText(raw.content);
    if (!content.trim()) return null;

    // ST exports vary by exporter *and* by version; both spellings are real.
    const keys = toKeyList(raw.keys !== undefined ? raw.keys : raw.key);
    const secondaryKeys = toKeyList(
        raw.secondary_keys !== undefined ? raw.secondary_keys : raw.keysecondary,
    );
    const comment = toText(raw.comment) || toText(raw.name);

    // `enabled` wins when present; otherwise the inverted `disable` flag.
    let enabled = true;
    if (raw.enabled !== undefined) enabled = toBool(raw.enabled, true);
    else if (raw.disable !== undefined) enabled = !toBool(raw.disable, false);

    return {
        keys,
        secondary_keys: secondaryKeys,
        content,
        comment,
        constant: toBool(raw.constant, false),
        enabled,
        insertion_order: toNumber(raw.insertion_order, 0),
    };
}

/* ------------------------------------------------------------------ *
 * Macros (§2.4)
 * ------------------------------------------------------------------ */

// One regex per macro family, global + case-insensitive, tolerant of whitespace
// inside the braces (`{{ char }}` shows up in hand-edited cards).
const CHAR_MACRO = /\{\{\s*char\s*\}\}|<BOT>/gi;
const USER_MACRO = /\{\{\s*user\s*\}\}|<USER>/gi;

/**
 * Replace the two macro families this app can resolve. Every other `{{...}}`
 * macro is left verbatim — ST has dozens, and a half-resolved card reads worse
 * than an honest one.
 *
 * Function replacers, not string replacers: a name containing `$&` or `$1`
 * would otherwise be re-interpreted as a replacement pattern.
 */
export function applyCardMacros(text: string, ctx: STMacroContext): string {
    if (!text) return '';
    return text.replace(CHAR_MACRO, () => ctx.charName).replace(USER_MACRO, () => ctx.userName);
}

/* ------------------------------------------------------------------ *
 * Coercion helpers
 * ------------------------------------------------------------------ */

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Scalars coerce with `String()`; objects/arrays/null become `''`. Stringifying
 * an object would write `[object Object]` into a prompt-bound field.
 */
function toText(value: unknown): string {
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    return '';
}

/** Array of strings, non-strings dropped (not coerced — greetings are prose). */
function toStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Tag/key lists. Arrays coerce their scalar members; a plain string is a
 * comma-separated list ("fantasy, elf, tsundere"). Blanks dropped.
 */
function toKeyList(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map(toText).map((item) => item.trim()).filter((item) => item !== '');
    }
    if (typeof value === 'string') {
        return value.split(',').map((item) => item.trim()).filter((item) => item !== '');
    }
    return [];
}

/** ST sometimes ships 0/1 where the spec says boolean. */
function toBool(value: unknown, fallback: boolean): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    return fallback;
}

/** Numeric strings happen; NaN/Infinity fall back. */
function toNumber(value: unknown, fallback: number): number {
    if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : fallback;
    }
    return fallback;
}
