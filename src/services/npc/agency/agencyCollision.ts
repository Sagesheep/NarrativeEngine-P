// NPC Agency Phase 4 — Piece E: event collisions IN PLAYER PROXIMITY (WO-08).
// When two proximate NPCs pursue coinciding goals, their events may tangle into ONE shared beat
// the player witnesses. Proximity-gated (the input is the active-this-beat cast from D's
// selectTickTarget, never the whole ledger). Two at a time max. One shared delta out.
//
// Pure + dice-driven (no LLM). Reuses the Phase-3 dice + band machinery. All numbers from
// agencyConstants.ts — never hardcode. The only number E injects is COLLISION_OPPORTUNITY_BONUS
// (as rollGoal extraMods on a contested-tangle winner, per Opus ratification 2026-06-18).
//
// Opus ratifications (2026-06-18) baked in:
//  - Collision pool = NPCs active this beat (the curated cast: deepTier ∪ {audition pick}).
//  - "Loser feeds winner" applies to THAT BEAT's clash (rollGoal.extraMods), not future heat.
//  - Relations directionality = max-magnitude (a one-sided grudge still counts as rivalry).
//  - Neutral default = mild contest (both roll, higher margin wins, no feeding).
//  - Shared delta = ONE TickDelta (lead = higher-visibility side; note names the partner) → one beat.
//  - Names not ids in prose (npcName populated on the deltas; proseLine prefers it).

import type { NPCEntry, Goal, SceneStakes } from '../../../types';
import { rollGoal, nextFailStreak } from './agencyDice';
import { applyBandToGoal } from './agencyProgress';
import { visibilityFromBand } from './agencyDigest';
import type { TickDelta } from './agencyDigest';
import {
    COLLISION_OPPORTUNITY_BONUS,
    GOAL_BASE_DC,
} from './agencyConstants';

// ── Coincidence detection (cheap, no LLM, no embeddings) ──────────────────

const STOPWORDS = new Set([
    'the', 'a', 'an', 'to', 'and', 'of', 'in', 'on', 'at', 'for', 'is', 'are', 'be',
    'by', 'with', 'from', 'as', 'it', 'this', 'that', 'his', 'her', 'their', 'them',
    'he', 'she', 'they', 'but', 'or', 'if', 'so', 'no', 'not', 'into', 'out', 'up',
]);

/** Normalize goal text to a set of non-stopword lowercase keyword tokens. */
function keywordTokens(text: string): Set<string> {
    const tokens = text.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/);
    const out = new Set<string>();
    for (const t of tokens) {
        if (t.length > 2 && !STOPWORDS.has(t)) out.add(t);
    }
    return out;
}

/** Two NPCs "coincide" when their chosen goal shares a target: same region OR ≥1 shared keyword. */
export function goalsCoincide(a: NPCEntry, aGoal: Goal, b: NPCEntry, bGoal: Goal): boolean {
    // Strong signal: same region
    if (a.region && b.region && a.region === b.region) return true;
    // Weak signal: shared non-stopword keyword in goal text
    const aTokens = keywordTokens(aGoal.text);
    const bTokens = keywordTokens(bGoal.text);
    for (const t of aTokens) {
        if (bTokens.has(t)) return true;
    }
    return false;
}

/** Top/chosen goal for an NPC: the first active goal (mirrors chooseTick's highest-score pick order
 *  loosely — for coincidence we only need *a* representative goal; the caller passes the chosen one
 *  for `pick` and we look up the partner's top active goal here). */
export function topActiveGoal(npc: NPCEntry): Goal | null {
    const goals = npc.goalRecords ?? [];
    for (const g of goals) {
        if (g.state === 'active') return g;
    }
    return null;
}

// ── Relations tone (max-magnitude, Opus-ratified) ──────────────────────────

export type RelationTone = 'ally' | 'rival' | 'neutral';

