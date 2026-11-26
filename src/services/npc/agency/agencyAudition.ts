// NPC Agency Phase 4 — Piece D: promotion / audition (WO-07).
// Keeps the active agent set small: most proximate NPCs stay dormant props, a few recurring
// "deep-tier" members get ticked preferentially, and a low-probability audition roll occasionally
// surfaces a background NPC. Sustained activity promotes into the deep tier; dormancy relegates out.
//
// Pure + dice-driven (no LLM). Reuses buildProximityRoster (the roster input is already curated
// for proximity/eligibility). All numbers come from agencyConstants.ts — never hardcode.

import type { NPCEntry } from '../../../types';
import {
    DEEP_TIER_CAP,
    AUDITION_PROB,
    ACTIVITY_DECAY,
    ACTIVITY_RELEGATE,
} from './agencyConstants';

/**
 * Lazy-decay activity score (Opus §2). Decay clock is the agency tick `now`, NOT wall time.
 * Default-absent NPCEntry.agencyActivity is treated as { value: 0, tick: now } — i.e. a fresh NPC
 * starts at 0. Never iterate-and-write all NPCs each beat; compute on read.
 *
 * current = max(0, stored.value - ACTIVITY_DECAY * (now - stored.tick))
 *
 * With ACTIVITY_DECAY = 0.5 (see deviation flag in agencyConstants.ts), sustained picks accumulate
 * +0.5/beat (reaches ACTIVITY_PROMOTE=3 after ~6 sustained picks) and dormant NPCs decay to
 * ACTIVITY_RELEGATE=0 in 2*value beats. Both promotion and relegation function.
 */
export function currentActivity(npc: NPCEntry, now: number): number {
    const a = npc.agencyActivity;
    if (!a) return 0;
    return Math.max(0, a.value - ACTIVITY_DECAY * (now - a.tick));
}

/**
 * Activity patch to write back when an NPC ticks (real-time pick OR audition pick — Opus §5).
 * Captures the decayed `current` first, then bumps by +1 with the clock stamped at `now`.
 * Caller passes this to callbacks.updateNPC(id, patch).
 */
export function activityBumpPatch(npc: NPCEntry, now: number): { agencyActivity: { value: number; tick: number } } {
    const current = currentActivity(npc, now);
    return { agencyActivity: { value: current + 1, tick: now } };
}

export type SelectTickTargetResult = {
    pick: NPCEntry | null;        // null only when roster is empty (caller no-ops)
    isAudition: boolean;          // true = background NPC got the audition roll this beat
    deepTier: NPCEntry[];         // top-K eligible by activity; empty on cold start; returned for E's collision detector
};

/**
 * Pure selector: which proximate NPC ticks this real-time beat?
 *
 * Algorithm (in order, all numbers from agencyConstants.ts):
 *  1. Compute `current` activity for every roster NPC via the lazy-decay helper.
 *  2. Eligibility floor (Opus §4): keep only `current >= ACTIVITY_RELEGATE` for deep-tier
 *     membership. Below-floor NPCs can still be AUDITIONED (they're the dormant props) but
 *     never auto-promote — a quiet roster doesn't force-promote randoms.
 *  3. Rank eligible by `current` desc, tie-break by `id` asc (deterministic — no cold-start
 *     parade). Take top DEEP_TIER_CAP. That's `deepTier`.
 *  4. Audition roll: if `rng() < AUDITION_PROB` AND a background NPC exists (roster member
 *     not in deepTier, including below-floor) → pick uniform from background; isAudition = true.
 *     Else → pick uniform from deepTier; isAudition = false.
 *  5. Cold start (deepTier empty, everyone at 0): fall back to uniform-from-roster so the first
 *     beat isn't a no-op. Marked isAudition = false (it's a deep-tier-style pick, not an audition).
 *
 * One rng draw path per branch: audition-roll(1) + audition-pick(1) OR deep-tier-pick(1).
 * Deterministic given a seeded rng — tests rely on this.
 */
export function selectTickTarget(
    roster: NPCEntry[],
    now: number,
    rng: () => number = Math.random,
): SelectTickTargetResult {
    if (roster.length === 0) {
        return { pick: null, isAudition: false, deepTier: [] };
    }

    // 1+2. Compute current activity + eligibility floor
    const eligible = roster
        .map(npc => ({ npc, current: currentActivity(npc, now) }))
        .filter(entry => entry.current >= ACTIVITY_RELEGATE);

    // 3. Rank by activity desc, tie-break id asc; take top DEEP_TIER_CAP
    eligible.sort((a, b) => {
        if (b.current !== a.current) return b.current - a.current;
        return a.npc.id < b.npc.id ? -1 : a.npc.id > b.npc.id ? 1 : 0;
    });
    const deepTier = eligible.slice(0, DEEP_TIER_CAP).map(e => e.npc);

    // Set of deep-tier ids for O(1) background filter
    const deepTierIds = new Set(deepTier.map(n => n.id));

    // 5. Cold start: everyone at 0, eligible may still be non-empty (all tied at 0, id-asc top 3)
    //    but if deepTier is empty (roster all below floor — shouldn't happen with RELEGATE=0 and
    //    the max(0,...) clamp, but be defensive), fall back to uniform-from-roster.
    if (deepTier.length === 0) {
        const pick = roster[Math.floor(rng() * roster.length)];
        return { pick, isAudition: false, deepTier: [] };
    }

    // 4. Audition roll
    const background = roster.filter(n => !deepTierIds.has(n.id));
    if (background.length > 0 && rng() < AUDITION_PROB) {
        const pick = background[Math.floor(rng() * background.length)];
        return { pick, isAudition: true, deepTier };
    }

    // Default: pick from deepTier
    const pick = deepTier[Math.floor(rng() * deepTier.length)];
    return { pick, isAudition: false, deepTier };
}