import type { NPCEntry } from '../../types';
import { REACTION_VOCAB, type ReactionEntry } from './agency/agencyPools';
import { pcRelationOf } from './reactionMenu';

// NPC Inner Repression — peaceful social masking.
//
// People don't narrate their feelings to feel human; they feel human when their WORDS and
// FEELINGS diverge — they swallow the jealousy and smile. This layer sits on top of the
// engine-built reaction menu (reactionMenu.ts): when an NPC's genuine top reaction is a
// hostile/self-interested one, the engine rolls whether they HIDE it, and if so rewrites that
// menu entry into a "suppressed" directive token (the AI renders the leak/mask as prose; it
// never decides to hide — the dice already did).
//
// Design decisions (locked with the user):
// - PEACEFUL CONTEXT ONLY. Masking is a social act; combat reactions are act/freeze, not mask.
// - "Repressible" is DERIVED, not hand-tagged: relationWeight < 0 (self-interest / betrayal) OR
//   warmth+empathy axisWeights < 0 (contempt / coldness). Self-maintaining as the vocab grows.
// - Two tells: 'leaked' (emotional — relationWeight >= 0, caught by cold axes) shows on the face;
//   'concealed' (relationWeight < 0 — self-interested intent) shows as a behavioral tell.
// - The repression EVENT (did they hide?) is decided by the roll, independent of what the AI
//   later renders — so pressure can be booked without parsing the AI's pick. See bookRepression.
//
// Pure module, no I/O. Inject `rng` for deterministic tests (codebase convention).

// `withdraw and go quiet` IS the masked form — it's what repression looks like, not a raw
// feeling to repress. Never treat it as a repression target.
const REPRESSION_EXCLUDE: ReadonlySet<string> = new Set(['withdraw and go quiet']);

// Tunables.
const HIDE_CHANCE_MIN = 0.05;
const HIDE_CHANCE_MAX = 0.95;
const HIDE_SLOPE = 0.08;        // how steeply hideScore bends the 50/50 base
const MASK_CONTROL = 2;         // composure−boldness >= this → clean MASK (faint tell) vs LEAK
export const BURST_THRESHOLD = 4; // pressure at/above which the dam breaks (forced express + catharsis)

export type RepressKind = 'none' | 'leaked' | 'concealed';
export type RepressionOutcome = 'express' | 'leak' | 'mask' | 'burst';

export type RepressionEvent = {
    outcome: RepressionOutcome;
    /** Delta to apply to repressionPressure. +1 when hidden; negative (discharge) on burst; 0 otherwise. */
    pressureDelta: number;
    /** On burst only: randomized pcRelation correction (catharsis), weighted toward relief. */
    pcRelationDelta?: number;
};

const TEXT_TO_ENTRY: ReadonlyMap<string, ReactionEntry> =
    new Map(REACTION_VOCAB.map(r => [r.text, r]));

/**
 * Valence of a reaction for the repression layer. Peaceful-only. Returns:
 * - 'concealed' when relationWeight < 0 (a self-interested / relationship-damaging move; the
 *   mask is OUTWARD compliance with a behavioral tell — you can't "leak" a betrayal on your face).
 * - 'leaked' when it's hostile by axis (warmth+empathy < 0) but not relationship-scoped — the
 *   feeling shows on the face/tone.
 * - 'none' otherwise (positive, neutral, dangerous-context, or explicitly excluded).
 */
export function repressKind(r: ReactionEntry): RepressKind {
    if (r.context !== 'peaceful') return 'none';
    if (REPRESSION_EXCLUDE.has(r.text)) return 'none';
    const rel = r.relationWeight ?? 0;
    if (rel < 0) return 'concealed';
    const social = (r.axisWeights.warmth ?? 0) + (r.axisWeights.empathy ?? 0);
    if (social < 0) return 'leaked';
    return 'none';
}

/** Look up a menu text's repression kind (menu carries texts, not entries). */
export function repressKindOf(text: string): RepressKind {
    const entry = TEXT_TO_ENTRY.get(text);
    return entry ? repressKind(entry) : 'none';
}

/**
 * How likely this NPC is to hide a hostile impulse right now.
 *   hideScore = control − closeness − pressure
 *   control   = composure − boldness  (guarded/self-possessed hide; impulsive/bold blurt)
 *   closeness = pcRelation (−3..+3)   (raw with intimates; guarded with strangers/hostiles)
 *   pressure  = repressionPressure    (the more they've swallowed, the closer to bursting)
 * Higher = more likely to mask. Pure.
 */
export function hideScoreOf(npc: NPCEntry): number {
    const hex = npc.personalityHex;
    const control = hex ? (hex.composure ?? 0) - (hex.boldness ?? 0) : 0;
    const closeness = pcRelationOf(npc);
    const pressure = npc.repressionPressure ?? 0;
    return control - closeness - pressure;
}

