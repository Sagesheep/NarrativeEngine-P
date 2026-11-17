import { abilityMod, proficiencyForLevel, TIER_LEVEL } from '../abilities';
import { TIER_TABLE } from '../tiers';
import type { AbilityKey, AugmentId, CombatSheet, Combatant, CombatTier, GlyphAbility } from '../types';
import { GLYPH_NUMBERS as N, MP_BASE, MP_MIN, MP_PER_CASTING_MOD, MP_PER_LEVEL, SUMMON_TIERS } from './registry';

export type CasterStats = { proficiency: number; castingMod: number };

export const CASTING_KEYS: readonly AbilityKey[] = ['INT', 'WIS', 'CHA'];

export function count(augments: readonly AugmentId[], id: AugmentId): number {
    return augments.filter(a => a === id).length;
}

export function extended(base: number, times: number): number {
    return base + Math.floor(base * N.extendFactor * times);
}

export function defaultCastingAbility(scores: Record<AbilityKey, number>): AbilityKey {
    let best: AbilityKey = 'INT';
    for (const key of CASTING_KEYS) if ((scores[key] ?? 10) > (scores[best] ?? 10)) best = key;
    return best;
}

export function castingAbilityOf(sheet: Pick<CombatSheet, 'abilities' | 'castingAbility'>): AbilityKey {
    return sheet.castingAbility && CASTING_KEYS.includes(sheet.castingAbility) ? sheet.castingAbility : defaultCastingAbility(sheet.abilities);
}

export function deriveMaxMp(sheet: Pick<CombatSheet, 'abilities' | 'castingAbility' | 'level'>): number {
    const level = Math.max(1, Math.floor(sheet.level));
    const mod = abilityMod(sheet.abilities[castingAbilityOf(sheet)] ?? 10);
    return Math.max(MP_MIN, MP_BASE + MP_PER_LEVEL * level + MP_PER_CASTING_MOD * mod);
}

export function proficiencyOf(c: Pick<Combatant, 'proficiency' | 'tier'>): number {
    return Number.isFinite(c.proficiency) ? c.proficiency as number : proficiencyForLevel(TIER_LEVEL[c.tier] ?? 3);
}

export function castingModOf(c: Pick<Combatant, 'castingAbility' | 'abilities'>): number {
    const key = c.castingAbility ?? defaultCastingAbility(c.abilities);
    return abilityMod(c.abilities[key] ?? 10);
}

export function casterStats(c: Pick<Combatant, 'proficiency' | 'tier' | 'castingAbility' | 'abilities'>): CasterStats {
    return { proficiency: proficiencyOf(c), castingMod: castingModOf(c) };
}

export function saveDc(stats: CasterStats): number {
    return 8 + stats.proficiency + stats.castingMod;
}

export function saveModifier(c: Combatant, key: AbilityKey): number {
    const base = abilityMod(c.abilities[key] ?? 10);
    if (c.side === 'player') {
        const proficient = key === 'CON' || key === (c.castingAbility ?? defaultCastingAbility(c.abilities));
        return base + (proficient ? proficiencyOf(c) : 0);
    }
    return base + (TIER_TABLE[c.tier]?.save ?? 0);
}

export function formAugments(ability: GlyphAbility): readonly AugmentId[] {
    return ability.form.augments;
}

export function projectileRange(ability: GlyphAbility): number {
    return extended(N.projectileRange, count(formAugments(ability), 'extend'));
}

export function lineLength(ability: GlyphAbility): number {
    return extended(N.lineLength, count(formAugments(ability), 'extend'));
}

export function lineWidth(ability: GlyphAbility): number {
    return 1 + 2 * count(formAugments(ability), 'widen');
}

export function coneLength(ability: GlyphAbility): number {
    return extended(N.coneLength, count(formAugments(ability), 'extend')) + count(formAugments(ability), 'widen');
}

export function burstRange(ability: GlyphAbility): number {
    return extended(N.burstRange, count(formAugments(ability), 'extend'));
}

export function burstRadius(ability: GlyphAbility): number {
    return N.burstRadius + count(formAugments(ability), 'widen');
}

export function dashLength(ability: GlyphAbility): number {
    return extended(N.dashLength, count(formAugments(ability), 'extend'));
}

