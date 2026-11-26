import {
    KARMA_PER_FAIL,
    KARMA_CAP
} from './agencyConstants';
import type { Band } from './agencyConstants';
import type { Goal } from '../../../types';

// Expose the Band type from constants for convenience.
export type { Band };

/**
 * Returns the karma bonus based on current fail streak.
 * karma_bonus = min(failStreak * KARMA_PER_FAIL, KARMA_CAP)
 */
export function karmaBonus(failStreak: number): number {
    return Math.min(failStreak * KARMA_PER_FAIL, KARMA_CAP);
}

/**
 * Maps d20 roll margin to success band.
 * Override table logic: nat 20 is always critSuccess, nat 1 is always critFail.
 */
export function bandFromMargin(nat: number, margin: number): Band {
    if (nat === 20) return 'critSuccess';
    if (nat === 1) return 'critFail';
    if (margin >= 10) return 'critSuccess';
    if (margin >= 3) return 'success';
    if (margin >= 0) return 'successBut';
    if (margin >= -3) return 'failBut';
    if (margin >= -9) return 'fail';
    return 'critFail';
}

/**
 * Resolves a goal roll against a DC, returning detailed dice stats.
 * roll = d20 + karmaBonus + extraMods
 * margin = roll - DC
 */
export function rollGoal(
    goal: Goal,
    dc: number,
    extraMods: number = 0,
    rng: () => number = Math.random
): { nat: number; roll: number; margin: number; band: Band } {
    const nat = Math.floor(rng() * 20) + 1;
    const karma = karmaBonus(goal.failStreak ?? 0);
    const roll = nat + karma + extraMods;
    const margin = roll - dc;
    const band = bandFromMargin(nat, margin);

    return { nat, roll, margin, band };
}

/**
 * Returns the updated fail streak.
 * Success-tier resets to 0, failure/setback-tier increases by 1.
 */
export function nextFailStreak(prev: number, band: Band): number {
    if (band === 'critSuccess' || band === 'success' || band === 'successBut') {
        return 0;
    }
    return prev + 1;
}
