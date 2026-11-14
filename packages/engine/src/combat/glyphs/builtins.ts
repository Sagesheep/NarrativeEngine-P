import { abilityMod } from '../abilities';
import { canTarget } from '../core';
import { coverBetween, distance, hasLineOfSight, rangeOf, RANGED_DISTANCE, REACH_DISTANCE, terrainOf } from '../grid';
import type { AttackRange, CombatState, Combatant, DamageSpec, EffectId, GlyphAbility, Pos } from '../types';
import { proficiencyOf } from './numbers';
import type { CasterStats } from './numbers';
import { FORMS, GLYPH_NUMBERS as N, UNSTUNNABLE_TIERS } from './registry';
import type { FormRoll } from './registry';

export const BUILTIN_PREFIX = 'builtin:';
export const BUILTIN_ATTACK_ID = 'builtin:attack';
export const BUILTIN_DEFEND_ID = 'builtin:defend';
export const BUILTIN_DASH_ID = 'builtin:dash';
export const BUILTIN_SHOVE_ID = 'builtin:shove';
export const BUILTIN_JUMP_ID = 'builtin:jump';
export const BUILTIN_THROW_ID = 'builtin:throw';
export const BUILTIN_HELP_ID = 'builtin:help';
export const BUILTIN_STUNT_ID = 'builtin:stunt';
export const BUILTIN_EFFECT_IDS: readonly EffectId[] = ['weapon', 'guard', 'sprint', 'leap', 'rally'];
export const THROWN_WEAPON_NAME = 'something snatched up';

export type ShotOverride = { range: AttackRange; limit: number };

export type AttackCheck = {
    ok: boolean;
    reason?: 'invalid_target' | 'out_of_range' | 'no_line_of_sight';
    range: AttackRange;
    distance: number;
    cover: number;
    disadvantage: boolean;
};

export function isBuiltinId(id: unknown): boolean {
    return typeof id === 'string' && id.startsWith(BUILTIN_PREFIX);
}

export function isBuiltinEffect(id: unknown): boolean {
    return (BUILTIN_EFFECT_IDS as readonly unknown[]).includes(id);
}

export function hostileAdjacent(state: CombatState, actor: Combatant, at: Pos): boolean {
    return Object.values(state.combatants).some(o => o.id !== actor.id && canTarget(actor, o) && !!o.position && distance(o.position, at) <= 1);
}

export function checkAttack(state: CombatState, actorId: string, targetId: string, from?: Pos, shot?: ShotOverride): AttackCheck {
    const actor = state.combatants[actorId];
    const target = state.combatants[targetId];
    const range = shot?.range ?? (actor ? rangeOf(actor) : 'close');
    if (!actor || !target || !canTarget(actor, target)) return { ok: false, reason: 'invalid_target', range, distance: 0, cover: 0, disadvantage: false };
    const grid = terrainOf(state);
    const at = from ?? actor.position;
    if (!grid || !at || !target.position) return { ok: true, range, distance: 1, cover: 0, disadvantage: false };
    const dist = distance(at, target.position);
    if (range === 'close') {
        return dist <= 1
            ? { ok: true, range, distance: dist, cover: 0, disadvantage: false }
            : { ok: false, reason: 'out_of_range', range, distance: dist, cover: 0, disadvantage: false };
    }
    const limit = shot?.limit ?? (range === 'reach' ? REACH_DISTANCE : RANGED_DISTANCE);
    if (dist > limit) return { ok: false, reason: 'out_of_range', range, distance: dist, cover: 0, disadvantage: false };
    if (!hasLineOfSight(grid, at, target.position)) return { ok: false, reason: 'no_line_of_sight', range, distance: dist, cover: 0, disadvantage: false };
    if (range === 'reach') return { ok: true, range, distance: dist, cover: 0, disadvantage: false };
    return {
        ok: true,
        range,
        distance: dist,
        cover: coverBetween(grid, at, target.position),
        disadvantage: hostileAdjacent(state, actor, at),
    };
}

export function weaponReach(range: AttackRange): number {
    if (range === 'ranged') return RANGED_DISTANCE;
    return range === 'reach' ? REACH_DISTANCE : 1;
}

export function strengthMod(c: Pick<Combatant, 'abilities'>): number {
    return abilityMod(c.abilities.STR ?? 10);
}

export function builtinStats(c: Pick<Combatant, 'abilities' | 'proficiency' | 'tier'>): CasterStats {
    return { proficiency: proficiencyOf(c), castingMod: strengthMod(c) };
}

export type ImprovisedWeapon = { attackBonus: number; damage: DamageSpec };