export function splitCount(ability: GlyphAbility): number {
    return count(formAugments(ability), 'split');
}

export function isQuickened(ability: GlyphAbility): boolean {
    return count(formAugments(ability), 'quicken') > 0;
}

export function blinkRange(augments: readonly AugmentId[]): number {
    return N.blinkRange + N.blinkExtend * count(augments, 'extend');
}

export function power(augments: readonly AugmentId[]): number {
    return count(augments, 'amplify') - count(augments, 'dampen');
}

export function damageDice(stats: CasterStats, augments: readonly AugmentId[]): number {
    return Math.max(1, stats.proficiency + power(augments));
}

export function drainDice(stats: CasterStats, augments: readonly AugmentId[]): number {
    return Math.max(1, Math.max(1, stats.proficiency - 1) + power(augments));
}

export function healDice(stats: CasterStats, augments: readonly AugmentId[]): number {
    return Math.max(1, stats.proficiency + power(augments));
}

export function shieldAmount(stats: CasterStats, augments: readonly AugmentId[]): number {
    return Math.max(1, 2 * stats.proficiency + stats.castingMod + stats.proficiency * power(augments));
}

export function pushDistance(augments: readonly AugmentId[]): number {
    return Math.max(1, N.pushDistance + power(augments));
}

export function leapGlyphRange(augments: readonly AugmentId[]): number {
    return N.leapGlyphRange + N.leapExtend * count(augments, 'extend');
}

export function gravitySquares(augments: readonly AugmentId[]): number {
    return Math.max(1, N.gravitySquares + power(augments));
}

export function decayDice(stats: CasterStats, augments: readonly AugmentId[]): number {
    return Math.max(1, stats.proficiency - N.decayDrop + power(augments));
}

export function snareTurns(augments: readonly AugmentId[]): number {
    return N.snareTurns + count(augments, 'sustain');
}

export function fearTurns(augments: readonly AugmentId[]): number {
    return N.fearTurns + count(augments, 'sustain');
}

export function sigilRange(ability: GlyphAbility): number {
    return extended(N.sigilRange, count(formAugments(ability), 'extend'));
}

export function sigilRounds(ability: GlyphAbility): number {
    return N.sigilRounds + N.sigilSustain * count(formAugments(ability), 'sustain');
}

export function mantleRadius(ability: GlyphAbility): number {
    return N.mantleRadius + count(formAugments(ability), 'widen');
}

export function mantleRounds(ability: GlyphAbility): number {
    return N.mantleRounds + count(formAugments(ability), 'sustain');
}

export function chainRange(ability: GlyphAbility): number {
    return extended(N.chainRange, count(formAugments(ability), 'extend'));
}

export function chainJumps(ability: GlyphAbility): number {
    return N.chainJumps + count(formAugments(ability), 'widen');
}

export function wallRange(ability: GlyphAbility): number {
    return extended(N.wallRange, count(formAugments(ability), 'extend'));
}

export function wallLength(ability: GlyphAbility): number {
    return N.wallLength + 2 * count(formAugments(ability), 'widen');
}

export function wallRounds(ability: GlyphAbility): number {
    return N.wallRounds + count(formAugments(ability), 'sustain');
}

export function isDelayed(ability: GlyphAbility): boolean {
    return count(formAugments(ability), 'delay') > 0;
}

export function stunTurns(augments: readonly AugmentId[]): number {
    return N.stunTurns + count(augments, 'extend');
}

export function slowTurns(augments: readonly AugmentId[]): number {
    return N.slowTurns + count(augments, 'extend');
}

export function hasteTurns(augments: readonly AugmentId[]): number {
    return N.hasteTurns + count(augments, 'extend');
}

export function shieldTurns(augments: readonly AugmentId[]): number {
    return N.shieldTurns + count(augments, 'extend');
}

export function barrierRounds(augments: readonly AugmentId[]): number {
    return N.barrierRounds + count(augments, 'extend');
}

export function summonRounds(augments: readonly AugmentId[]): number {
    return N.summonRounds + count(augments, 'extend');
}

export function summonTier(augments: readonly AugmentId[]): CombatTier {
    return SUMMON_TIERS[Math.min(SUMMON_TIERS.length - 1, count(augments, 'amplify'))];
}
