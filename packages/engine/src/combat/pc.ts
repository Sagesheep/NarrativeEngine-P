import { abilityMod } from './abilities';
import { PC_POINT_BUY } from './pointBuy';
import { deriveSheet } from './sheet';
import { DEFAULT_DAMAGE_TYPE } from './tiers';
import type { Combatant, DamageSpec, PcCombatantInput, WeaponQuality } from './types';

export const PC_COMBATANT_ID = 'pc';

export const WEAPON_QUALITY_DICE: Readonly<Record<WeaponQuality, { count: number; sides: number }>> = {
    common: { count: 1, sides: 6 },
    uncommon: { count: 1, sides: 8 },
    rare: { count: 1, sides: 10 },
    epic: { count: 1, sides: 12 },
    legendary: { count: 2, sides: 8 },
};

export const UNARMED_DIE = { count: 1, sides: 4 };

export const FALLBACK_WEAPON_DIE = 6;

function weaponDie(input: PcCombatantInput): { count: number; sides: number } {
    const weapon = input.weapon;
    if (!weapon) return UNARMED_DIE;
    if (weapon.quality && WEAPON_QUALITY_DICE[weapon.quality]) return WEAPON_QUALITY_DICE[weapon.quality];
    const sides = Number.isFinite(input.defaultWeaponDie) && (input.defaultWeaponDie as number) >= 2
        ? Math.floor(input.defaultWeaponDie as number)
        : FALLBACK_WEAPON_DIE;
    return { count: 1, sides };
}

export function buildPcCombatant(input: PcCombatantInput): Combatant {
    const derived = deriveSheet(input.sheet);
    const scaling = input.weapon?.scalingStat ?? 'STR';
    const mod = abilityMod(input.sheet.abilities[scaling] ?? 10);
    const die = weaponDie(input);
    const damage: DamageSpec = {
        count: die.count,
        sides: die.sides,
        bonus: mod,
        type: input.weapon ? (input.weapon.damageType ?? DEFAULT_DAMAGE_TYPE) : 'bludgeoning',
    };
    const hpRaw = Number.isFinite(input.hpCurrent) ? Math.floor(input.hpCurrent as number) : derived.maxHp;
    const hp = Math.max(1, Math.min(derived.maxHp, hpRaw));
    return {
        id: input.id ?? PC_COMBATANT_ID,
        name: input.name.trim() || 'You',
        side: 'player',
        controller: 'player',
        tier: PC_POINT_BUY[input.sheet.budget]?.tier ?? 'grunt',
        ...(input.sheet.archetype ? { archetype: input.sheet.archetype } : {}),
        ...(input.look ? { look: input.look } : {}),
        abilities: { ...input.sheet.abilities },
        maxHp: derived.maxHp,
        hp,
        ac: derived.ac,
        attackBonus: derived.proficiency + mod,
        damage,
        initiative: 0,
        status: 'up',
        conditions: [],
        range: input.weapon?.range ?? 'close',
    };
}
