import { BAND_PROGRESS } from './agencyConstants';
import type { Band } from './agencyConstants';
import type { Goal } from '../../../types';

/**
 * Returns progress delta from BAND_PROGRESS mapping.
 */
export function progressDelta(band: Band): number {
    return BAND_PROGRESS[band] ?? 0;
}

/**
 * Applies a resolved success/failure band to a goal, returning a new immutable Goal object.
 * - Updates goal.progress (clamped to >= 0 unless roll is a critFail setback).
 * - Updates lastAdvancedTick to now.
 * - Sets justifiedEventFlag to true on critSuccess (preserves it otherwise).
 * - Flips state to 'achieved' when progress >= quota.
 */
export function applyBandToGoal(goal: Goal, band: Band, now: number): Goal {
    const delta = progressDelta(band);
    let newProgress = goal.progress + delta;

    // Clamped >= 0 unless critFail setback
    if (band !== 'critFail' && newProgress < 0) {
        newProgress = 0;
    }

    const justifiedEventFlag = band === 'critSuccess' ? true : goal.justifiedEventFlag;

    let state = goal.state;
    if (newProgress >= goal.quota) {
        state = 'achieved';
    }

    return {
        ...goal,
        progress: newProgress,
        lastAdvancedTick: now,
        justifiedEventFlag,
        state
    };
}

/**
 * Returns whether this goal is ready to cross a growth-envelope tier.
 * Requires both progress >= quota and the justifiedEventFlag.
 */
export function canCrossTier(goal: Goal): boolean {
    return goal.progress >= goal.quota && !!goal.justifiedEventFlag;
}

/**
 * Consumes the tier-cross flag. Clears justifiedEventFlag and resets progress to 0.
 * Returns a new immutable Goal object.
 */
export function consumeTierCross(goal: Goal): Goal {
    return {
        ...goal,
        justifiedEventFlag: false,
        progress: 0
    };
}