/**
 * Roll the repression event for an NPC whose genuine top reaction is repressible.
 * - pressure at/above BURST_THRESHOLD → forced 'burst' (express + discharge + catharsis roll)
 * - else a single hide roll vs a hideScore-derived chance:
 *     hidden  → +1 pressure; 'mask' if highly self-possessed, else 'leak'
 *     express → no change (a fresh feeling let out is not pent-up)
 * `kind` selects mask-vs-leak depth wording but does not change the math.
 */
export function rollRepression(npc: NPCEntry, rng: () => number = Math.random): RepressionEvent {
    const pressure = npc.repressionPressure ?? 0;

    if (pressure >= BURST_THRESHOLD) {
        return { outcome: 'burst', pressureDelta: -pressure, pcRelationDelta: rollCatharsis(rng) };
    }

    const score = hideScoreOf(npc);
    const hideChance = clamp(0.5 + HIDE_SLOPE * score, HIDE_CHANCE_MIN, HIDE_CHANCE_MAX);
    const roll = rng();
    if (roll >= hideChance) {
        return { outcome: 'express', pressureDelta: 0 };
    }

    const hex = npc.personalityHex;
    const control = hex ? (hex.composure ?? 0) - (hex.boldness ?? 0) : 0;
    const outcome: RepressionOutcome = control >= MASK_CONTROL ? 'mask' : 'leak';
    return { outcome, pressureDelta: 1 };
}

/**
 * Catharsis: the relief after a break. Randomized, weighted toward clearing the air (the fight
 * that brings people closer) but never guaranteed — sometimes it costs you, sometimes a wash.
 * Returns a ±1 / 0 pcRelation step.
 */
function rollCatharsis(rng: () => number): number {
    const r = rng();
    if (r < 0.6) return 1;   // air cleared
    if (r < 0.85) return 0;  // wash
    return -1;               // it cost something
}

/**
 * Rewrite a single repressible menu entry into a suppressed directive token. The token tells the
 * AI to PLAY the hide (it never decides to); leak/mask depth and leaked/concealed flavor pick the
 * wording. `express`/`burst` leave the raw reaction unchanged (the feeling comes out).
 */
export function repressionToken(rawText: string, kind: RepressKind, outcome: RepressionOutcome): string {
    if (outcome === 'express' || outcome === 'burst' || kind === 'none') return rawText;
    if (kind === 'concealed') {
        return outcome === 'mask'
            ? `${rawText} — but HIDDEN: smoothly cooperative to your face; the intent shows only in the smallest misstep`
            : `${rawText} — but CONCEALED: acts agreeable to your face, betraying the intent only through behavior (half-hearted, dragging, subtly off — never stated)`;
    }
    // leaked feeling
    return outcome === 'mask'
        ? `${rawText} — but MASKED: stays composed; only the faintest tell slips through`
        : `${rawText} — but SUPPRESSED: plays it civil while the feeling leaks through (a tight smile, a flat tone, a beat too long)`;
}

/**
 * Apply repression to a built reaction menu (peaceful only). Transforms the FIRST repressible
 * entry — the NPC's dominant impulse, since rank-1 leads the menu — leaving the rest as escape
 * options the AI can pick instead (the full-mask path). Returns the rewritten menu and the event
 * to book (or null when nothing was repressible / context isn't peaceful).
 *
 * PURE: never mutates `npc`. The caller books the event via bookRepression at a once-per-turn
 * site (NOT inside payload assembly, which can re-run and double-count).
 */
export function applyRepressionToMenu(
    menu: string[],
    npc: NPCEntry,
    context: 'peaceful' | 'dangerous',
    rng: () => number = Math.random,
): { menu: string[]; event: RepressionEvent | null } {
    if (context !== 'peaceful' || menu.length === 0) return { menu, event: null };

    const idx = menu.findIndex(text => repressKindOf(text) !== 'none');
    if (idx === -1) return { menu, event: null };

    const kind = repressKindOf(menu[idx]);
    const event = rollRepression(npc, rng);
    const next = menu.slice();
    next[idx] = repressionToken(menu[idx], kind, event.outcome);
    return { menu: next, event };
}

/**
 * Pure reducer: fold a RepressionEvent into an NPC patch. Clamps pressure to [0, ∞) and the
 * catharsis pcRelation correction to a ±1 step within [−3, +3] (mirrors the agency-update
 * clamping in update.ts). Returns only the changed fields. Call once per turn per NPC.
 */
export function bookRepression(
    npc: NPCEntry,
    event: RepressionEvent,
    relationshipMemoryEnabled = false,
): Partial<NPCEntry> {
    const patch: Partial<NPCEntry> = {};
    const current = npc.repressionPressure ?? 0;
    const nextPressure = Math.max(0, current + event.pressureDelta);
    if (nextPressure !== current) patch.repressionPressure = nextPressure;

    if (!relationshipMemoryEnabled && event.pcRelationDelta && npc.pcRelation !== undefined) {
        const step = Math.max(-1, Math.min(1, Math.round(event.pcRelationDelta)));
        const next = Math.max(-3, Math.min(3, npc.pcRelation + step));
        if (next !== npc.pcRelation) patch.pcRelation = next;
    }
    return patch;
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}
