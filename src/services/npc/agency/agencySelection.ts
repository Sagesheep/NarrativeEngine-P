import {
    DRIVE_MULT,
    COLOR_ROLL_BASE,
    COLOR_ROLL_TRAIT_BONUS,
    COLOR_ROLL_TRAITS
} from './agencyConstants';
import type { Goal, SceneStakes, NPCEntry } from '../../../types';

export type TickChoice =
    | { kind: 'goal'; goal: Goal }
    | { kind: 'color' }
    | { kind: 'need' }
    | { kind: 'idle' };

/**
 * Returns drive_mult from an NPC's personalityHex.drive (-3..+3) via band -> DRIVE_MULT mapping.
 * Clamps out-of-range values to [-3, 3] and rounds to ensure exact matching.
 */
export function driveMult(hexDrive: number): number {
    const clamped = Math.max(-3, Math.min(3, Math.round(hexDrive)));
    return DRIVE_MULT[clamped] ?? 1.0;
}

/**
 * context_allow: 'dangerous' scenes block long-goals (allow medium); 'calm'/'tense' allow all.
 * Returns 0 if blocked, 1 if allowed.
 */
export function contextAllow(goal: Goal, sceneStakes: SceneStakes): 0 | 1 {
    if (sceneStakes === 'dangerous' && goal.horizon === 'long') {
        return 0;
    }
    return 1;
}

/**
 * lazy neglect-based goal heat scoring.
 * neglect = now - goal.lastAdvancedTick
 * score = base_heat + neglect * drive_mult * context_allow + opportunity_bonus
 */
export function goalScore(
    goal: Goal,
    now: number,
    hexDrive: number,
    sceneStakes: SceneStakes,
    opportunityBonus: number = 0
): number {
    const neglect = now - goal.lastAdvancedTick;
    const dm = driveMult(hexDrive);
    const ca = contextAllow(goal, sceneStakes);
    return goal.base_heat + neglect * dm * ca + opportunityBonus;
}

/**
 * Resolves the tick choice for a selected NPC.
 * 1. Executes color roll (novelty/rare whiplash).
 * 2. If color roll doesn't trigger, finds highest-score active and allowed goal.
 *    Ties broken deterministically: highest score, then first by index (lowest index).
 * 3. If no active goals are eligible:
 *    - If the NPC has goals but all are blocked/inactive, returns 'need'.
 *    - If the NPC has no goals at all, returns 'idle' (never from absence).
 */
export function chooseTick(
    npc: NPCEntry,
    now: number,
    sceneStakes: SceneStakes,
    rng: () => number = Math.random
): TickChoice {
    // 1. Color roll
    let colorProb = COLOR_ROLL_BASE;
    if (npc.traits) {
        const hasBonusTrait = npc.traits.some(t => (COLOR_ROLL_TRAITS as readonly string[]).includes(t));
        if (hasBonusTrait) {
            colorProb += COLOR_ROLL_TRAIT_BONUS;
        }
    }

    if (rng() < colorProb) {
        return { kind: 'color' };
    }

    // 2. Select highest-score active goal
    const goals = npc.goalRecords ?? [];
    const hexDrive = npc.personalityHex?.drive ?? 0;

    let bestGoal: Goal | null = null;
    let bestScore = -Infinity;
    let bestIndex = -1;

    for (let i = 0; i < goals.length; i++) {
        const goal = goals[i];
        if (goal.state === 'active' && contextAllow(goal, sceneStakes) === 1) {
            const score = goalScore(goal, now, hexDrive, sceneStakes);
            if (score > bestScore) {
                bestScore = score;
                bestGoal = goal;
                bestIndex = i;
            } else if (score === bestScore) {
                if (bestIndex === -1 || i < bestIndex) {
                    bestGoal = goal;
                    bestIndex = i;
                }
            }
        }
    }

    if (bestGoal) {
        return { kind: 'goal', goal: bestGoal };
    }

    // 3. Needs surface only if all goals blocked — NEVER from absence
    if (goals.length > 0) {
        return { kind: 'need' };
    }

    return { kind: 'idle' };
}
