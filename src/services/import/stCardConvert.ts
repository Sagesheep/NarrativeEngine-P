/**
 * WO-C §3.1–§3.3 + §10.2 — SillyTavern card → app-native records.
 *
 * Pure module. No store access, no LLM calls, no network, no `Date.now()`
 * except for the opening `ChatMessage` timestamp (§3.3 mandates it). Every
 * entry point takes an injectable `makeId` so tests are deterministic.
 *
 * Split of responsibilities (the locked decision, §8): bounded text lands on
 * the NPC entry (it re-enters the prompt every active turn), long-form bulk
 * goes to `LoreChunk`s where semantic recall serves it on demand.
 *
 * This module deliberately does NOT import from `stCardParser.ts` — the
 * contract in `stCardTypes.ts` is the only shared surface, and the macro pass
 * (§2.4) is re-implemented privately below so converter and parser can be
 * built and tested independently.
 */

import type {
    STCard,
    STCharacterBook,
    STLoreEntry,
} from './stCardTypes';
import type {
    NPCEntry,
    LoreChunk,
    ChatMessage,
    PlayerCharacter,
    CharacterCreationDraft,
    CharacterProfile,
    CharacterProfileState,
    GameContext,
} from '../../types';
import { DEFAULT_VISUAL_PROFILE } from '../../types';
import { assemblePlayerCharacter } from '../character/commitCharacterDraft';
import { countTokens } from '../infrastructure/tokenizer';
import { uid } from '../../utils/uid';

// ─── Caps (§3.1) ─────────────────────────────────────────────────────────────

/** `NPCEntry.personality` — injected every active turn. */
const PERSONALITY_CAP = 400;
/** `NPCEntry.storyRelevance` from a prose `description`. */
const STORY_CAP = 300;
/** `storyRelevance` fallback slice from `creator_notes` on a W++ card. */
const NOTES_FALLBACK_CAP = 200;
/** `NPCEntry.exampleOutput`, cut at `<START>` block boundaries. */
const EXAMPLE_CAP = 800;
/** §9.6.6 — at most this many `constant` lorebook entries stay always-injected. */
const CONSTANT_KEEP = 3;
/** Every imported chunk carries this scan depth (§10.8). */
const SCAN_DEPTH = 3;

const DEFAULT_HP = { current: 20, max: 20 };

// ─── Macros (§2.4, re-implemented privately) ─────────────────────────────────

/**
 * `{{char}}` / `<BOT>` → the card's name, `{{user}}` / `<USER>` → the player's
 * name, both case-insensitive. Unknown `{{...}}` macros are left alone — they
 * are the card author's, not ours to guess at.
 */
function applyMacros(text: string, charName: string, userName: string): string {
    if (!text) return '';
    return text
        .replace(/\{\{\s*char\s*\}\}/gi, charName)
        .replace(/<BOT>/gi, charName)
        .replace(/\{\{\s*user\s*\}\}/gi, userName)
        .replace(/<USER>/gi, userName);
}

// ─── Text shaping helpers (exported for tests) ───────────────────────────────

/**
 * §3.1 W++ guard. Non-prose card text comes as W++
 * (`[Character("Rin"){Age("17")}]`) or bare `Key("value")` runs. Cheap test:
 * the trimmed text starts with `[`, or a `word("`/`word('` appears in the
 * first 200 characters.
 */
