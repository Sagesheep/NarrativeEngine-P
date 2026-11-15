import { abilityMod } from './abilities';
import { PC_POINT_BUY } from './pointBuy';
import { deriveSheet } from './sheet';
import { castingAbilityOf, deriveMaxMp } from './glyphs/numbers';
import { DEFAULT_DAMAGE_TYPE } from './tiers';
import type { CarriedItem, Combatant, DamageSpec, PcCombatantInput, WeaponQuality } from './types';

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

function dieFor(quality: WeaponQuality | undefined, defaultWeaponDie: number | undefined): { count: number; sides: number } {
    if (quality && WEAPON_QUALITY_DICE[quality]) return WEAPON_QUALITY_DICE[quality];
    const sides = Number.isFinite(defaultWeaponDie) && (defaultWeaponDie as number) >= 2
        ? Math.floor(defaultWeaponDie as number)
        : FALLBACK_WEAPON_DIE;
    return { count: 1, sides };
}

function weaponDie(input: PcCombatantInput): { count: number; sides: number } {
    const weapon = input.weapon;
    if (!weapon) return UNARMED_DIE;
    return dieFor(weapon.quality, input.defaultWeaponDie);
}

export const MAX_CARRIED_ITEMS = 12;
export const CARRIED_NAME_MAX = 60;
export const THROWABLE_DIE = 4;

function carriedOf(input: PcCombatantInput): CarriedItem[] {
    const seen = new Set<string>();
    const out: CarriedItem[] = [];
    for (const item of input.items ?? []) {
        const name = typeof item?.name === 'string' ? item.name.replace(/\s+/g, ' ').trim().slice(0, CARRIED_NAME_MAX) : '';
        if (!name || typeof item.id !== 'string' || seen.has(item.id)) continue;
        seen.add(item.id);
        const die = item.throwable ? { count: 1, sides: THROWABLE_DIE } : dieFor(item.quality, input.defaultWeaponDie);
        out.push({
            id: item.id,
            name,
            count: die.count,
            sides: die.sides,
            ...(item.damageType?.trim() ? { damageType: item.damageType.trim() } : {}),
            ...(item.equipped ? { equipped: true } : {}),
        });
        if (out.length >= MAX_CARRIED_ITEMS) break;
    }
    return out;
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
    const maxMp = deriveMaxMp(input.sheet);
    const mpRaw = Number.isFinite(input.mpCurrent) ? Math.floor(input.mpCurrent as number) : maxMp;
    const casting = input.kit
        ? {
            kit: input.kit.map(a => ({ ...a, form: { ...a.form, augments: [...a.form.augments] }, effects: a.effects.map(e => ({ ...e, augments: [...e.augments] })) })),
            mp: Math.max(0, Math.min(maxMp, mpRaw)),
            maxMp,
            proficiency: derived.proficiency,
            castingAbility: castingAbilityOf(input.sheet),
        }
        : {};
    const carried = carriedOf(input);
    return {
        id: input.id ?? PC_COMBATANT_ID,
        name: input.name.trim() || 'You',
        side: 'player',
        controller: 'player',
        tier: PC_POINT_BUY[input.sheet.budget]?.tier ?? 'grunt',
        ...(input.sheet.archetype ? { archetype: input.sheet.archetype } : {}),
        ...(input.look ? { look: input.look } : {}),
        ...(input.weapon?.name?.trim() ? { weaponName: input.weapon.name.trim() } : {}),
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
        ...(carried.length > 0 ? { carried } : {}),
        ...casting,
    };
}
