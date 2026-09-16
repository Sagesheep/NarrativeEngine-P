/**
 * WO-C §3.4 — keyword-heuristic personality hexagon for *imported* NPCs.
 *
 * `rollHex` (`src/services/npc/hexRoll.ts`) is envelope-driven and belongs to the
 * LLM generator; import has no envelope and no LLM, so it derives the hex from the
 * card's own vocabulary instead (§10.6).
 *
 * Pure: no store, no network, no `Math.random` — the caller supplies `rng` so the
 * whole import is reproducible in tests.
 *
 * NOTE (§10.2): this is for imported NPCs only. The player character's hex is
 * written by the quiz or the user's hand — never derived here.
 */

import type { HexAxis, PersonalityHex } from '../../types';

/** Fixed axis order. Also fixes the order in which `rng` is consumed. */
const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

export type KeywordAxisRule = {
    /** A word-boundary keyword. A plain string is wrapped into `\b<word>\b` (case-insensitive). */
    match: RegExp | string;
    nudges: Partial<Record<HexAxis, number>>;
};

/**
 * ~25 rules covering the WO examples plus common character-card vocabulary
 * (including the ST-native `tsundere` / `yandere` tags).
 *
 * Each rule contributes its nudges **at most once**, however many of the scanned
 * texts contain it — `personality` and `tags` routinely repeat the same word, and
 * double-counting there would turn one adjective into a ±4 swing.
 */
export const KEYWORD_AXIS_TABLE: readonly KeywordAxisRule[] = Object.freeze([
    { match: /\b(?:shy|timid)\b/i, nudges: { boldness: -2 } },
    { match: /\b(?:kind|gentle)\b/i, nudges: { warmth: 2, empathy: 1 } },
    { match: /\b(?:hot-headed|hotheaded|fiery)\b/i, nudges: { composure: -2, boldness: 1 } },
    { match: 'lazy', nudges: { diligence: -2 } },
    { match: 'ambitious', nudges: { drive: 2 } },
    { match: /\b(?:stoic|cold|aloof)\b/i, nudges: { warmth: -1, composure: 2 } },
    { match: /\b(?:cheerful|bubbly)\b/i, nudges: { warmth: 1 } },
    { match: /\b(?:cruel|sadistic)\b/i, nudges: { empathy: -2 } },
    { match: 'cowardly', nudges: { boldness: -2 } },
    { match: /\b(?:disciplined|diligent)\b/i, nudges: { diligence: 2 } },
    { match: /\b(?:brave|bold|fearless)\b/i, nudges: { boldness: 2 } },
    { match: /\b(?:caring|compassionate|nurturing)\b/i, nudges: { empathy: 2, warmth: 1 } },
    { match: /\b(?:arrogant|proud)\b/i, nudges: { boldness: 1, empathy: -1 } },
    { match: /\b(?:calm|serene|composed)\b/i, nudges: { composure: 2 } },
    { match: /\b(?:anxious|nervous)\b/i, nudges: { composure: -2 } },
    { match: 'loyal', nudges: { warmth: 1, diligence: 1 } },
    { match: 'tsundere', nudges: { warmth: -1, composure: -1 } },
    { match: 'yandere', nudges: { empathy: -2, drive: 1 } },
    { match: /\b(?:playful|mischievous)\b/i, nudges: { composure: -1, warmth: 1 } },
    { match: /\b(?:serious|stern)\b/i, nudges: { composure: 1, warmth: -1 } },
    { match: 'curious', nudges: { drive: 1, boldness: 1 } },
    { match: 'hardworking', nudges: { diligence: 2, drive: 1 } },
    { match: /\b(?:manipulative|scheming)\b/i, nudges: { empathy: -1, composure: 1 } },
    { match: /\b(?:friendly|warm)\b/i, nudges: { warmth: 2 } },
    { match: /\b(?:rude|blunt)\b/i, nudges: { warmth: -1 } },
]);

/** Word-boundary, case-insensitive matcher for either rule spelling. */
function ruleMatches(rule: KeywordAxisRule, haystack: string): boolean {
    if (typeof rule.match === 'string') {
        const escaped = rule.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${escaped}\\b`, 'i').test(haystack);
    }
    // Rebuilt per call so a stray /g flag can never leak `lastIndex` state between scans.
    return new RegExp(rule.match.source, rule.match.flags.replace(/[gy]/g, '')).test(haystack);
}

function clampAxis(v: number): number {
    return Math.max(-3, Math.min(3, v));
}

/**
 * Derive a `PersonalityHex` from card vocabulary.
 *
 * @param texts  Bounded card text — `personality` and `tags`. **Never `description`**
 *               (§3.4: W++ blocks are keyword soup and would drown the signal).
 * @param rng    Deterministic source for the no-hit fill. Axes no keyword touched get a
 *               small −1..+1 roll so imported NPCs are not uniformly flat (§3.4). This
 *               random fill is REQUIRED here; WO-A2 dropped it for the player character only.
 * @returns      `hex` (every axis clamped −3..+3) and `hitAxes` — the axes an actual
 *               keyword moved, so the UI can say which traits were read vs. rolled.
 */
export function deriveKeywordHex(texts: string[], rng: () => number): { hex: PersonalityHex; hitAxes: HexAxis[] } {
    const haystacks = texts.map(t => (t || '').toLowerCase()).filter(t => t.length > 0);

    const sums: Partial<Record<HexAxis, number>> = {};
    for (const rule of KEYWORD_AXIS_TABLE) {
        if (!haystacks.some(h => ruleMatches(rule, h))) continue;
        for (const axis of HEX_AXES) {
            const nudge = rule.nudges[axis];
            if (nudge === undefined) continue;
            sums[axis] = (sums[axis] ?? 0) + nudge;
        }
    }

    const hitAxes = HEX_AXES.filter(axis => sums[axis] !== undefined);
    const hex = {} as PersonalityHex;
    for (const axis of HEX_AXES) {
        const summed = sums[axis];
        // An axis that summed to exactly 0 still counts as hit — it was read, not rolled.
        hex[axis] = summed === undefined ? Math.floor(rng() * 3) - 1 : clampAxis(summed);
    }
    return { hex, hitAxes };
}