export function isStructuredText(text: string): boolean {
    const t = (text || '').trim();
    if (!t) return false;
    if (t.startsWith('[')) return true;
    return /\w+\(["']/.test(t.slice(0, 200));
}

/** Pull the values out of one `Key("a","b")` / `Key(a + b)` group. */
function splitWppValues(raw: string): string[] {
    const quoted = raw.match(/"[^"]*"|'[^']*'/g);
    if (quoted && quoted.length > 0) {
        return quoted.map(s => s.slice(1, -1).trim()).filter(Boolean);
    }
    return raw
        .split(/[,+]/)
        .map(s => s.trim().replace(/^["']|["']$/g, '').trim())
        .filter(Boolean);
}

/**
 * §9.6.4(b) — W++/structured personality becomes readable trait lines, never
 * raw brackets and never discarded as garbage.
 *
 * `[Character("Rin"){Age("17") Likes("tea","rain")}]`
 *   → `Age: 17`
 *     `Likes: tea, rain`
 *
 * The wrapper key (the one immediately followed by `{`) is dropped — it names
 * the character, which we already have. If nothing parses, the text is
 * de-bracketed rather than returned raw, so the guarantee "no bracket garbage
 * reaches an injected field" holds unconditionally.
 */
export function wppToTraitLines(text: string): string {
    const src = (text || '').trim();
    if (!src) return '';

    const lines: string[] = [];
    const re = /([A-Za-z_][A-Za-z0-9_\- ]*)\s*\(([^()]*)\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
        const key = m[1].trim();
        if (!key) continue;
        // A key followed by `{` is the W++ wrapper, e.g. `Character("Rin"){...}`.
        const after = src.slice(m.index + m[0].length).match(/^\s*\{/);
        if (after) continue;
        const values = splitWppValues(m[2]);
        if (values.length === 0) continue;
        lines.push(`${key}: ${values.join(', ')}`);
    }

    if (lines.length > 0) return lines.join('\n');

    // Nothing matched the W++ grammar — strip the structural punctuation so the
    // field still reads as text.
    return src
        .replace(/[[\]{}"']/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\s*\n\s*/g, '\n')
        .trim();
}

/** Cap at `max`, preferring a newline / comma / word boundary over a mid-word cut. */
function capChars(text: string, max: number): string {
    const t = (text || '').trim();
    if (t.length <= max) return t;
    const w = t.slice(0, max);
    const cut = Math.max(w.lastIndexOf('\n'), w.lastIndexOf(', '), w.lastIndexOf(' '));
    return (cut > 0 ? w.slice(0, cut) : w).trim();
}

/**
 * First ~`max` characters, cut at a sentence boundary (§3.1). Falls back to a
 * word boundary when the window holds no sentence terminator. Never exceeds
 * `max`.
 */
export function cutAtSentence(text: string, max: number): string {
    const t = (text || '').trim();
    if (t.length <= max) return t;
    const window = t.slice(0, max);
    const m = window.match(/^[\s\S]*[.!?…]["')\]]?(?=\s|$)/);
    if (m && m[0].trim()) return m[0].trim();
    const lastSpace = window.lastIndexOf(' ');
    return (lastSpace > 0 ? window.slice(0, lastSpace) : window).trim();
}

/** Keep whole lines up to `max`. Only a single over-long line is cut mid-line. */
function cutAtLine(text: string, max: number): string {
    const t = text.trim();
    if (t.length <= max) return t;
    const lines = t.split('\n');
    const kept: string[] = [];
    let len = 0;
    for (const line of lines) {
        const add = kept.length === 0 ? line.length : line.length + 1;
        if (len + add > max) break;
        kept.push(line);
        len += add;
    }
    if (kept.length === 0) return capChars(lines[0], max);
    return kept.join('\n').trim();
}

/**
 * §3.1 — `mes_example` cut at a `<START>` boundary, keeping whole example
 * blocks up to `max` and stripping the `<START>` markers themselves. Never
 * cuts mid-line; a single example block longer than the cap degrades to a
 * line-boundary cut (there is no block boundary left to use).
 */
export function cutExampleAtStart(text: string, max: number): string {
    const raw = (text || '').trim();
    if (!raw) return '';
    const blocks = raw.split(/<\s*START\s*>/i).map(b => b.trim()).filter(Boolean);
    if (blocks.length === 0) return '';

    const kept: string[] = [];
    let len = 0;
    for (const block of blocks) {
        const add = kept.length === 0 ? block.length : block.length + 2;
        if (len + add > max) break;
        kept.push(block);
        len += add;
    }
    if (kept.length > 0) return kept.join('\n\n');
    return cutAtLine(blocks[0], max);
}

// ─── Personality precedence (§9.6.4) ─────────────────────────────────────────

type PersonalityResolution = { personality: string; inferredFromTags: boolean };

/**
 * (a) prose `personality` as-is; (b) W++/structured → trait lines;
 * (c) empty → `tags` joined with `', '`, flagged as inferred so the summary
 * never presents it as authored. `description` is never mined for personality.
 */
function resolvePersonality(rawPersonality: string, tags: string[]): PersonalityResolution {
    const p = (rawPersonality || '').trim();
    if (p) {
        const text = isStructuredText(p) ? wppToTraitLines(p) : p;
        return { personality: capChars(text, PERSONALITY_CAP), inferredFromTags: false };
    }
    const joined = (tags || []).map(t => (t || '').trim()).filter(Boolean).join(', ');
    if (joined) return { personality: capChars(joined, PERSONALITY_CAP), inferredFromTags: true };
    return { personality: '', inferredFromTags: false };
}

// ─── Lore chunk assembly ─────────────────────────────────────────────────────

function loreTokens(header: string, content: string): number {
    return countTokens(`${header}\n${content}`);
}

function provenanceGroup(cardName: string): string {
    return `ST:${cardName}`;
}

function clampPriority(n: number): number {
    if (!Number.isFinite(n)) return 0;
    return Math.max(0, Math.min(10, Math.round(n)));
}

/**
 * §3.1 — the per-card character sheet. Always carries the RAW description,
 * whatever its format: trigger keywords carry retrieval regardless, and the
 * source must never be silently rewritten (§9.1). `creator_notes` and `tags`
 * ride below a `---` rule as low-value reference.
 */
function buildSheetChunk(
    name: string,
    description: string,
    creatorNotes: string,
    tags: string[],
    makeId: () => string,
): LoreChunk | null {
    const body = description.trim();
    const notes = creatorNotes.trim();
    const tagLine = (tags || []).map(t => (t || '').trim()).filter(Boolean).join(', ');

    const parts: string[] = [];
    if (body) parts.push(body);
    const reference: string[] = [];
    if (notes) reference.push(`Creator notes: ${notes}`);
    if (tagLine) reference.push(`Tags: ${tagLine}`);
    if (reference.length > 0) parts.push(`---\n${reference.join('\n')}`);

    const content = parts.join('\n\n').trim();
    if (!content) return null;

    const header = `${name} — character sheet`;
    return {
        id: makeId(),
        header,
        content,
        tokens: loreTokens(header, content),
        alwaysInclude: false,
        ragMode: 'keyword',
        triggerKeywords: name ? [name] : [],
        scanDepth: SCAN_DEPTH,
        category: 'character',
        linkedEntities: name ? [name] : [],
        priority: 5,
        group: provenanceGroup(name),
    };
}

/**
 * §3.2 — embedded `character_book` → `LoreChunk`s.
 *
 * §9.6.6 constant-flood cap: at most 3 entries per card keep `alwaysInclude`
 * (lowest `insertion_order` wins, stable on ties). The overflow imports as
 * searchable `ragMode: 'keyword'` and is counted in `demotedCount` so the
 * completion summary can say so out loud — visible, never a silent demotion.
 *
 * Only `constant && enabled` entries compete for the three slots: a disabled
 * entry is never retrieved by any path, so letting it hold a slot would demote
 * a live entry for nothing. A disabled entry is likewise not counted in
 * `demotedCount` — it was never a candidate, so there is nothing to disclose.
 */
export function bookToLoreChunks(
    book: STCharacterBook | undefined,
    cardName: string,
    userName: string,
    makeId: () => string = uid,
): { chunks: LoreChunk[]; demotedCount: number } {
    const entries: STLoreEntry[] = (book?.entries ?? []).filter(e => (e?.content ?? '').trim());
    if (entries.length === 0) return { chunks: [], demotedCount: 0 };

    // Rank the candidates for the always-on slots by insertion_order, stable on
    // ties. A disabled entry is never retrieved by any path, so it does not
    // compete for a slot and is not a demotion when it lands as keyword-mode.
    const constantRank = entries
        .map((entry, index) => ({ entry, index }))
        .filter(x => x.entry.constant && x.entry.enabled)
        .sort((a, b) => (a.entry.insertion_order - b.entry.insertion_order) || (a.index - b.index));
    const promoted = new Set(constantRank.slice(0, CONSTANT_KEEP).map(x => x.index));
    const demotedCount = Math.max(0, constantRank.length - promoted.size);

    const group = provenanceGroup(cardName);
    const chunks = entries.map((entry, index) => {
        const keys = (entry.keys ?? [])
            .map(k => applyMacros(k ?? '', cardName, userName).trim())
            .filter(Boolean);
        const secondary = (entry.secondary_keys ?? [])
            .map(k => applyMacros(k ?? '', cardName, userName).trim())
            .filter(Boolean);
        const comment = applyMacros(entry.comment ?? '', cardName, userName).trim();
        const header = comment || keys[0] || `${cardName} lore`;
        const content = applyMacros(entry.content ?? '', cardName, userName).trim();
        const isAlways = promoted.has(index);

        const chunk: LoreChunk = {
            id: makeId(),
            header,
            content,
            tokens: loreTokens(header, content),
            alwaysInclude: isAlways,
            ragMode: isAlways ? 'always' : 'keyword',
            triggerKeywords: keys,
            scanDepth: SCAN_DEPTH,
            category: 'misc',
            linkedEntities: cardName ? [cardName] : [],
            priority: clampPriority(entry.insertion_order ?? 0),
            disabled: !entry.enabled,
            group,
        };
        if (secondary.length > 0) chunk.secondaryKeywords = secondary;
        return chunk;
    });

    return { chunks, demotedCount };
}

// ─── §3.1 cardToNPC ──────────────────────────────────────────────────────────

export type CardToNPCFlags = {
    /** §9.6.4(c) — personality came from `tags`, not from the author. */
    personalityInferredFromTags: boolean;
    /** §3.1 W++ guard fired: `description` is non-prose, so `storyRelevance` is a fallback. */
    structuredDescription: boolean;
    /** §9.6.6 — how many `constant` lorebook entries were routed to searchable memory. */
    constantDemoted: number;
};

export type CardToNPCResult = {
    npc: NPCEntry;
    loreChunks: LoreChunk[];
    flags: CardToNPCFlags;
};

/**
 * §3.1 — one card → one app-native NPC plus its lore.
 *
 * Agency fields (`populated`, `wants`, `personalityHex`, `skillRung`,
 * `rungCeiling`, `pcRelation`, `region`, `signatureKit`) are deliberately
 * absent: §3.4's mechanical populate owns them and runs after this.
 */
export function cardToNPC(
    card: STCard,
    opts: { userName: string; portraitUrl?: string; makeId?: () => string },
): CardToNPCResult {
    const makeId = opts.makeId ?? uid;
    const name = (card.name ?? '').trim();
    const userName = opts.userName;
    const mac = (text: string) => applyMacros(text ?? '', name, userName);

    const description = mac(card.description);
    const creatorNotes = mac(card.creator_notes);
    const tags = (card.tags ?? []).map(t => mac(t).trim()).filter(Boolean);

    const { personality, inferredFromTags } = resolvePersonality(mac(card.personality), tags);

    // W++ guard: a structured description never reaches an injected field.
    const structuredDescription = isStructuredText(description);
    let storyRelevance: string;
    if (!structuredDescription) {
        storyRelevance = cutAtSentence(description, STORY_CAP);
    } else if (creatorNotes && !isStructuredText(creatorNotes)) {
        storyRelevance = cutAtSentence(creatorNotes, NOTES_FALLBACK_CAP);
    } else {
        storyRelevance = `${name} — imported character`;
    }

    const npc: NPCEntry = {
        id: makeId(),
        name,
        aliases: '',
        appearance: '',
        visualProfile: { ...DEFAULT_VISUAL_PROFILE },
        faction: '',
        storyRelevance,
        disposition: '',
        status: 'Alive',
        goals: '',
        voice: '',
        personality,
        exampleOutput: cutExampleAtStart(mac(card.mes_example), EXAMPLE_CAP),
        affinity: 50,
        tier: 'recurring',
        condition: 'healthy',
    };
    if (opts.portraitUrl) npc.portrait = opts.portraitUrl;

    const loreChunks: LoreChunk[] = [];
    const sheet = buildSheetChunk(name, description, creatorNotes, tags, makeId);
    if (sheet) loreChunks.push(sheet);

    const book = bookToLoreChunks(card.character_book, name, userName, makeId);
    loreChunks.push(...book.chunks);

    return {
        npc,
        loreChunks,
        flags: {
            personalityInferredFromTags: inferredFromTags,
            structuredDescription,
            constantDemoted: book.demotedCount,
        },
    };
}

// ─── §3.3 seed-card extras ───────────────────────────────────────────────────

export type SeedCampaignParts = {
    premiseChunk: LoreChunk | null;
    opening: ChatMessage | null;
    quarantineChunk: LoreChunk | null;
};

/**
 * §3.3 — what the ★ Campaign Seed card contributes beyond its NPC row: a
 * premise chunk from `scenario`, the chosen greeting as the opening message,
 * and the quarantined (never injected) ST system prompt.
 */
export function seedCardToCampaignParts(
    card: STCard,
    greetingIndex: number,
    userName: string,
    makeId: () => string = uid,
): SeedCampaignParts {
    const name = (card.name ?? '').trim();
    const mac = (text: string) => applyMacros(text ?? '', name, userName);
    const group = provenanceGroup(name);

    // Premise ───────────────────────────────────────────────────────────────
    let premiseChunk: LoreChunk | null = null;
    const scenario = mac(card.scenario).trim();
    if (scenario) {
        const header = `Premise — ${name}`;
        premiseChunk = {
            id: makeId(),
            header,
            content: scenario,
            tokens: loreTokens(header, scenario),
            alwaysInclude: true,
            ragMode: 'always',
            triggerKeywords: name ? [name] : [],
            scanDepth: SCAN_DEPTH,
            category: 'world_overview',
            linkedEntities: name ? [name] : [],
            priority: 10,
            group,
        };
    }

    // Opening message ───────────────────────────────────────────────────────
    const alternates = card.alternate_greetings ?? [];
    const picked =
        greetingIndex > 0 && greetingIndex <= alternates.length
            ? alternates[greetingIndex - 1]
            : card.first_mes;
    const content = mac(picked ?? '').trim();
    const opening: ChatMessage | null = content
        ? { id: makeId(), role: 'assistant', content, timestamp: Date.now() }
        : null;

    // System-prompt quarantine ──────────────────────────────────────────────
    let quarantineChunk: LoreChunk | null = null;
    const systemPrompt = mac(card.system_prompt).trim();
    const postHistory = mac(card.post_history_instructions).trim();
    if (systemPrompt || postHistory) {
        const sections: string[] = [];
        if (systemPrompt) sections.push(`System prompt:\n${systemPrompt}`);
        if (postHistory) sections.push(`Post-history instructions:\n${postHistory}`);
        const header = 'ST system prompt (reference — not injected)';
        const body = sections.join('\n\n');
        quarantineChunk = {
            id: makeId(),
            header,
            content: body,
            tokens: loreTokens(header, body),
            alwaysInclude: false,
            ragMode: 'keyword',
            disabled: true,
            triggerKeywords: [],
            scanDepth: SCAN_DEPTH,
            category: 'rules',
            linkedEntities: name ? [name] : [],
            priority: 0,
            group,
        };
    }

    return { premiseChunk, opening, quarantineChunk };
}

// ─── §10.2 the PC path ───────────────────────────────────────────────────────

/**
 * §10.2 "Play as one of my cards". Builds a card-derived
 * `CharacterCreationDraft`, runs it through `assemblePlayerCharacter` (which
 * owns `isPC`/`populated`/`affinity`/`status`/`visualProfile`), then patches
 * on the three card-only fields.
 *
 * WO-A2 §0 invariant: `personalityHex` and `traits` are NEVER set here. The
 * §3.4 keyword-heuristic hex is for imported NPCs only; a PC without a hex is
 * a valid, engine-neutral state.
 */
export function cardToPC(
    card: STCard,
    opts: { portraitUrl?: string; userName?: string },
): PlayerCharacter {
    const name = (card.name ?? '').trim();
    const userName = opts.userName ?? 'You';
    const mac = (text: string) => applyMacros(text ?? '', name, userName);

    const description = mac(card.description);
    const creatorNotes = mac(card.creator_notes);
    const tags = (card.tags ?? []).map(t => mac(t).trim()).filter(Boolean);

    // Same story slice the NPC path would use for `storyRelevance`.
    let storySlice: string;
    if (!isStructuredText(description)) {
        storySlice = cutAtSentence(description, STORY_CAP);
    } else if (creatorNotes && !isStructuredText(creatorNotes)) {
        storySlice = cutAtSentence(creatorNotes, NOTES_FALLBACK_CAP);
    } else {
        storySlice = `${name} — imported character`;
    }

    // Voice sample: the first line of a prose `mes_example`.
    const example = cutExampleAtStart(mac(card.mes_example), EXAMPLE_CAP);
    const voiceSample = isStructuredText(example)
        ? ''
        : (example.split('\n').map(l => l.trim()).find(Boolean) ?? '');

    const draft: CharacterCreationDraft = {
        name,
        appearance: '',
        answers: { 2: storySlice, 6: voiceSample },
    };

    const pc = assemblePlayerCharacter({ draft });
    pc.personality = resolvePersonality(mac(card.personality), tags).personality;
    pc.exampleOutput = example;
    if (opts.portraitUrl) pc.portrait = opts.portraitUrl;
    return pc;
}

/**
 * §10.2 — the context writes `commitCharacterDraft` performs after
 * `setPlayerCharacter`, as a pure patch the import can fold into the campaign
 * state it writes to disk before hydration (§10.3).
 *
 * `playerCharacter` is deliberately NOT part of the patch: the caller sets it.
 */
export function buildPcContextPatch(
    pc: PlayerCharacter,
    base: Partial<GameContext>,
): Partial<GameContext> {
    const existing = base.characterProfileData
        ?? ({ name: '', race: '', class: '', level: 1, hp: { ...DEFAULT_HP } } as unknown as CharacterProfile);
    const profile: CharacterProfileState = base.characterProfile ?? { identity: {}, activeTraits: [] };

    return {
        characterProfileData: {
            ...existing,
            name: pc.name,
            level: existing.level ?? 1,
            hp: existing.hp ?? { ...DEFAULT_HP },
        } as CharacterProfile,
        characterProfile: {
            ...profile,
            identity: { ...profile.identity, name: pc.name },
        },
        characterProfileActive: true,
        creationDraft: null,
    };
}
