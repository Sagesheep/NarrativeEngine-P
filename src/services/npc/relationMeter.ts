import type { NPCEntry } from '../../types';
import { pcRelationOf } from './affinityAccess';

// Relationship Meter — engine-owned affinity accumulator.
//
// The frozen-dial bug: the pcRelation band (−3..+3) only moved when the story AI volunteered a
// delta, and the AI (told to report only "fundamental/transformative" changes) almost never did.
// On top of that a +1 is a whole-band leap (Neutral → Trusted Ally) — far too coarse to move on
// ordinary scenes. So relationships sat frozen for dozens of scenes.
//
// Fix (mirrors the reaction-menu philosophy — AI judges, engine decides): the AI's ONLY job is to
// label each scene's tone toward each on-stage NPC. The engine rolls that label into a hidden
// sub-band meter; the band only flips when the meter crosses a threshold. This makes relationships
// progress invisibly (a classmate you've been kind to is "still neutral, but warming") and only
// cross a band on accumulated weight.
//
// Two asymmetries, both encoding "trust is slow and ceilinged; distrust is fast and bottomless":
//   - THRESHOLD: +100 to rise a band, only −50 to fall.
//   - BIG EVENTS: a 'bonding' (comrade) moment leaps you up but CANNOT push the band above
//     Friendly (+1) — deep devotion is earned only by the slow grind. A 'betrayal' drops you hard
//     with no floor cap (down to Nemesis).
//
// Pure module, no I/O. Inject `rng` for deterministic tests (codebase convention).

export type RelationTone = 'friendly' | 'tense' | 'neutral' | 'bonding' | 'betrayal';

export const RELATION_TONES: readonly RelationTone[] =
    ['friendly', 'tense', 'neutral', 'bonding', 'betrayal'] as const;

// ── Tunables (one table; adjust after playtest) ───────────────────────────────
const RISE_THRESHOLD = 100;   // meter at/above this → band +1 (slow: trust is earned)
const FALL_THRESHOLD = 50;    // meter at/below −this → band −1 (fast: distrust is cheap)
const MAX_BAND = 3;
const MIN_BAND = -3;
const COMRADE_BAND_CAP = 1;   // 'bonding' events can't push the band above Friendly(+1)

// Per-tone signed step ranges (inclusive integers). Ordinary tones are small (many scenes to move
// a band); event tones are large (a single moment moves the needle hard).
const TONE_STEPS: Record<RelationTone, { min: number; max: number }> = {
    friendly: { min: 5, max: 12 },     // ~10–20 scenes to climb a band
    tense:    { min: -12, max: -5 },   // ~5–10 scenes to slip a band (faster)
    neutral:  { min: 0, max: 0 },      // logistics/small talk — no bond formed
    bonding:  { min: 100, max: 100 },  // one full rise (capped at Friendly)
    betrayal: { min: -100, max: -50 }, // 1–2 bands instantly, uncapped
};

export function isRelationTone(v: unknown): v is RelationTone {
    return typeof v === 'string' && (RELATION_TONES as readonly string[]).includes(v);
}

/** Inclusive integer roll in [min, max] from an injected rng. */
function rollStep(tone: RelationTone, rng: () => number): number {
    const { min, max } = TONE_STEPS[tone];
    if (min === max) return min;
    return min + Math.floor(rng() * (max - min + 1));
}

function clamp(v: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, v));
}

/** The NPC's current band — prefers pcRelation, falls back to the legacy affinity seed. */
function bandOf(npc: NPCEntry): number {
    return pcRelationOf(npc);
}

/**
 * Fold a per-NPC tone label into a relationship patch. Pure — never mutates `npc`. Returns only
 * the changed fields ({ pcRelation?, relationMeter? }), so an unchanged read yields {}.
 *
 * Algorithm:
 *  1. roll a signed step from the tone's range
 *  2. add to the meter
 *  3. consume RISE_THRESHOLD per band up / FALL_THRESHOLD per band down (carry preserved)
 *  4. clamp band to [−3,+3]; for 'bonding', clamp band to Friendly(+1) and drop the overflow
 *  5. bound the parked meter to (−FALL_THRESHOLD, RISE_THRESHOLD) so it can't grow forever at a cap
 */
export function applyRelationTone(
    npc: NPCEntry,
    tone: RelationTone,
    rng: () => number = Math.random,
    relationshipMemoryEnabled = false,
): Partial<NPCEntry> {
    if (relationshipMemoryEnabled) return {};
    const band0 = bandOf(npc);
    const meter0 = npc.relationMeter ?? 0;

    // A comrade moment can't help someone already at/above the cap — no-op rather than banking
    // dead meter that could later spill past the ceiling.
    if (tone === 'bonding' && band0 >= COMRADE_BAND_CAP) return {};

    const delta = rollStep(tone, rng);
    let meter = meter0 + delta;
    let band = band0;

    while (meter >= RISE_THRESHOLD && band < MAX_BAND) {
        band += 1;
        meter -= RISE_THRESHOLD;
    }
    while (meter <= -FALL_THRESHOLD && band > MIN_BAND) {
        band -= 1;
        meter += FALL_THRESHOLD;
    }

    if (tone === 'bonding' && band > COMRADE_BAND_CAP) {
        band = COMRADE_BAND_CAP;
        meter = 0;
    }

    band = clamp(band, MIN_BAND, MAX_BAND);
    meter = clamp(meter, -(FALL_THRESHOLD - 1), RISE_THRESHOLD - 1);

    const patch: Partial<NPCEntry> = {};
    if (band !== band0) patch.pcRelation = band;
    if (meter !== meter0) patch.relationMeter = meter;
    return patch;
}
