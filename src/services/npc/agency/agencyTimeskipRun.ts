import type { Band } from './agencyConstants';
import { VISIBILITY_RUBRIC, HEARTBEAT_DC, GOAL_BASE_DC, COLLISION_TANGLE_PROB } from './agencyConstants';
import { ticksForDuration, allocateTicks } from './agencyTimeskip';
import { rollGoal, nextFailStreak } from './agencyDice';
import { applyBandToGoal } from './agencyProgress';
import { contextAllow } from './agencySelection';
import { isAgencyEligible } from './agencyLifecycle';
import { applyGoalOutcomeNudge, applyTierCross } from './agencyDrift';
import { goalsCoincide, topActiveGoal, relationTone, resolveTangle, buildTangleDeltas } from './agencyCollision';
import type { NPCEntry, SceneStakes } from '../../../types';
import type { TickDelta } from './agencyDigest';

// ── Detect ─────────────────────────────────────────────────────────────

export type TimeskipDetected = {
    weeks: number;
    raw: string;
};

export type TimeskipAmbiguous = {
    ambiguous: true;
    raw: string;
    hint: string;
};

export type TimeskipResult = TimeskipDetected | TimeskipAmbiguous | null;

const TIMESKIP_PATTERNS: ReadonlyArray<{
    regex: RegExp;
    weeks: (m: RegExpMatchArray) => number;
    ambiguous?: (m: RegExpMatchArray) => string;
}> = [
    {
        regex: /(\d+(?:\.\d+)?)\s*weeks?\s+later/i,
        weeks: (m) => parseFloat(m[1]),
    },
    {
        regex: /(\d+(?:\.\d+)?)\s*weeks?\s+pass/i,
        weeks: (m) => parseFloat(m[1]),
    },
    {
        regex: /(\d+(?:\.\d+)?)\s*months?\s+later/i,
        weeks: (m) => parseFloat(m[1]) * 4.345,
    },
    {
        regex: /(\d+(?:\.\d+)?)\s*months?\s+pass/i,
        weeks: (m) => parseFloat(m[1]) * 4.345,
    },
    {
        regex: /after\s+(?:a\s+)?month/i,
        weeks: () => 4.345,
    },
    {
        regex: /(?:a\s+)?month\s+later/i,
        weeks: () => 4.345,
    },
    {
        regex: /(?:a\s+)?season\s+later/i,
        weeks: () => 13,
        ambiguous: () =>
            'Season is ambiguous — did you mean ~3 months? Confirm or specify weeks/months.',
    },
    {
        regex: /rest\s+(?:for\s+)?(?:a\s+)?season/i,
        weeks: () => 13,
        ambiguous: () =>
            'Season is ambiguous — did you mean ~3 months? Confirm or specify weeks/months.',
    },
    {
        regex: /(?:a\s+)?year\s+later/i,
        weeks: () => 52,
    },
    {
        regex: /(\d+(?:\.\d+)?)\s*years?\s+later/i,
        weeks: (m) => parseFloat(m[1]) * 52,
    },
    {
        regex: /(\d+(?:\.\d+)?)\s*days?\s+later/i,
        weeks: (m) => parseFloat(m[1]) / 7,
    },
    {
        regex: /fortnight\s+later/i,
        weeks: () => 2,
    },
    {
        regex: /(?:a\s+)?week\s+later/i,
        weeks: () => 1,
    },
];

export function detectTimeskip(input: string): TimeskipResult {
    if (!input) return null;

    for (const pattern of TIMESKIP_PATTERNS) {
        const match = input.match(pattern.regex);
        if (match) {
            const weeks = pattern.weeks(match);
            if (weeks <= 0) return null;
            if (pattern.ambiguous) {
                return {
                    ambiguous: true,
                    raw: match[0],
                    hint: pattern.ambiguous(match),
                };
            }
            return { weeks, raw: match[0] };
        }
    }

    return null;
}

// ── Run ─────────────────────────────────────────────────────────────────

