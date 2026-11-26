// Arc Engine (System 2 / Oracle Function) — tunable knobs (single source of truth).
// Every magic number from the WO-01 contract lives here so it can be tuned in ONE
// place. arcDice / arcSpawn / arcStance / arcWorldState import from here — never
// hardcode. Values are LOCKED by the contract (02_ARCHITECT_contract.md §2).

import type { Band } from '../npc/agency/agencyConstants';  // REUSE the agency Band, do not redefine
export type { ArcType, ArcStance, ArcSurface } from '../../types';

// Tempo pity-timer — mirrors HEARTBEAT_DC shape exactly (initial/reduction/floor).
// Arcs tick SLOWER than the NPC heartbeat (a famine shouldn't lurch every seam), so
// a higher initial. Same {fired,nextDc} shape as rollHeartbeat.
export const ARC_TICK_DC = { initial: 35, reduction: 5, floor: 5 } as const;

// Ladder length bounds (spawn validates/clamps to this).
export const LADDER_MIN = 5;
export const LADDER_MAX = 12;

// How many arcs may simmer at once. New spawns blocked at/above this.
export const MAX_ACTIVE_ARCS = 3;

// Seams a fired ArcType is suppressed from re-spawning.
export const TYPE_COOLDOWN_SEAMS = 6;

// Recency window (in seams/ticks) for arcWorldState 'live' classification.
export const ARC_LIVE_RECENCY = 3;

// Stance → extraMods on the OUTCOME roll (rollArcOutcome). The outcome roll measures
// "did the arc make progress toward crisis this tick." So:
//   opposed → strong drag (can push to fail/critFail = stall/regress)
//   aided   → player is helping it along → climbs fast
//   fled    → no one resisting → climbs
//   ignored / unaware → neutral
export const ARC_STANCE_MOD: Record<import('../../types').ArcStance, number> = {
    opposed: -8,
    aided:   +6,
    fled:    +3,
    ignored:  0,
    unaware:  0,
} as const;

// Band → rung delta (clamped to [0 .. ladder.length-1] by advanceRung).
// critFail regresses, fail/failBut stall, success climbs, critSuccess jumps.
export const ARC_BAND_RUNG_DELTA: Record<Band, number> = {
    critSuccess: +2,
    success:     +1,
    successBut:  +1,
    failBut:      0,
    fail:         0,
    critFail:    -1,
} as const;

// arcSurfaceLine emits only when the current rung's surface is at least this loud.
// 'ambient' is the quiet tier — the world-state murmur that colours the GM prompt
// without demanding a scene. 'rumor' and 'direct' always surface.
export const ARC_SURFACE_EMIT_MIN: 'ambient' | 'rumor' | 'direct' = 'ambient';

// Surface tier ordering used by arcSurfaceLine to tag the digest line.
export const ARC_SURFACE_TIER: Record<import('../../types').ArcSurface, number> = {
    ambient: 0,
    rumor: 1,
    direct: 2,
} as const;

// NPC-pressure threshold above which arcWorldState classifies 'live' (an NPC with
// unresolved pressure is itself an active thread — spawning an arc on top would
// stomp it). Mirrors the troublemaker.ts active-NPC gate (>1).
export const ARC_LIVE_PRESSURE_THRESHOLD = 1;