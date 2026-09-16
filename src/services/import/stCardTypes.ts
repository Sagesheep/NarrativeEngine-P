/**
 * WO-C §2.3 — the one internal shape every SillyTavern card normalizes to.
 *
 * This file is the CONTRACT between the parser (`stCardParser.ts`) and the
 * converter (`stCardConvert.ts`). It carries no logic and imports nothing, so
 * both sides can be built and tested independently against it.
 *
 * Every field is always present: `''` / `[]` / `false` / `0` when the source
 * card omits it. `character_book` is the only optional member — a card either
 * ships an embedded lorebook or it does not.
 */

export type STCardSpec = 'v1' | 'v2' | 'v3';

export type STLoreEntry = {
    /** Primary trigger keys. ST spellings `keys` and `key` both map here. */
    keys: string[];
    /** AND-gate secondary keys. ST spellings `secondary_keys` and `keysecondary` both map here. */
    secondary_keys: string[];
    content: string;
    /** Human label. ST spellings `comment` and `name` both map here. */
    comment: string;
    /** Always-inject flag (ST `constant`). */
    constant: boolean;
    /** ST exports carry either `enabled` or its inverse `disable`; normalized to `enabled`. */
    enabled: boolean;
    insertion_order: number;
};

export type STCharacterBook = {
    name?: string;
    entries: STLoreEntry[];
};

export type STCard = {
    name: string;
    description: string;
    personality: string;
    scenario: string;
    first_mes: string;
    mes_example: string;
    alternate_greetings: string[];
    system_prompt: string;
    post_history_instructions: string;
    tags: string[];
    creator: string;
    creator_notes: string;
    character_book?: STCharacterBook;
    spec: STCardSpec;
};

/**
 * §9.5 — why a PNG yielded no card, when detectable. The parser returns one
 * of these instead of a bare `null` so the UI can say the right thing
 * ("download the original card file" vs "this is not a PNG").
 */
export type STPngFailure =
    | 'not-png'            // bad signature; may be a mislabeled WebP/JPEG
    | 'no-card-payload'    // valid PNG, no `chara`/`ccv3` tEXt chunk (metadata stripped)
    | 'malformed-payload'  // chunk found but base64/JSON/shape was bad
    | 'truncated';         // chunk table ran past the end of the buffer

export type STParseResult =
    | { ok: true; card: STCard }
    | { ok: false; reason: STPngFailure };

/** Macro substitution inputs (§2.4). */
export type STMacroContext = {
    charName: string;
    userName: string;
};
