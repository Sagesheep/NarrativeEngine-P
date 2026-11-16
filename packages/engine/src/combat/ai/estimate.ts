import { abilityRoll, builtinStats } from '../glyphs/builtins';
import { casterStats, damageDice, saveDc, saveModifier } from '../glyphs/numbers';
import { EFFECTS } from '../glyphs/registry';
import { rangeOf } from '../grid';
import { abilityCost } from '../glyphs/validate';
import type { CombatState, Combatant, GlyphAbility } from '../types';
import { AI_LIMITS } from './tables';

export type Dice = { count: number; sides: number; bonus: number };

export function hitChance(bonus: number, ac: number, disadvantage: boolean): number {
    const p = Math.min(0.95, Math.max(0.05, (21 + bonus - ac) / 20));
    return disadvantage ? p * p : p;
}

export function critChance(disadvantage: boolean): number {
    return disadvantage ? 0.0025 : 0.05;
}

export function averageOf(d: Dice): number {
    return Math.max(1, d.count * (d.sides + 1) / 2 + d.bonus);
}

const tails = new Map<string, number[]>();

function distribution(count: number, sides: number): number[] {
    const key = `${count}d${sides}`;
    const hit = tails.get(key);
    if (hit) return hit;
    let dist = [1];
    for (let i = 0; i < count; i++) {
        const next = new Array<number>(dist.length + sides).fill(0);
        for (let s = 0; s < dist.length; s++) {
            if (dist[s] === 0) continue;
            for (let f = 1; f <= sides; f++) next[s + f] += dist[s] / sides;
        }
        dist = next;
    }
    const tail = new Array<number>(dist.length + 1).fill(0);
    for (let s = dist.length - 1; s >= 0; s--) tail[s] = tail[s + 1] + dist[s];
    tails.set(key, tail);
    return tail;
}

export function atLeast(d: Dice, need: number): number {
    if (need <= 1) return 1;
    if (d.count <= 0 || d.sides <= 0) return Math.max(1, d.bonus) >= need ? 1 : 0;
    const tail = distribution(Math.min(d.count, 12), Math.min(d.sides, 20));
    const index = need - d.bonus;
    if (index <= 0) return 1;
    return index < tail.length ? tail[index] : 0;
}

export function saveFails(dc: number, modifier: number): number {
    return Math.min(1, Math.max(0, (dc - 1 - modifier) / 20));
}

export function effectiveHp(c: Pick<Combatant, 'hp' | 'tempHp'>): number {
    return Math.max(0, c.hp) + Math.max(0, c.tempHp ?? 0);
}

export function damageFactor(target: Pick<Combatant, 'weaknesses' | 'resistances'>, type: string): number {
    const lower = type.toLowerCase();
    const weak = (target.weaknesses ?? []).some(w => w.toLowerCase() === lower);
    const resist = (target.resistances ?? []).some(r => r.toLowerCase() === lower);
    if (weak && !resist) return 2;
    if (resist && !weak) return 0.5;
    return 1;
}

export function kitDice(user: Combatant, ability: GlyphAbility, augments: readonly string[]): Dice {
    const amplify = augments.filter(a => a === 'amplify').length;
    if (user.abilityDamage) return { count: user.abilityDamage.count + amplify, sides: user.abilityDamage.sides, bonus: user.abilityDamage.bonus };
    return { count: damageDice(casterStats(user), ability.effects.find(e => e.id === 'damage')?.augments ?? []), sides: 6, bonus: 0 };
}

function weaponPerTurn(c: Combatant): number {
    const p = hitChance(c.attackBonus, AI_LIMITS.typicalAc, false);
    return p * averageOf(c.damage);
}

export function kitUsable(state: Pick<CombatState, 'round'>, c: Combatant, ability: GlyphAbility): boolean {
    if (typeof c.maxMp === 'number' && Number.isFinite(c.maxMp)) return (c.mp ?? 0) >= abilityCost(ability);
    return (c.cooldowns?.[ability.id] ?? 0) <= state.round + 1;
}

function kitPerTurn(state: Pick<CombatState, 'round'>, c: Combatant): number {
    let best = 0;
    for (const ability of c.kit ?? []) {
        if (!kitUsable(state, c, ability)) continue;
        const damage = ability.effects.find(e => e.id === 'damage' || e.id === 'drain');
        if (!damage) continue;
        const dice = kitDice(c, ability, damage.augments);
        const stats = casterStats(c);
        const roll = abilityRoll(ability);
        const p = roll === 'attack' ? hitChance(stats.proficiency + stats.castingMod, AI_LIMITS.typicalAc, false) : 0.75;
        const area = ability.form.id === 'burst' || ability.form.id === 'cone' || ability.form.id === 'line' ? 1.5 : 1;
        best = Math.max(best, p * averageOf(dice) * area);
    }
    return best;
}

export function isHealer(c: Pick<Combatant, 'kit'>): boolean {
    return (c.kit ?? []).some(a => a.effects.some(e => EFFECTS[e.id]?.helpful === true && (e.id === 'heal' || e.id === 'shield' || e.id === 'haste')));
}

export function isController(c: Pick<Combatant, 'kit'>): boolean {
    return (c.kit ?? []).some(a => a.effects.some(e => e.id === 'stun' || e.id === 'slow' || e.id === 'push' || e.id === 'pull'));
}

export function hasAreaKit(c: Pick<Combatant, 'kit'>): boolean {
    return (c.kit ?? []).some(a => a.form.id === 'burst' || a.form.id === 'cone' || a.form.id === 'line');
}

export function shootsFar(state: Pick<CombatState, 'round'>, c: Combatant): boolean {
    return rangeOf(c) === 'ranged'
        || (c.kit ?? []).some(a => a.form.id === 'projectile' && a.effects.some(e => e.id === 'damage' || e.id === 'drain') && kitUsable(state, c, a));
}

export function threatOf(state: Pick<CombatState, 'round'>, c: Combatant, pcBonus: number): number {
    let t = Math.max(weaponPerTurn(c), kitPerTurn(state, c));
    if (isHealer(c)) t += 2;
    if (isController(c)) t += 1.5;
    if (c.side === 'player') t += pcBonus;
    return t;
}

export function shoveDc(user: Combatant): number {
    return saveDc(builtinStats(user));
}

export function betterSaveModifier(target: Combatant): number {
    return Math.max(saveModifier(target, 'STR'), saveModifier(target, 'DEX'));
}
