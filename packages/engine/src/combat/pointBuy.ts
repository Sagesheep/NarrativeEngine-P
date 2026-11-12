import { ABILITY_KEYS } from './abilities';
import type { AbilityKey, AbilityScores, Archetype, CombatTier, PointBudget } from './types';

export type PointBuyConfig = {
    totalPoints: number;
    min: number;
    max: number;
    tier: CombatTier;
};

export const PC_POINT_BUY: Readonly<Record<PointBudget, PointBuyConfig>> = {
    NORMAL: { totalPoints: 27, min: 8, max: 15, tier: 'grunt' },
    OP: { totalPoints: 37, min: 8, max: 20, tier: 'elite' },
};

export const POINT_BUY_COST: Readonly<Record<number, number>> = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9,
};

export const OP_POINT_BUY_COST: Readonly<Record<number, number>> = {
    8: 0, 9: 1, 10: 2, 11: 3, 12: 4, 13: 5, 14: 7, 15: 9, 16: 11, 17: 13, 18: 15, 19: 17, 20: 19,
};

export const INVALID_POINT_COST = 99;

export function getPointCost(value: number, budget: PointBudget): number {
    const table = budget === 'OP' ? OP_POINT_BUY_COST : POINT_BUY_COST;
    return table[value] ?? INVALID_POINT_COST;
}

export const DEFAULT_ABILITIES: Readonly<AbilityScores> = {
    STR: 8, DEX: 8, CON: 8, INT: 8, WIS: 8, CHA: 8,
};

export type PointBuyAllocation = {
    abilities: AbilityScores;
    budget: PointBudget;
    pointsSpent: number;
    pointsRemaining: number;
    isValid: boolean;
};

export function validateAllocation(abilities: AbilityScores, budget: PointBudget): PointBuyAllocation {
    const cfg = PC_POINT_BUY[budget];
    let pointsSpent = 0;
    let isValid = true;
    for (const key of ABILITY_KEYS) {
        const value = abilities[key];
        if (!Number.isInteger(value) || value < cfg.min || value > cfg.max) isValid = false;
        pointsSpent += getPointCost(value, budget);
    }
    if (pointsSpent > cfg.totalPoints) isValid = false;
    return {
        abilities,
        budget,
        pointsSpent,
        pointsRemaining: cfg.totalPoints - pointsSpent,
        isValid,
    };
}

export function allocateAbility(
    current: AbilityScores,
    key: AbilityKey,
    value: number,
    budget: PointBudget,
): AbilityScores {
    const cfg = PC_POINT_BUY[budget];
    const clamped = Math.max(cfg.min, Math.min(cfg.max, Math.round(value)));
    return { ...current, [key]: clamped };
}

export const ARCHETYPE_KEYS: readonly Archetype[] = ['bulwark', 'assassin', 'caster', 'skirmisher', 'brute'];

export const ARCHETYPE_PRESETS: Readonly<Record<Archetype, Readonly<AbilityScores>>> = {
    bulwark: { STR: 14, DEX: 10, CON: 15, INT: 8, WIS: 13, CHA: 12 },
    assassin: { STR: 10, DEX: 15, CON: 14, INT: 10, WIS: 13, CHA: 10 },
    caster: { STR: 8, DEX: 14, CON: 13, INT: 15, WIS: 12, CHA: 10 },
    skirmisher: { STR: 12, DEX: 15, CON: 14, INT: 8, WIS: 13, CHA: 10 },
    brute: { STR: 15, DEX: 13, CON: 15, INT: 8, WIS: 12, CHA: 8 },
};
