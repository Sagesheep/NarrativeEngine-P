import { abilityMod, proficiencyForLevel, TIER_LEVEL } from './abilities';
import { DEFAULT_ABILITIES, PC_POINT_BUY } from './pointBuy';
import type { CombatSheet, DerivedSheet, PointBudget } from './types';

export function levelForBudget(budget: PointBudget): number {
    return TIER_LEVEL[PC_POINT_BUY[budget].tier];
}

export function createDefaultSheet(budget: PointBudget = 'NORMAL'): CombatSheet {
    return {
        abilities: { ...DEFAULT_ABILITIES },
        budget,
        level: levelForBudget(budget),
        needsAllocation: true,
    };
}

export function deriveSheet(sheet: CombatSheet): DerivedSheet {
    const level = Math.max(1, Math.floor(sheet.level));
    const conMod = abilityMod(sheet.abilities.CON);
    const dexMod = abilityMod(sheet.abilities.DEX);
    const firstLevel = Math.max(1, 10 + conMod);
    const perLevel = Math.max(1, 6 + conMod);
    return {
        maxHp: firstLevel + (level - 1) * perLevel,
        ac: 10 + dexMod,
        proficiency: proficiencyForLevel(level),
        initiativeMod: dexMod,
    };
}