export function throwProfile(c: Pick<Combatant, 'abilities' | 'proficiency' | 'tier'>): ImprovisedWeapon {
    const mod = strengthMod(c);
    return {
        attackBonus: proficiencyOf(c) + mod,
        damage: { count: 1, sides: N.throwDie, bonus: mod, type: 'bludgeoning' },
    };
}

export function throwShot(): ShotOverride {
    return { range: 'ranged', limit: N.throwRange };
}

export function shotOf(ability: GlyphAbility): ShotOverride | undefined {
    return ability.builtin?.kind === 'throw' ? throwShot() : undefined;
}

export function leapRange(c: Pick<Combatant, 'abilities'>): number {
    return Math.max(N.jumpBase, N.jumpBase + strengthMod(c));
}

export function tooLargeToShove(target: Pick<Combatant, 'tier'>): boolean {
    return UNSTUNNABLE_TIERS.has(target.tier);
}

export function recoverable(state: CombatState, target: Combatant): boolean {
    if (target.status !== 'down' || target.summonerId) return false;
    return !(state.defeatMode === 'ironman' && target.side === 'player');
}

export function abilityRoll(ability: GlyphAbility): FormRoll {
    const kind = ability.builtin?.kind;
    if (kind === 'shove') return 'save';
    if (kind === 'help') return 'none';
    if (kind === 'stunt') return ability.form.id === 'burst' ? 'save' : 'none';
    return FORMS[ability.form.id].roll;
}

export function builtinAttack(c: Pick<Combatant, 'range'>): GlyphAbility {
    const range = rangeOf(c);
    return {
        id: BUILTIN_ATTACK_ID,
        name: 'Attack',
        form: { id: range === 'ranged' ? 'projectile' : 'touch', augments: [] },
        effects: [{ id: 'weapon', augments: [] }],
        source: 'preset',
        builtin: { kind: 'attack', events: 'compact', range },
    };
}

export function builtinDefend(): GlyphAbility {
    return {
        id: BUILTIN_DEFEND_ID,
        name: 'Defend',
        form: { id: 'self', augments: [] },
        effects: [{ id: 'guard', augments: [] }],
        source: 'preset',
        builtin: { kind: 'defend', events: 'compact' },
    };
}

export function builtinDash(): GlyphAbility {
    return {
        id: BUILTIN_DASH_ID,
        name: 'Dash',
        form: { id: 'self', augments: [] },
        effects: [{ id: 'sprint', augments: [] }],
        source: 'preset',
        builtin: { kind: 'dash', slot: 'action' },
    };
}

export function builtinShove(): GlyphAbility {
    return {
        id: BUILTIN_SHOVE_ID,
        name: 'Shove',
        form: { id: 'touch', augments: [] },
        effects: [{ id: 'push', augments: [] }],
        source: 'preset',
        builtin: { kind: 'shove', slot: 'bonus' },
    };
}

export function builtinJump(): GlyphAbility {
    return {
        id: BUILTIN_JUMP_ID,
        name: 'Jump',
        form: { id: 'self', augments: [] },
        effects: [{ id: 'leap', augments: [] }],
        source: 'preset',
        builtin: { kind: 'jump', slot: 'bonus' },
    };
}

export function builtinThrow(): GlyphAbility {
    return {
        id: BUILTIN_THROW_ID,
        name: 'Throw',
        form: { id: 'projectile', augments: [] },
        effects: [{ id: 'weapon', augments: [] }],
        source: 'preset',
        builtin: { kind: 'throw', slot: 'action', range: 'ranged' },
    };
}

export function builtinHelp(): GlyphAbility {
    return {
        id: BUILTIN_HELP_ID,
        name: 'Help',
        form: { id: 'touch', augments: [] },
        effects: [{ id: 'rally', augments: [] }],
        source: 'preset',
        builtin: { kind: 'help', slot: 'action' },
    };
}

export function builtinAbilities(c: Pick<Combatant, 'range'>): GlyphAbility[] {
    return [builtinAttack(c), builtinDefend(), builtinDash(), builtinShove(), builtinJump(), builtinThrow(), builtinHelp()];
}

export function findBuiltin(c: Pick<Combatant, 'range'> | undefined, abilityId: string): GlyphAbility | undefined {
    if (!c || !isBuiltinId(abilityId)) return undefined;
    return builtinAbilities(c).find(a => a.id === abilityId);
}

export function availableAbilities(state: CombatState, combatantId: string): GlyphAbility[] {
    const c = state.combatants[combatantId];
    if (!c) return [];
    return [...builtinAbilities(c), ...(c.kit ?? [])];
}
