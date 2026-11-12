import type { AbilityKey, CombatTier } from './types';

export const ABILITY_KEYS: readonly AbilityKey[] = ['STR', 'DEX', 'CON', 'INT', 'WIS', 'CHA'];

export const TIER_LEVEL: Readonly<Record<CombatTier, number>> = {
    minion: 1,
    grunt: 3,
    elite: 6,
    boss: 10,
    legendary: 15,
};

export function abilityMod(score: number): number {
    return Math.floor((score - 10) / 2);
}

export function proficiencyForLevel(level: number): number {
    if (level <= 4) return 2;
    if (level <= 8) return 3;
    if (level <= 12) return 4;
    if (level <= 16) return 5;
    return 6;
}
