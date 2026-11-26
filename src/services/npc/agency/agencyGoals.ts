import type { NPCEntry, Goal, GoalHorizon } from '../../../types';
import { BASE_HEAT, AMBITIOUS_HEAT_BONUS, QUOTA_BY_HORIZON } from './agencyConstants';

// NPC Agency Phase 3 — lazy migration: upgrade Phase-2 want STRINGS into the §9.6 Goal records.
// Pure + immutable. `text` mirrors the want string so the player-visible `wants` layer stays intact;
// every other column is engine-internal. Short wants are NOT goals (they stay pool flavor, §9.5).

function makeGoal(text: string, horizon: GoalHorizon, now: number, ambitious: boolean): Goal {
    const heatBonus = horizon === 'long' && ambitious ? AMBITIOUS_HEAT_BONUS : 0;
    return {
        text,
        horizon,
        tier: 'default',              // mature gating happened at want-draw time; goals seed as default
        base_heat: BASE_HEAT[horizon] + heatBonus,
        lastAdvancedTick: now,        // neglect = now − this → 0 at creation
        failStreak: 0,
        progress: 0,
        quota: QUOTA_BY_HORIZON[horizon],
        state: 'active',
        // justifiedEventFlag omitted (undefined) until a Crit Success sets it
    };
}

/**
 * Build Goal records from medium/long want strings. `medium[]` → med goals, `long` → one long goal.
 * Empty/blank strings are skipped. `traits` only affects base_heat (`ambitious`). Pure.
 */
export function buildGoalsFromWants(
    medium: string[],
    long: string,
    traits: string[],
    now: number = 0,
): Goal[] {
    const ambitious = traits.includes('ambitious');
    const goals: Goal[] = [];
    for (const raw of medium ?? []) {
        const text = (raw ?? '').trim();
        if (text) goals.push(makeGoal(text, 'med', now, ambitious));
    }
    const longText = (long ?? '').trim();
    if (longText) goals.push(makeGoal(longText, 'long', now, ambitious));
    return goals;
}

/**
 * Idempotent NPC-level upgrade: returns the NPC's existing goalRecords untouched if already present,
 * else seeds them from `wants`. Skips isPC (the player authors their own arc).
 */
export function upgradeWantsToGoals(npc: NPCEntry, now: number = 0): Goal[] {
    if (npc.goalRecords && npc.goalRecords.length > 0) return npc.goalRecords;
    if (npc.isPC || !npc.wants) return npc.goalRecords ?? [];
    return buildGoalsFromWants(npc.wants.medium ?? [], npc.wants.long ?? '', npc.traits ?? [], now);
}
