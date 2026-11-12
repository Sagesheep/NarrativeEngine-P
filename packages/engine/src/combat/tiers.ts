import { ARCHETYPE_PRESETS } from './pointBuy';
import type { AbilityScores, Archetype, CombatTier, DamageSpec, Rng, TierBlock } from './types';

export type TierRow = {
    hp: number;
    ac: number;
    attack: number;
    damage: Omit<DamageSpec, 'type'>;
};

export const TIER_TABLE: Readonly<Record<CombatTier, TierRow>> = {
    minion: { hp: 4, ac: 10, attack: 2, damage: { count: 1, sides: 4, bonus: 0 } },
    grunt: { hp: 8, ac: 11, attack: 3, damage: { count: 1, sides: 6, bonus: 0 } },
    elite: { hp: 30, ac: 13, attack: 5, damage: { count: 1, sides: 8, bonus: 2 } },
    boss: { hp: 65, ac: 15, attack: 7, damage: { count: 2, sides: 8, bonus: 3 } },
    legendary: { hp: 120, ac: 17, attack: 9, damage: { count: 3, sides: 8, bonus: 4 } },
};

export const DEFAULT_JITTER_RANGE = 10;

export const BASE_ENEMY_ABILITIES: Readonly<AbilityScores> = {
    STR: 12, DEX: 12, CON: 12, INT: 10, WIS: 10, CHA: 10,
};

const JITTER_TIERS: ReadonlySet<CombatTier> = new Set<CombatTier>(['minion', 'grunt']);

export const DEFAULT_DAMAGE_TYPE = 'physical';

function damageTypeFromLook(look: string | undefined): string {
    const words = (look ?? '').toLowerCase();
    const known = ['fire', 'frost', 'ice', 'cold', 'lightning', 'thunder', 'acid', 'poison', 'necrotic', 'radiant', 'psychic', 'force', 'water', 'shadow'];
    const hit = known.find(k => new RegExp(`\\b${k}\\b`).test(words));
    return hit ?? 'arcane';
}

export function buildTierBlock(
    tier: CombatTier,
    archetype: Archetype | undefined,
    jitter: number,
    rng: Rng,
    look?: string,
): TierBlock {
    const row = TIER_TABLE[tier] ?? TIER_TABLE.grunt;
    let hp = row.hp;
    let ac = row.ac;
    let attackBonus = row.attack;
    let bonus = row.damage.bonus;
    let type = DEFAULT_DAMAGE_TYPE;

    switch (archetype) {
        case 'bulwark':
            ac += 2;
            hp *= 1.25;
            attackBonus -= 1;
            break;
        case 'assassin':
            attackBonus += 2;
            hp *= 0.8;
            break;
        case 'brute':
            bonus = Math.round(bonus * 1.25);
            ac -= 1;
            break;
        case 'caster':
            hp *= 0.8;
            attackBonus += 1;
            type = damageTypeFromLook(look);
            break;
        case 'skirmisher':
            ac += 1;
            break;
        default:
            break;
    }

    const range = Number.isFinite(jitter) ? Math.max(0, Math.min(50, jitter)) : 0;
    if (range > 0 && JITTER_TIERS.has(tier)) {
        const pct = rng.int(-Math.round(range), Math.round(range));
        hp *= 1 + pct / 100;
    }

    const abilities = archetype ? { ...ARCHETYPE_PRESETS[archetype] } : { ...BASE_ENEMY_ABILITIES };
    return {
        abilities,
        maxHp: Math.max(1, Math.round(hp)),
        ac,
        attackBonus,
        damage: { count: row.damage.count, sides: row.damage.sides, bonus, type },
    };
}