export type TimeskipConfig = {
    provider: unknown;
    roster: NPCEntry[];
    weeks: number;
    now: number;
    sceneStakes: SceneStakes;
    advanceTick: (by: number) => number;
    rng?: () => number;
};

export type TimeskipNarrationResult = {
    deltas: TickDelta[];
    narration: string;
    updatedNPCs: NPCEntry[];
    ticksConsumed: number;
};

const WORTH_TELLING_BANDS: ReadonlySet<Band> = new Set<Band>([
    'critSuccess',
    'critFail',
    'successBut',
    'failBut',
]);

const REVEAL_CAP = 2;

function isWorthTelling(band: Band): boolean {
    return WORTH_TELLING_BANDS.has(band);
}

export function runTimeskip(cfg: TimeskipConfig): TimeskipNarrationResult {
    const { roster, weeks, now, sceneStakes, advanceTick, rng } = cfg;
    const rngFn = rng ?? Math.random;

    const totalTicks = ticksForDuration(weeks);
    if (totalTicks <= 0) {
        return {
            deltas: [],
            narration: '',
            updatedNPCs: roster,
            ticksConsumed: 0,
        };
    }

    const deltas: TickDelta[] = [];
    const updatedNPCs: NPCEntry[] = roster.map((npc) => ({ ...npc }));

    for (const npc of updatedNPCs) {
        if (!isAgencyEligible(npc)) continue;

        const goals = (npc.goalRecords ?? []).filter(
            (g) => g.state === 'active'
        );
        if (goals.length === 0) continue;

        const hexDrive = npc.personalityHex?.drive ?? 0;

        const allocation = allocateTicks(
            goals,
            totalTicks,
            now,
            hexDrive,
            sceneStakes
        );

        let tickIndex = 0;
        for (const goalIdx of allocation) {
            if (goalIdx < 0 || goalIdx >= goals.length) break;

            const goal = goals[goalIdx];

            // Hard gate: pre-roll check. Does NOT build karma (§9.6 exception 1).
            if (contextAllow(goal, sceneStakes) === 0) {
                // Blocked — no roll, no karma, no progress
                deltas.push({
                    npcId: npc.id,
                    goalText: goal.text,
                    horizon: goal.horizon,
                    band: 'fail',
                    visibility: 'hidden',
                    note: 'blocked-by-stakes',
                });
                continue;
            }

            // Tempo CEILING roll: a tick may fail and not advance at all (§9.7 Piece D ceiling)
            const tempoRoll = Math.floor(rngFn() * 100) + 1;
            if (tempoRoll < HEARTBEAT_DC.initial) {
                // Tempo fail — this tick is consumed but produces no progress
                deltas.push({
                    npcId: npc.id,
                    goalText: goal.text,
                    horizon: goal.horizon,
                    band: 'fail',
                    visibility: 'hidden',
                    note: 'tempo-miss',
                });
                tickIndex++;
                continue;
            }

            // Goal resolution (Piece B → Piece C). Fixed base DC — karma (inside rollGoal)
            // does the easing; difficulty must NOT scale with failStreak or it cancels karma.
            const resolved = rollGoal(goal, GOAL_BASE_DC, 0, rngFn);
            const band = resolved.band;

            // Apply progress (Piece C)
            const updatedGoal = applyBandToGoal(goal, band, now + tickIndex);
            goals[goalIdx] = updatedGoal;

            // Update failStreak on the goal (Piece B karma rule)
            const newFailStreak = nextFailStreak(goal.failStreak, band);
            goals[goalIdx] = { ...goals[goalIdx], failStreak: newFailStreak };

            // WO-05 §D — engine-resolve nudge (off-screen drift source, +0 LLM). One hex axis nudge
            // per resolved goal, clamped ±1 by `hexDelta`. Mutates the `updatedNPCs` copy in place;
            // the caller persists `personalityHex`/`previousSnapshot` via the result. The SHIFT
            // word-band surfaces on the next payload read via `buildDriftAlert` (never raw integer).
            // Capture the pre-change state BEFORE mutating so `previousSnapshot` holds the old hex.
            const preHex = npc.personalityHex;
            const preRung = npc.skillRung;
            const nudge = applyGoalOutcomeNudge(npc, goal, band);
            if (nudge.hexPatch) {
                npc.personalityHex = nudge.hexPatch;
                npc.previousSnapshot = {
                    personality: npc.personality || npc.disposition || '',
                    voice: npc.voice || '',
                    affinity: npc.affinity,
                    personalityHex: preHex,
                    pcRelation: npc.pcRelation,
                    skillRung: preRung,
                };
                npc.shiftTurnCount = 0;
            }

            // WO-06 §1 — rung-ladder tier-cross. `canCrossTier` (inside `applyTierCross`) enforces
            // the both-conditions §9.7 rule. Bump `skillRung` +1 clamped to `rungCeiling`; consume
            // the flag either way (progress resets). Mutates the `updatedNPCs` copy in place.
            // `preHex`/`preRung` already captured above hold the pre-change state for the snapshot.
            const tierCross = applyTierCross(npc, goals[goalIdx]);
            if (tierCross) {
                goals[goalIdx] = { ...goals[goalIdx], ...tierCross.updatedGoal };
                if (tierCross.rungPatch !== undefined) {
                    npc.skillRung = tierCross.rungPatch;
                    npc.previousSnapshot = {
                        personality: npc.personality || npc.disposition || '',
                        voice: npc.voice || '',
                        affinity: npc.affinity,
                        personalityHex: npc.personalityHex,
                        pcRelation: npc.pcRelation,
                        skillRung: preRung,
                    };
                    npc.shiftTurnCount = 0;
                }
            }

            // Track worth-telling deltas
            const vis = VISIBILITY_RUBRIC[band]?.[goal.horizon] ?? 'hidden';
            deltas.push({
                npcId: npc.id,
                npcName: npc.name,  // WO-08: name not id (id-leak fix)
                goalText: goal.text,
                horizon: goal.horizon,
                band,
                visibility: vis as TickDelta['visibility'],
                note: '',
            });

            tickIndex++;
        }

        // Write back goals
        npc.goalRecords = [...goals];
    }

    // ── WO-08 Piece E: post-loop pairwise tangle pass ──
    // After each NPC's solo ticks are resolved, scan the ticked roster for coinciding pairs
    // (same region OR shared keyword in their top active goal). For each pair that tangles
    // (rng < COLLISION_TANGLE_PROB), resolve the tangle and emit a shared-beat delta pair.
    // These are ADDITIONAL beats (the tangle is a distinct event from the solo ticks), so no
    // double-counting — the solo deltas are "Alden worked on X", the tangle is "Alden and Bryn
    // clashed over X". The worthTelling filter + REVEAL_CAP cap below surface the most dramatic.
    // Proximity-only by construction (the roster is already proximity-gated). +0 LLM.
    const tickedNpcs = updatedNPCs.filter(n => isAgencyEligible(n) && (n.goalRecords ?? []).some(g => g.state === 'active'));
    for (let i = 0; i < tickedNpcs.length; i++) {
        const aNpc = tickedNpcs[i];
        const aGoal = topActiveGoal(aNpc);
        if (!aGoal) continue;
        for (let j = i + 1; j < tickedNpcs.length; j++) {
            const bNpc = tickedNpcs[j];
            const bGoal = topActiveGoal(bNpc);
            if (!bGoal) continue;
            // Stakes gate: skip if either goal is blocked by dangerous stakes
            if (sceneStakes === 'dangerous' && (aGoal.horizon === 'long' || bGoal.horizon === 'long')) continue;
            if (!goalsCoincide(aNpc, aGoal, bNpc, bGoal)) continue;
            if (!(rngFn() < COLLISION_TANGLE_PROB)) continue;
            const { tone } = relationTone(aNpc, bNpc);
            const outcome = resolveTangle(aNpc, aGoal, bNpc, bGoal, tone, rngFn);
            // Apply the tangle bands to both NPCs' goals (progress + failStreak)
            const aUpdated = applyBandToGoal(aGoal, outcome.aBand, now + totalTicks);
            const bUpdated = applyBandToGoal(bGoal, outcome.bBand, now + totalTicks);
            aNpc.goalRecords = (aNpc.goalRecords ?? []).map(g =>
                g.text === aGoal.text && g.horizon === aGoal.horizon ? { ...aUpdated, failStreak: nextFailStreak(g.failStreak, outcome.aBand) } : g
            );
            bNpc.goalRecords = (bNpc.goalRecords ?? []).map(g =>
                g.text === bGoal.text && g.horizon === bGoal.horizon ? { ...bUpdated, failStreak: nextFailStreak(g.failStreak, outcome.bBand) } : g
            );
            // Emit the shared-beat deltas (npcName populated → names, not ids)
            const tangleDeltas = buildTangleDeltas(
                aNpc, aGoal, outcome.aBand,
                bNpc, bGoal, outcome.bBand,
                tone,
            );
            deltas.push(...tangleDeltas);
        }
    }

    // Advance agencyTick ONCE per timeskip (the whole skip is one batch)
    advanceTick(totalTicks);

    // Cap reveals at ~2 (§9.7)
    const surfacedDeltas = deltas.filter(
        (d) =>
            d.visibility === 'direct' || d.visibility === 'report'
    );
    const worthTelling = surfacedDeltas.filter((d) =>
        isWorthTelling(d.band)
    );
    const cappedDeltas = worthTelling.slice(0, REVEAL_CAP);

    // Build the grounding/fallback beat from the surfaced deltas, resolving real NPC NAMES
    // (never the internal ids) and WORD-BANDS only — no engine numbers ever reach this string.
    const nameById = new Map<string, string>();
    for (const npc of updatedNPCs) nameById.set(npc.id, npc.name || 'Someone');
    const narration = buildReturnBeatGrounding(cappedDeltas, nameById);

    return {
        deltas: cappedDeltas,
        narration,
        updatedNPCs,
        ticksConsumed: totalTicks,
    };
}

