// NPC Agency Phase 3 — tunable knobs (single source of truth).
// Every magic number from DESIGN §9.5–9.8 lives here so it can be tuned against real data in ONE
// place. Pieces A–D (selection/dice/progress/timeskip) import from here — never hardcode.

import type { GoalHorizon } from '../../../types';

export type Band = 'critSuccess' | 'success' | 'successBut' | 'failBut' | 'fail' | 'critFail';

// §9.5 — drive_mult by personality-hex `drive` axis value (-3..+3). Driven ↑ (festers fast),
// Listless ↓. Endpoints locked by spec (1.5 / 0.6); interior values are smooth + tunable.
export const DRIVE_MULT: Record<number, number> = {
    [-3]: 0.6, [-2]: 0.75, [-1]: 0.9, 0: 1.0, 1: 1.15, 2: 1.3, 3: 1.5,
};

// §9.6 — karma nudge (per-goal, hidden).
export const KARMA_PER_FAIL = 2;
export const KARMA_CAP = 6;

// §9.6 — base goal-resolution DC. Difficulty is a property of the goal, not the streak:
// the spec moves *difficulty* with the goal's magnitude and eases the roll via karma_bonus.
// A fixed base DC is what lets karma's anti-deadlock guarantee hold (after 3 fails, +6 to a
// DC-10 roll almost always lands → resets the streak). Do NOT fold failStreak into the DC —
// that would cancel the karma nudge and re-open the Alden-freeze. Tunable.
export const GOAL_BASE_DC = 10;

// §9.6 — degrees band → progress increment (Piece C reads this).
export const BAND_PROGRESS: Record<Band, number> = {
    critSuccess: 2,
    success: 1,
    successBut: 1,
    failBut: 0,
    fail: 0,
    critFail: -1,
};

// §9.7 — quota by goal magnitude (seed; the migration picks by horizon, an LLM/heuristic may refine).
export const QUOTA_HINTS = { small: 6, medium: 10, large: 20 } as const;
export const QUOTA_BY_HORIZON: Record<GoalHorizon, number> = {
    med: QUOTA_HINTS.medium,   // 10
    long: QUOTA_HINTS.large,   // 20
};

// §9.6 / §9.5 — base_heat seeds (Piece A neglect builds on top of these).
export const BASE_HEAT: Record<GoalHorizon, number> = { med: 2, long: 4 };
export const AMBITIOUS_HEAT_BONUS = 2;   // `ambitious` trait → +long-goal base_heat (§9.8 hook)

// §9.7 Piece D — timeskip duration → tick budget (log curve).
export const TIMESKIP_K = 1.5;
export const TIMESKIP_CAP = 10;

// §5 / §9.3#1 — heartbeat escalating-DC pity timer (mirrors the surprise/encounter engine).
export const HEARTBEAT_DC = { initial: 20, reduction: 5, floor: 0 } as const;

// §9.5 — novelty color roll (rare trait-bounded whiplash). Raised for eccentric/impulsive.
export const COLOR_ROLL_BASE = 0.05;
export const COLOR_ROLL_TRAIT_BONUS = 0.15;
export const COLOR_ROLL_TRAITS = ['eccentric', 'impulsive'] as const;

// §9.3#7 — Digest visibility rubric (Piece I). Bands on the "but" rails and crits
// are dramatic enough to surface directly; quiet successes on minor goals stay hidden
// to preserve the delayed-reveal payoff.

export type DigestVisibility = 'direct' | 'report' | 'hidden';

export const VISIBILITY_RUBRIC: Record<Band, { long: DigestVisibility; med: DigestVisibility }> = {
    critSuccess:  { long: 'direct', med: 'direct' },
    critFail:     { long: 'direct', med: 'direct' },
    successBut:   { long: 'report', med: 'hidden' },
    failBut:      { long: 'report', med: 'hidden' },
    success:      { long: 'report', med: 'hidden' },
    fail:         { long: 'hidden', med: 'hidden' },
};

export const DIGEST_PLAYER_CAP = 3;

// ── Phase 4 ──────────────────────────────────────────────────────────────────

// §9.2 #5 / §9.4 — personality-hex drift. Axes are clamped −3..+3 (matches generation bounds).
// Drift is small + rare: at most ±1 per transformative event. A full overwrite is FORBIDDEN.
export const HEX_AXIS_MIN = -3;
export const HEX_AXIS_MAX = 3;
export const HEX_DRIFT_MAX_STEP = 1;   // reject any |delta| > this from the AI update

// §9.4 — pcRelation drift uses the same −3..+3 band and ±1 step.
export const PC_RELATION_MIN = -3;
export const PC_RELATION_MAX = 3;
export const PC_RELATION_MAX_STEP = 1;

// §3c — power-rung ladder. 0=Novice … 4=Master. Word-bands are the ONLY thing the GM/payload sees.
export const RUNG_MIN = 0;
export const RUNG_MAX = 4;
export const RUNG_DEFAULT = 0;          // Novice on lazy fill
export const RUNG_CEILING_DEFAULT = 3;  // talent cap when the LLM doesn't set one
export const RUNG_LABELS = ['Novice', 'Skilled', 'Expert', 'Veteran', 'Master'] as const;

// §3b Piece D — promotion / audition. Keep the ACTIVE agent set small so the cast stays a stable,
// recurring few (no random parade as the ledger grows). All tunable.
export const DEEP_TIER_CAP = 3;        // max simultaneously-active agents near the player
export const AUDITION_PROB = 0.15;     // chance a beat ticks a BACKGROUND proximate NPC instead of a deep-tier member
export const ACTIVITY_DECAY = 0.5;     // per beat, an NPC's activity score decays by this toward 0
// ⚠ WO-07 DEVIATION (2026-06-18, GLM): was 1 per spec. With decay=1 and bump=+1, current_activity
// could never exceed 1 (bump exactly cancels one beat's decay), so ACTIVITY_PROMOTE=3 was unreachable
// and the deep tier froze to the 3 lowest-id NPCs — concentration still worked, but "sustained
// promotion / dormancy relegation" (Opus §4) did not. Decay=0.5 lets sustained picks accumulate
// +0.5/beat (reaches PROMOTE after ~6 sustained picks) and dormant NPCs decay to RELEGATE=0 in
// 2·value beats. User-approved pending Opus ratification — re-read this comment before tuning.
export const ACTIVITY_PROMOTE = 3;     // activity ≥ this promotes a background NPC into the deep tier
export const ACTIVITY_RELEGATE = 0;    // activity ≤ this relegates a deep-tier NPC back to background

// §9.2 #12 / §3d Piece E — event collisions IN PLAYER PROXIMITY (not autonomous off-screen life):
// when two proximate NPCs' chosen goals coincide, their events may tangle into ONE shared beat.
export const COLLISION_TANGLE_PROB = 0.5;     // chance coinciding proximate events tangle (vs resolve solo)
export const COLLISION_OPPORTUNITY_BONUS = 3; // opportunityBonus fed to the winner's goalScore on a tangle

// §9.5 — engine-resolve drift: goal outcome → the hex axis it nudges (Piece A off-screen source +
// Piece C optional tier-cross nudge). Kept tiny + tunable; both WO-05 and WO-06 share this map.
export const OUTCOME_AXIS_MAP = {
    critSuccessBold: 'boldness',   // crit-success on a bold/combat goal → +boldness
    repeatedFailure: 'composure',  // sustained failStreak → −composure
} as const;