/** Max-magnitude directed edge: a one-sided grudge still counts. Returns the tone + the magnitude. */
export function relationTone(a: NPCEntry, b: NPCEntry): { tone: RelationTone; magnitude: number } {
    const aToB = a.relations?.[b.id] ?? (b.isPC && a.pcRelation !== undefined ? a.pcRelation : 0);
    const bToA = b.relations?.[a.id] ?? (a.isPC && b.pcRelation !== undefined ? b.pcRelation : 0);
    // Pick the direction with the larger absolute value (max-magnitude, Opus §D ruling)
    const useAToB = Math.abs(aToB) >= Math.abs(bToA);
    const v = useAToB ? aToB : bToA;
    if (v >= 1) return { tone: 'ally', magnitude: v };
    if (v <= -1) return { tone: 'rival', magnitude: v };
    return { tone: 'neutral', magnitude: 0 };
}

// ── Collision detection (one partner, deterministic tie-break) ────────────

export type DetectedCollision = {
    partner: NPCEntry;
    partnerGoal: Goal;
    tone: RelationTone;
};

/**
 * Among `candidates` (the active-this-beat cast, EXCLUDING `pick`), find at most ONE partner whose
 * top active goal coincides with `pick`'s chosen goal. If multiple coincide, pick the one with the
 * highest relations-magnitude with `pick` (max-magnitude of both directions), tie-break `id` asc.
 * Two-at-a-time max — never returns more than one partner.
 *
 * Also gates on stakes: if the partner's coinciding goal is blocked by scene stakes, the tangle
 * fizzles (recon §F-5 rec — don't tangle into a blocked goal; matches the hard-gate behavior).
 */
export function detectCollision(
    pick: NPCEntry,
    pickGoal: Goal,
    candidates: NPCEntry[],
    sceneStakes: SceneStakes,
): DetectedCollision | null {
    let best: DetectedCollision | null = null;
    let bestMag = -1;

    for (const partner of candidates) {
        if (partner.id === pick.id) continue;
        const partnerGoal = topActiveGoal(partner);
        if (!partnerGoal) continue;
        // Stakes gate: a blocked partner goal can't roll today → tangle fizzles to solo
        if (sceneStakes === 'dangerous' && partnerGoal.horizon === 'long') continue;
        if (!goalsCoincide(pick, pickGoal, partner, partnerGoal)) continue;

        const { tone, magnitude } = relationTone(pick, partner);
        const absMag = Math.abs(magnitude);
        // Tie-break: higher magnitude wins; exact tie → id asc (deterministic)
        if (absMag > bestMag || (absMag === bestMag && (best === null || partner.id < best.partner.id))) {
            best = { partner, partnerGoal, tone };
            bestMag = absMag;
        }
    }
    return best;
}

// ── Tangle resolution (cooperate / contest / mild contest) ────────────────

export type TangleOutcome = {
    aBand: import('./agencyConstants').Band;
    bBand: import('./agencyConstants').Band;
    aFeedsB: boolean;  // true when a's failure feeds b (a is the loser of a rival contest)
    bFeedsA: boolean;  // true when b's failure feeds a
};

/**
 * Resolve a tangle between two NPCs' coinciding goals. One shared beat, two outcomes.
 *
 *  - ally  → cooperate: both roll, share the better band (both advance together).
 *  - rival → contest: both roll, higher margin wins; loser's failure feeds the winner via
 *           COLLISION_OPPORTUNITY_BONUS as rollGoal extraMods on the winner's roll (Opus §B ruling:
 *           this-beat clash, not future selection heat). Loser's failStreak increments, winner's resets.
 *  - neutral → mild contest: both roll, higher margin wins. No feeding (Opus §D ruling).
 *
 * The "feeding" is applied as a re-roll with the bonus on the winner's roll — mechanically, the
 * winner gets `rollGoal(goal, GOAL_BASE_DC, COLLISION_OPPORTUNITY_BONUS, rng)` so its margin (and
 * thus band) improves this beat. We return both bands so the caller can applyBandToGoal + failStreak.
 */