// ── "What you return to" beat (WO 08) ─────────────────────────────────────
// The timeskip's MVP payoff. Produces a cohesive, in-fiction grounding of the (≤2) surfaced
// off-screen developments, expressed entirely in NAMES + WORD-BANDS — never raw engine numbers
// (heat / progress / quota / failStreak / DC all stay engine-internal, §9.5 agnostic boundary).
//
// This string is DOUBLE-DUTY:
//   1. the grounded fact-list the +1 batched narration LLM call weaves into prose at the seam, and
//   2. the deterministic fallback shown verbatim if that one call fails.
// So it must read cleanly on its own AND give the model concrete, un-inventable beats to dramatize.

// Past-tense band phrasing: what changed about each goal over the gap, story-first, no numbers.
const RETURN_BEAT_BAND_PROSE: Record<Band, string> = {
    critSuccess: 'had a breakthrough and is now far closer to',
    success:     'made real headway toward',
    successBut:  'gained ground toward, though it cost something, on',
    failBut:     'stumbled while pursuing, but turned the setback into an opening toward',
    fail:        'lost ground on',
    critFail:    'suffered a serious reversal on',
};

function buildReturnBeatGrounding(
    deltas: TickDelta[],
    nameById: Map<string, string>,
): string {
    if (deltas.length === 0) return '';

    const lines = deltas.map((d) => {
        const who = nameById.get(d.npcId) ?? 'Someone';
        const verb = RETURN_BEAT_BAND_PROSE[d.band] ?? 'moved on';
        const scale = d.horizon === 'long' ? 'their long ambition' : 'a goal';
        // e.g. "Alden had a breakthrough and is now far closer to their long ambition: master the blade."
        return `${who} ${verb} ${scale}: ${d.goalText}.`;
    });

    return lines.join(' ');
}