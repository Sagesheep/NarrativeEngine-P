import type { PersonalityHex, HexAxis, NPCEntry, Goal } from '../../../types';
import { HEX_AXIS_MIN, HEX_AXIS_MAX, HEX_DRIFT_MAX_STEP, OUTCOME_AXIS_MAP, RUNG_DEFAULT, RUNG_CEILING_DEFAULT, type Band } from './agencyConstants';
import { canCrossTier, consumeTierCross } from './agencyProgress';
import { formatHexShift, formatRungShift } from './agencyBands';

/**
 * Returns a NEW hex with one axis nudged by `by`, clamped to [HEX_AXIS_MIN, HEX_AXIS_MAX].
 * `by` is itself clamped to ±HEX_DRIFT_MAX_STEP first (a +3 request becomes +1) so no caller can
 * over-drift. Immutable: never mutates the input. `by === 0` returns an equal-valued new object.
 *
 * Phase 4 §9.2 #5 / §9.4 — the single guardrail for personality-hex drift. Both the AI update
 * (WO-05) and the engine-resolve nudge call this so clamping lives in exactly one place. A drift
 * that let a caller jump more than ±1 or escape the −3..+3 band re-opens "numbers are meaningless."
 */
export function hexDelta(hex: PersonalityHex, axis: HexAxis, by: number): PersonalityHex {
    // 1. Clamp the STEP first: a +5 request becomes +1 (HEX_DRIFT_MAX_STEP).
    const step = Math.max(-HEX_DRIFT_MAX_STEP, Math.min(HEX_DRIFT_MAX_STEP, Math.round(by)));

    // 2. Clamp the RESULT: never escape the −3..+3 band.
    const current = hex[axis];
    const next = Math.max(HEX_AXIS_MIN, Math.min(HEX_AXIS_MAX, current + step));

    // 3. Immutable spread — never touch the other axes, never mutate the input.
    return { ...hex, [axis]: next };
}

/**
 * WO-05 §D — the off-screen drift source. Pure, +0 LLM. Maps a resolved goal's outcome band to a
 * single personality-hex axis nudge, applied via `hexDelta` (which clamps step + band). One nudge
 * per resolved goal max. The mapping is tiny + tunable, kept in `OUTCOME_AXIS_MAP` so WO-06's
 * optional tier-cross nudge shares it.
 *
 *   critSuccess on a bold/combat goal → +boldness
 *   repeated failure (failStreak)      → −composure
 *
 * Returns:
 *   - `hexPatch`: a new PersonalityHex when a nudge fired (caller writes it back), else undefined.
 *   - `shiftLine`: a word-band SHIFT line (`SHIFT: boldness Bold → Daring`) when the band word
 *     changed, else '' (sub-band moves aren't worth surfacing). NEVER contains the raw integer.
 *
 * The caller is responsible for capturing the previous hex into `previousSnapshot` (WO-05 §C)
 * before applying, so `buildDriftAlert` can surface the SHIFT on the next payload read.
 */
export function applyGoalOutcomeNudge(
    npc: NPCEntry,
    goal: Goal,
    band: Band,
): { hexPatch?: PersonalityHex; shiftLine: string } {
    // No hex to nudge on an un-populated NPC (Piece B fills it first).
    const hex = npc.personalityHex;
    if (!hex) return { shiftLine: '' };

    let axis: HexAxis | undefined;
    let by = 0;

    if (band === 'critSuccess') {
        // crit-success on any goal → +boldness (the spec names "bold/combat goal"; we keep it
        // general: a crit success is itself a bold-making event). Tunable via OUTCOME_AXIS_MAP.
        axis = OUTCOME_AXIS_MAP.critSuccessBold as HexAxis;
        by = +1;
    } else if (band === 'critFail' || (band === 'fail' && goal.failStreak >= 2)) {
        // sustained failure (failStreak ≥ 2, or a critFail) → −composure
        axis = OUTCOME_AXIS_MAP.repeatedFailure as HexAxis;
        by = -1;
    }

    if (!axis || by === 0) return { shiftLine: '' };

    const prev = hex[axis];
    const next = hexDelta(hex, axis, by);
    if (next[axis] === prev) {
        // Clamped at the band edge — no actual move, nothing to surface.
        return { shiftLine: '' };
    }
    const shiftLine = formatHexShift(axis, prev, next[axis]);
    return { hexPatch: next, shiftLine };
}

/**
 * WO-06 §1 — power-rung tier-cross. Pure, +0 LLM. Called after a goal resolves; checks
 * `canCrossTier` (the §9.7 both-conditions rule: progress >= quota AND justifiedEventFlag —
 * grinding alone can NEVER cross). If the cross fires, `consumeTierCross` clears the flag +
 * resets progress (returns an updated Goal), and the NPC's `skillRung` bumps by +1 clamped to
 * `rungCeiling`. If already at ceiling, the cross is still consumed (progress resets) but the
 * rung does not bump — the NPC has hit their talent cap.
 *
 * Returns `null` when no cross fires (the common case). Otherwise:
 *   - `updatedGoal`: the goal with flag cleared + progress 0 (caller persists into goalRecords).
 *   - `rungPatch`: the new `skillRung` integer when the rung bumped, else `undefined` (ceiling).
 *   - `rungShiftLine`: a word-band SHIFT line (`SHIFT: Skilled → Expert`) when the label changed,
 *     else `''` (ceiling-hit: no label move, nothing to surface). NEVER contains the raw integer.
 *
 * The caller is responsible for capturing the previous rung into `previousSnapshot` (WO-05 §C)
 * so `buildDriftAlert` surfaces the SHIFT on the next payload read.
 */
export function applyTierCross(
    npc: NPCEntry,
    resolvedGoal: Goal,
): { updatedGoal: Goal; rungPatch?: number; rungShiftLine: string } | null {
    if (!canCrossTier(resolvedGoal)) return null;

    const updatedGoal = consumeTierCross(resolvedGoal);
    const current = npc.skillRung ?? RUNG_DEFAULT;
    const ceiling = npc.rungCeiling ?? RUNG_CEILING_DEFAULT;

    if (current >= ceiling) {
        // At cap — consume the cross (progress resets) but do not bump.
        return { updatedGoal, rungPatch: undefined, rungShiftLine: '' };
    }

    const newRung = Math.min(current + 1, ceiling);
    const rungShiftLine = formatRungShift(current, newRung);
    return { updatedGoal, rungPatch: newRung, rungShiftLine };
}