export function resolveTangle(
    _aNpc: NPCEntry,  // kept for API readability + future per-NPC nudge; unused in v1
    aGoal: Goal,
    _bNpc: NPCEntry,  // kept for API readability + future per-NPC nudge; unused in v1
    bGoal: Goal,
    tone: RelationTone,
    rng: () => number = Math.random,
): TangleOutcome {
    // Both roll their own goal (no bonus yet) — establishes base margins for comparison
    const aBase = rollGoal(aGoal, GOAL_BASE_DC, 0, rng);
    const bBase = rollGoal(bGoal, GOAL_BASE_DC, 0, rng);

    if (tone === 'ally') {
        // Cooperate: share the better band. Both advance together, no feeding.
        const sharedBand = aBase.margin >= bBase.margin ? aBase.band : bBase.band;
        return { aBand: sharedBand, bBand: sharedBand, aFeedsB: false, bFeedsA: false };
    }

    if (tone === 'rival') {
        // Contest: higher margin wins. Winner gets a bonus re-roll (loser feeds winner this beat).
        const aWins = aBase.margin >= bBase.margin;
        if (aWins) {
            const aBoosted = rollGoal(aGoal, GOAL_BASE_DC, COLLISION_OPPORTUNITY_BONUS, rng);
            return {
                aBand: aBoosted.band,  // winner's improved band
                bBand: bBase.band,     // loser's original band (often a fail tier)
                aFeedsB: false,
                bFeedsA: true,         // b's failure fed a
            };
        } else {
            const bBoosted = rollGoal(bGoal, GOAL_BASE_DC, COLLISION_OPPORTUNITY_BONUS, rng);
            return {
                aBand: aBase.band,
                bBand: bBoosted.band,
                aFeedsB: true,         // a's failure fed b
                bFeedsA: false,
            };
        }
    }

    // Neutral: mild contest. Higher margin wins, NO feeding. Both keep their own bands.
    return { aBand: aBase.band, bBand: bBase.band, aFeedsB: false, bFeedsA: false };
}

// ── Shared delta builder (two TickDelta's with a shared note, names not ids) ─

function toneWord(tone: RelationTone): string {
    return tone === 'ally' ? 'cooperating with' : tone === 'rival' ? 'contesting' : 'crossing paths with';
}

/**
 * Build the shared-beat delta. Opus ratification 2026-06-18: a tangle surfaces as ONE digest line —
 * the player's "one shared beat" — NOT two. We lead with the higher-visibility side (tie → `a`, the
 * pick/initiator) so a dramatic clash always shows even when the other side's outcome was quiet (e.g.
 * a rival contest where the winner got the boost but the loser — who might be `pick` — failed
 * silently). The `note` names the partner so it reads as one shared event. Both NPCs' goals still
 * update mechanically in the CALLER — this controls surfacing only. `npcName` is populated so
 * proseLine uses names, not internal ids (id-leak fix). Returns a single-element array so callers
 * (buildDigest) are unchanged.
 */
export function buildTangleDeltas(
    aNpc: NPCEntry,
    aGoal: Goal,
    aBand: import('./agencyConstants').Band,
    bNpc: NPCEntry,
    bGoal: Goal,
    bBand: import('./agencyConstants').Band,
    tone: RelationTone,
): TickDelta[] {
    const aVis = visibilityFromBand(aBand, aGoal.horizon);
    const bVis = visibilityFromBand(bBand, bGoal.horizon);
    const rank = (v: TickDelta['visibility']) => (v === 'direct' ? 2 : v === 'report' ? 1 : 0);
    // Lead with the more salient side; exact tie → `a` (the pick/initiator) for determinism.
    const leadIsA = rank(aVis) >= rank(bVis);
    const lead = leadIsA
        ? { npc: aNpc, goal: aGoal, band: aBand, vis: aVis, other: bNpc }
        : { npc: bNpc, goal: bGoal, band: bBand, vis: bVis, other: aNpc };
    return [
        {
            npcId: lead.npc.id,
            npcName: lead.npc.name,
            goalText: lead.goal.text,
            horizon: lead.goal.horizon,
            band: lead.band,
            visibility: lead.vis,
            note: `${toneWord(tone)} ${lead.other.name}`,
        },
    ];
}

// Re-export for callers that want the dice-level pieces
export { rollGoal, nextFailStreak, applyBandToGoal, visibilityFromBand };