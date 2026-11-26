import { TIMESKIP_K, TIMESKIP_CAP } from './agencyConstants';
import { goalScore, contextAllow } from './agencySelection';
import type { Goal, SceneStakes } from '../../../types';

/**
 * Calculates ticks budget for a timeskip duration in weeks using a log-curve.
 * ticks = min(TIMESKIP_CAP, round( TIMESKIP_K * log2(1 + weeks) ))
 * If weeks <= 0, returns 0.
 */
export function ticksForDuration(weeks: number): number {
    if (weeks <= 0) return 0;
    const ticks = TIMESKIP_K * Math.log2(1 + weeks);
    return Math.min(TIMESKIP_CAP, Math.round(ticks));
}

/**
 * Given active goals, budget, and NPC state, allocates ticks to the hottest goals first.
 * Neglect score updates dynamically as a goal receives ticks (virtually updating lastAdvancedTick to now).
 * Returns array of goal indices in the original goals array, in allocation order.
 */
export function allocateTicks(
    goals: Goal[],
    budget: number,
    now: number,
    hexDrive: number,
    sceneStakes: SceneStakes
): number[] {
    const allocation: number[] = [];
    if (budget <= 0 || goals.length === 0) {
        return allocation;
    }

    // Clone lastAdvancedTick values virtually so we don't mutate input.
    const virtualLastAdvancedTick = goals.map(g => g.lastAdvancedTick);

    for (let tick = 0; tick < budget; tick++) {
        let bestIndex = -1;
        let bestScore = -Infinity;

        for (let i = 0; i < goals.length; i++) {
            const goal = goals[i];
            
            // Only 'active' and context-allowed goals can be allocated ticks
            if (goal.state !== 'active') continue;
            if (contextAllow(goal, sceneStakes) === 0) continue;

            const virtualGoal: Goal = {
                ...goal,
                lastAdvancedTick: virtualLastAdvancedTick[i]
            };

            const score = goalScore(virtualGoal, now, hexDrive, sceneStakes);

            if (score > bestScore) {
                bestScore = score;
                bestIndex = i;
            } else if (score === bestScore) {
                // Tie-breaks deterministic: highest score, then first by index (lowest index)
                if (bestIndex === -1 || i < bestIndex) {
                    bestIndex = i;
                }
            }
        }

        // If no active context-allowed goals are found, stop allocation
        if (bestIndex === -1) {
            break;
        }

        allocation.push(bestIndex);
        virtualLastAdvancedTick[bestIndex] = now;
    }

    return allocation;
}
