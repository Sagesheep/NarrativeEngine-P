import { abilityMod } from '../abilities';
import { buildTierBlock } from '../tiers';
import { canStep, coverBetween, distance, samePos, sameTeam, speedOf, terrainOf, tileAt, traceLine } from '../grid';
import {
    applyDamage, canAttackWith, canTarget, currentActorId, currentTurn, DEFEND_CONDITION, dismissSummon, emit, freshTurn, hasCondition,
    HASTED, hazardStrike, isPlayerSide, markDown, rollDamage, setCondition, SHIELDED, SLOWED, spendAttackAction, STUNNED,
} from '../core';
import type { Draft } from '../core';
import type { AbilityKey, AttackRange, CombatState, Combatant, DamageSpec, EffectId, GlyphAbility, Pos, TurnState } from '../types';
import { abilityRoll, builtinStats, checkAttack, findBuiltin, recoverable, shotOf, THROWN_WEAPON_NAME, throwProfile } from './builtins';
import { EFFECTS, GLYPH_NUMBERS as N, UNSTUNNABLE_TIERS } from './registry';
import {
    barrierRounds, casterStats, damageDice, drainDice, hasteTurns, healDice, isQuickened, proficiencyOf, pushDistance, saveDc, saveModifier,
    shieldAmount, shieldTurns, slowTurns, stunTurns, summonRounds, summonTier,
} from './numbers';
import type { CasterStats } from './numbers';
import { abilityCost, validateAbility } from './validate';
import { abilityTargets, isEmptyTile, legalAims } from './targeting';
import type { AimResult } from './targeting';
import type { StuntPlan, StuntStep } from './stunt';

export type AbilitySlot = 'action' | 'bonus';

export type AbilityCheck = {
    ok: boolean;
    reason?: string;
    cost: number;
    slot: AbilitySlot;
    ability?: GlyphAbility;
    aim?: AimResult;
};

export function findKitAbility(c: Pick<Combatant, 'kit'> | undefined, abilityId: string): GlyphAbility | undefined {
    return c?.kit?.find(a => a.id === abilityId);
}

export function findUsableAbility(c: Pick<Combatant, 'kit' | 'range'> | undefined, abilityId: string): GlyphAbility | undefined {
    return findBuiltin(c, abilityId) ?? findKitAbility(c, abilityId);
}

export function abilitySlot(ability: GlyphAbility): AbilitySlot {
    if (ability.builtin?.slot) return ability.builtin.slot;
    return isQuickened(ability) ? 'bonus' : 'action';
}

export function usesMp(c: Pick<Combatant, 'maxMp'>): boolean {
    return typeof c.maxMp === 'number' && Number.isFinite(c.maxMp);
}

export function abilityReadiness(state: CombatState, actor: Combatant, ability: GlyphAbility, turn: TurnState | null): string | null {
    if (ability.builtin) {
        if (!turn || turn.actorId !== actor.id) return 'not this combatant\'s turn';
        if (abilitySlot(ability) === 'bonus') {
            if (turn.bonusUsed) return 'the bonus action is already used';
        } else if (!canAttackWith(turn)) {
            return 'the action is already used';
        }
        if (ability.builtin.kind === 'dash' && freshTurn(state, actor.id).moveLeft <= 0) return 'no movement to add';
        if (ability.builtin.kind === 'jump' && turn.moveLeft < 1) return 'not enough movement';
        return null;
    }
    const cost = abilityCost(ability);
    if (validateAbility(ability, { maxChainLength: Number.MAX_SAFE_INTEGER, maxSummons: state.maxSummons ?? 2 }).length > 0) return 'the ability is not valid';
    if (!turn || turn.actorId !== actor.id) return 'not this combatant\'s turn';
    const slot = abilitySlot(ability);
    if (slot === 'bonus' && turn.bonusUsed) return 'the bonus action is already used';
    if (slot === 'action' && turn.actionUsed) return 'the action is already used';
    if (usesMp(actor)) {
        if ((actor.mp ?? 0) < cost) return 'not enough MP';
    } else if ((actor.cooldowns?.[ability.id] ?? 0) > state.round) {
        return 'the ability is recharging';
    }
    return null;
}

export function checkAbility(state: CombatState, actorId: string, abilityId: string, aim?: Pos | null): AbilityCheck {
    const actor = state.combatants[actorId];
    const ability = findUsableAbility(actor, abilityId);
    const base = { cost: ability ? abilityCost(ability) : 0, slot: ability ? abilitySlot(ability) : 'action' as AbilitySlot };
    if (state.outcome) return { ok: false, reason: 'the fight is over', ...base };
    if (!actor || currentActorId(state) !== actorId || actor.status !== 'up') return { ok: false, reason: 'not this combatant\'s turn', ...base };
    if (!ability) return { ok: false, reason: 'unknown ability', ...base };
    const ready = abilityReadiness(state, actor, ability, currentTurn(state));
    if (ready) return { ok: false, reason: ready, ...base, ability };
    if (aim === undefined) {
        return legalAims(state, actorId, ability).length > 0
            ? { ok: true, ...base, ability }
            : { ok: false, reason: 'no target', ...base, ability };
    }
    const result = abilityTargets(state, actorId, ability, aim);
    if (!result.ok) return { ok: false, reason: result.reason ?? 'no target', ...base, ability };
    return { ok: true, ...base, ability, aim: result };
}

type WeaponRoll = {
    natural: number;
    total: number;
    ac: number;
    cover: number;
    range: AttackRange;
    disadvantage: boolean;
    defending: boolean;
    adjacentShot: boolean;
    weapon?: string;
};

type Ctx = {
    draft: Draft;
    user: Combatant;
    ability: GlyphAbility;
    stats: CasterStats;
    aim: AimResult;
    type: string;
    saves: Map<string, boolean>;
    rolls: Map<string, WeaponRoll>;
    maximise: boolean;
};

function isStunt(ability: GlyphAbility): boolean {
    return ability.builtin?.kind === 'stunt';
}

function statsFor(user: Combatant, ability: GlyphAbility): CasterStats {
    const check = ability.builtin?.check;
    if (check) return { proficiency: proficiencyOf(user), castingMod: abilityMod(user.abilities[check.ability] ?? 10) };
    return ability.builtin ? builtinStats(user) : casterStats(user);
}

function signDir(from: Pos, to: Pos): Pos {
    return { x: Math.sign(to.x - from.x), y: Math.sign(to.y - from.y) };
}

function livingAt(state: CombatState, p: Pos, exceptId: string): boolean {
    return Object.values(state.combatants).some(c => c.id !== exceptId && c.status === 'up' && samePos(c.position, p));
}

function isWilling(ctx: Ctx, target: Combatant): boolean {
    return target.id === ctx.user.id || sameTeam(ctx.user.side, target.side);
}

function tag(ctx: Ctx): { builtin?: string } {
    const profile = ctx.ability.builtin;
    return profile && profile.events !== 'compact' ? { builtin: profile.kind } : {};
}

function betterSave(target: Combatant): AbilityKey {
    return saveModifier(target, 'DEX') > saveModifier(target, 'STR') ? 'DEX' : 'STR';
}

function rollSave(ctx: Ctx, target: Combatant, key: AbilityKey): boolean {
    const cacheKey = `${target.id}:${key}`;
    const cached = ctx.saves.get(cacheKey);
    if (cached !== undefined) return cached;
    const dc = saveDc(ctx.stats);
    const natural = ctx.draft.rng.roll(20);
    const total = natural + saveModifier(target, key);
    const success = total >= dc;
    ctx.saves.set(cacheKey, success);
    emit(ctx.draft, {
        type: 'save',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { save: key, dc, natural, total, success, ability: ctx.ability.name, ...tag(ctx) },
        text: success
            ? `${target.name} succeeds on a ${key} save (${total} against DC ${dc}).`
            : `${target.name} fails a ${key} save (${total} against DC ${dc}).`,
    });
    return success;
}

function needsSave(ctx: Ctx, effect: EffectId, target: Combatant): AbilityKey | null {
    if (abilityRoll(ctx.ability) !== 'save') return null;
    if (ctx.ability.builtin?.kind === 'shove') return betterSave(target);
    if (isStunt(ctx.ability) && effect === 'weapon') return 'DEX';
    return EFFECTS[effect].save ?? null;
}

function damageMultiplier(target: Combatant, type: string): { factor: number; weak: boolean; resist: boolean } {
    const lower = type.toLowerCase();
    const weak = (target.weaknesses ?? []).some(w => w.toLowerCase() === lower);
    const resist = (target.resistances ?? []).some(r => r.toLowerCase() === lower);
    if (weak && !resist) return { factor: 2, weak, resist };
    if (resist && !weak) return { factor: 0.5, weak, resist };
    return { factor: 1, weak, resist };
}

function dealDamage(ctx: Ctx, target: Combatant, dice: { count: number; sides: number; bonus: number }, crit: boolean, saveKey: AbilityKey | null, kind: 'damage' | 'drain'): number {
    const saved = saveKey ? rollSave(ctx, target, saveKey) : false;
    const rolled = ctx.maximise
        ? Math.max(1, dice.count * dice.sides + dice.bonus)
        : rollDamage(ctx.draft.rng, crit ? dice.count * 2 : dice.count, dice.sides, dice.bonus);
    const halved = saved ? Math.floor(rolled / 2) : rolled;
    const mult = damageMultiplier(target, ctx.type);
    const amount = Math.floor(halved * mult.factor);
    if (amount <= 0) return 0;
    const result = applyDamage(target, amount);
    emit(ctx.draft, {
        type: 'ability_damage',
        actorId: ctx.user.id,
        targetId: target.id,
        data: {
            ability: ctx.ability.name, kind, damage: amount, damageType: ctx.type, saved, crit,
            weakness: mult.factor > 1, resisted: mult.factor < 1, absorbed: result.absorbed,
            hpBefore: result.hpBefore, tempBefore: result.tempBefore, hpAfter: target.hp,
        },
        text: `${target.name} takes ${amount} ${ctx.type} damage${result.absorbed > 0 ? ` (${result.absorbed} absorbed by a shield)` : ''}${saved ? ', halved by the save' : ''}.`,
    });
    if (target.hp <= 0) markDown(ctx.draft, target, { actorId: ctx.user.id });
    return amount;
}

function heal(ctx: Ctx, target: Combatant, amount: number, source: 'heal' | 'drain'): void {
    const before = target.hp;
    target.hp = Math.min(target.maxHp, target.hp + amount);
    emit(ctx.draft, {
        type: 'heal',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { ability: ctx.ability.name, amount: target.hp - before, hpBefore: before, hpAfter: target.hp, source },
        text: `${target.name} recovers ${target.hp - before} HP.`,
    });
}

function addCondition(ctx: Ctx, target: Combatant, id: string, turns: number): void {
    const s = ctx.draft.state;
    const own = currentActorId(s) === target.id && s.turn?.actorId === target.id;
    setCondition(target, { id, turns, sourceId: ctx.user.id, ...(own && id !== STUNNED ? { appliedTurn: s.turnCount ?? 0 } : {}) });
    const unit = turns === 1 ? 'turn' : 'turns';
    emit(ctx.draft, {
        type: 'condition_added',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { condition: id, turns, ability: ctx.ability.name },
        text: `${target.name} is ${id} for ${turns} ${unit}.`,
    });
}

function moveBy(ctx: Ctx, target: Combatant, kind: 'push' | 'pull', squares: number): void {
    const terrain = terrainOf(ctx.draft.state);
    const origin = ctx.aim.origin;
    if (!terrain || !origin || !target.position || samePos(origin, target.position)) return;
    const away = signDir(origin, target.position);
    const dir = kind === 'push' ? away : { x: -away.x, y: -away.y };
    const from = { ...target.position };
    let at = { ...target.position };
    const path: Pos[] = [];
    for (let i = 0; i < squares; i++) {
        const next = { x: at.x + dir.x, y: at.y + dir.y };
        if (!canStep(terrain, at, next) || livingAt(ctx.draft.state, next, target.id)) break;
        at = next;
        path.push(next);
    }
    const moved = path.length;
    const shoved = ctx.ability.builtin?.kind === 'shove' || isStunt(ctx.ability);
    if (moved === 0) {
        if (shoved) {
            emit(ctx.draft, {
                type: 'pushed',
                actorId: ctx.user.id,
                targetId: target.id,
                data: { kind, squares: 0, ability: ctx.ability.name, moves: [], ...tag(ctx) },
                text: isStunt(ctx.ability) ? `${target.name} has nowhere to go.` : `${target.name} is shoved but has nowhere to go.`,
            });
        }
        return;
    }
    target.position = at;
    const unit = moved === 1 ? 'square' : 'squares';
    emit(ctx.draft, {
        type: 'pushed',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { kind, squares: moved, ability: ctx.ability.name, moves: [{ id: target.id, from, to: { ...at } }], ...tag(ctx) },
        text: kind === 'push' ? `${target.name} is pushed back ${moved} ${unit}.` : `${target.name} is pulled ${moved} ${unit}.`,
    });
    const grid = ctx.draft.state.grid;
    if (shoved && grid) {
        for (const p of path) {
            if (target.status !== 'up') break;
            if (tileAt(grid, p) === 'hazard') hazardStrike(ctx.draft, target);
        }
    }
}

function teleport(ctx: Ctx, to: Pos, kind: 'blink' | 'dash' | 'leap', towardId?: string, over?: string[]): void {
    const from = ctx.user.position as Pos;
    if (samePos(from, to)) return;
    ctx.user.position = { ...to };
    const toward = towardId ? ctx.draft.state.combatants[towardId] : undefined;
    const squares = distance(from, to);
    const text = kind === 'blink'
        ? (isStunt(ctx.ability) ? `${ctx.user.name} gets ${squares} ${squares === 1 ? 'square' : 'squares'} across.` : `${ctx.user.name} blinks ${squares} squares.`)
        : kind === 'leap'
            ? `${ctx.user.name} leaps ${squares} ${squares === 1 ? 'square' : 'squares'}.`
            : `${ctx.user.name} dashes ${squares} squares to ${toward?.name ?? 'the target'}.`;
    emit(ctx.draft, {
        type: 'teleported',
        actorId: ctx.user.id,
        ...(towardId ? { targetId: towardId } : {}),
        data: {
            kind, squares, ability: ctx.ability.name, moves: [{ id: ctx.user.id, from: { ...from }, to: { ...to } }],
            ...(over ? { over } : {}), ...tag(ctx),
        },
        text,
    });
}

const LEAP_TERRAIN: readonly string[] = ['hazard', 'difficult', 'cover'];

function leapTo(ctx: Ctx, to: Pos): void {
    const s = ctx.draft.state;
    const from = ctx.user.position as Pos;
    const grid = s.grid;
    const crossed = new Set<string>();
    if (grid) {
        for (const step of traceLine(from, to).slice(1, -1)) {
            for (const p of step) crossed.add(tileAt(grid, p));
        }
    }
    if (s.turn) s.turn = { ...s.turn, moveLeft: Math.max(0, s.turn.moveLeft - distance(from, to)) };
    teleport(ctx, to, 'leap', undefined, LEAP_TERRAIN.filter(k => crossed.has(k)));
}

function sprint(ctx: Ctx): void {
    const s = ctx.draft.state;
    const gain = freshTurn(s, ctx.user.id).moveLeft;
    if (s.turn) s.turn = { ...s.turn, moveLeft: s.turn.moveLeft + gain, dashed: true };
}

function rally(ctx: Ctx, target: Combatant): void {
    const s = ctx.draft.state;
    const removed = [STUNNED, SLOWED].filter(id => hasCondition(target, id));
    if (target.status === 'down') {
        if (!recoverable(s, target)) return;
        const hpBefore = target.hp;
        target.conditions = target.conditions.filter(c => c.id !== STUNNED && c.id !== SLOWED);
        target.hp = 1;
        target.status = 'up';
        emit(ctx.draft, {
            type: 'rallied',
            actorId: ctx.user.id,
            targetId: target.id,
            data: { kind: 'revive', removed, hpBefore, hpAfter: 1, ability: ctx.ability.name, ...tag(ctx) },
            text: `${ctx.user.name} hauls ${target.name} back to their feet.`,
        });
        return;
    }
    if (removed.length === 0) return;
    target.conditions = target.conditions.filter(c => c.id !== STUNNED && c.id !== SLOWED);
    emit(ctx.draft, {
        type: 'rallied',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { kind: 'shake', removed, ability: ctx.ability.name, ...tag(ctx) },
        text: `${ctx.user.name} shakes ${target.name} out of it.`,
    });
}

function swap(ctx: Ctx, target: Combatant): void {
    const a = ctx.user.position;
    const b = target.position;
    if (!a || !b) return;
    ctx.user.position = { ...b };
    target.position = { ...a };
    emit(ctx.draft, {
        type: 'swapped',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { ability: ctx.ability.name, moves: [{ id: ctx.user.id, from: { ...a }, to: { ...b } }, { id: target.id, from: { ...b }, to: { ...a } }] },
        text: `${ctx.user.name} and ${target.name} swap places.`,
    });
}

function applyShield(ctx: Ctx, target: Combatant, amount: number, turns: number): void {
    const existing = target.tempHp ?? 0;
    if (existing > amount) {
        emit(ctx.draft, {
            type: 'shield',
            actorId: ctx.user.id,
            targetId: target.id,
            data: { ability: ctx.ability.name, amount, applied: false, tempBefore: existing, tempAfter: existing },
            text: `${target.name} already holds a stronger shield.`,
        });
        return;
    }
    target.tempHp = amount;
    target.conditions = target.conditions.filter(c => c.id !== SHIELDED);
    const s = ctx.draft.state;
    const own = currentActorId(s) === target.id && s.turn?.actorId === target.id;
    target.conditions.push({ id: SHIELDED, turns, sourceId: ctx.user.id, ...(own ? { appliedTurn: s.turnCount ?? 0 } : {}) });
    emit(ctx.draft, {
        type: 'shield',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { ability: ctx.ability.name, amount, applied: true, turns, tempBefore: existing, tempAfter: amount },
        text: `${target.name} gains ${amount} temporary HP for ${turns} turns.`,
    });
}

function applyHaste(ctx: Ctx, target: Combatant, turns: number): void {
    const s = ctx.draft.state;
    const already = hasCondition(target, HASTED);
    addCondition(ctx, target, HASTED, turns);
    if (!already && s.turn && s.turn.actorId === target.id && currentActorId(s) === target.id) {
        s.turn = {
            ...s.turn,
            moveLeft: s.turn.moveLeft + (s.grid ? speedOf(target) : 0),
            extraActions: (s.turn.extraActions ?? 0) + 1,
        };
    }
}

function applyStun(ctx: Ctx, target: Combatant, turns: number): void {
    if (UNSTUNNABLE_TIERS.has(target.tier)) {
        addCondition(ctx, target, SLOWED, N.slowTurns);
        return;
    }
    if (target.stunGuard) {
        emit(ctx.draft, {
            type: 'unaffected',
            actorId: ctx.user.id,
            targetId: target.id,
            data: { reason: 'stun_guard', ability: ctx.ability.name },
            text: `${target.name} shakes off the stun; it was stunned too recently.`,
        });
        return;
    }
    addCondition(ctx, target, STUNNED, turns);
}

function raiseBarrier(ctx: Ctx, rounds: number): void {
    const s = ctx.draft.state;
    const tiles = ctx.aim.barrierTiles ?? [];
    if (tiles.length === 0) return;
    const expiresRound = s.round + rounds;
    s.barriers = [...(s.barriers ?? []), ...tiles.map(pos => ({ pos: { ...pos }, expiresRound, sourceId: ctx.user.id }))];
    emit(ctx.draft, {
        type: 'barrier',
        actorId: ctx.user.id,
        data: { ability: ctx.ability.name, tiles: tiles.map(p => ({ ...p })), expiresRound, ...tag(ctx) },
        text: `${ctx.user.name} raises a barrier of ${tiles.length} ${tiles.length === 1 ? 'square' : 'squares'} until round ${expiresRound}.`,
    });
}

function summonName(state: CombatState, base: string): string {
    const lower = base.toLowerCase();
    const same = Object.values(state.combatants).filter(c => c.summonerId && (c.name.toLowerCase() === lower || c.name.toLowerCase().startsWith(`${lower} `))).length;
    return same === 0 ? base : `${base} ${same + 1}`;
}

function summon(ctx: Ctx, augments: GlyphAbility['effects'][number]['augments']): void {
    const s = ctx.draft.state;
    const at = ctx.aim.summonAt;
    if (!at) return;
    const cap = s.maxSummons ?? 2;
    const mine = s.order
        .map(id => s.combatants[id])
        .filter((c): c is Combatant => !!c && c.summonerId === ctx.user.id && c.status === 'up')
        .sort((a, b) => (a.summonSeq ?? 0) - (b.summonSeq ?? 0));
    while (mine.length >= Math.max(1, cap)) dismissSummon(ctx.draft, mine.shift() as Combatant, 'replaced');
    const tier = summonTier(augments);
    const block = buildTierBlock(tier, undefined, 0, ctx.draft.rng);
    const seq = (s.nextSummon ?? 0) + 1;
    s.nextSummon = seq;
    let id = `summon${seq}`;
    while (s.combatants[id]) id = `${id}_`;
    const expiresRound = s.round + summonRounds(augments);
    const name = summonName(s, ctx.ability.name);
    s.combatants[id] = {
        id,
        name,
        side: isPlayerSide(ctx.user.side) ? 'ally' : ctx.user.side,
        controller: isPlayerSide(ctx.user.side) && s.partyControl === 'player' ? 'player' : 'engine',
        tier,
        abilities: block.abilities,
        maxHp: block.maxHp,
        hp: block.maxHp,
        ac: block.ac,
        attackBonus: block.attackBonus,
        damage: { ...block.damage, type: ctx.type },
        initiative: ctx.user.initiative,
        status: 'up',
        conditions: [],
        position: { ...at },
        range: 'close',
        summonerId: ctx.user.id,
        summonSeq: seq,
        expiresRound,
    };
    const userIndex = s.order.indexOf(ctx.user.id);
    let insertAt = userIndex + 1;
    for (let i = userIndex + 1; i < s.order.length; i++) {
        const c = s.combatants[s.order[i]];
        if (c?.summonerId === ctx.user.id && c.status === 'up') insertAt = i + 1;
    }
    s.order.splice(insertAt, 0, id);
    if (insertAt <= s.turnIndex) s.turnIndex += 1;
    emit(ctx.draft, {
        type: 'summoned',
        actorId: ctx.user.id,
        targetId: id,
        data: { ability: ctx.ability.name, tier, expiresRound, position: { ...at }, summonerId: ctx.user.id },
        text: `${ctx.user.name} summons ${name} (${tier}) until round ${expiresRound}.`,
    });
}

function usesWeapon(ability: GlyphAbility): boolean {
    return ability.effects.some(e => e.id === 'weapon');
}

type Wield = { attackBonus: number; damage: DamageSpec; weapon?: string };

function wieldOf(ctx: Ctx): Wield {
    if (ctx.ability.builtin?.kind === 'throw') return { ...throwProfile(ctx.user), weapon: THROWN_WEAPON_NAME };
    return { attackBonus: ctx.user.attackBonus, damage: ctx.user.damage, ...(ctx.user.weaponName ? { weapon: ctx.user.weaponName } : {}) };
}

function weaponRoll(ctx: Ctx, target: Combatant): { hit: boolean; crit: boolean } {
    const user = ctx.user;
    const wield = wieldOf(ctx);
    const check = checkAttack(ctx.draft.state, user.id, target.id, undefined, shotOf(ctx.ability));
    const defending = hasCondition(target, DEFEND_CONDITION);
    const disadvantage = defending || check.disadvantage || hasCondition(user, SLOWED);
    const first = ctx.draft.rng.roll(20);
    const natural = disadvantage ? Math.min(first, ctx.draft.rng.roll(20)) : first;
    const total = natural + wield.attackBonus;
    const ac = target.ac + check.cover;
    const crit = natural === 20;
    const hit = crit || (natural !== 1 && total >= ac);
    const roll: WeaponRoll = {
        natural, total, ac, cover: check.cover, range: check.range, disadvantage, defending, adjacentShot: check.disadvantage,
        ...(wield.weapon ? { weapon: wield.weapon } : {}),
    };
    ctx.rolls.set(target.id, roll);
    if (!hit) {
        const shielded = (target.tempHp ?? 0) > 0;
        emit(ctx.draft, {
            type: 'attack',
            actorId: user.id,
            targetId: target.id,
            data: { ...roll, hit: false, crit: false, fumble: natural === 1, ...(shielded ? { shielded: true } : {}) },
            text: `${user.name} attacks ${target.name} and misses.`,
        });
    }
    return { hit, crit };
}

function weaponHit(ctx: Ctx, target: Combatant, crit: boolean): void {
    const user = ctx.user;
    const spec = wieldOf(ctx).damage;
    const dmgType = spec.type;
    const count = crit ? spec.count * 2 : spec.count;
    const damage = rollDamage(ctx.draft.rng, count, spec.sides, spec.bonus);
    const result = applyDamage(target, damage);
    const shielded = result.absorbed > 0 ? { absorbed: result.absorbed, hpBefore: result.hpBefore, tempBefore: result.tempBefore } : {};
    emit(ctx.draft, {
        type: 'attack',
        actorId: user.id,
        targetId: target.id,
        data: { ...ctx.rolls.get(target.id), hit: true, crit, damage, damageType: dmgType, hpAfter: target.hp, ...shielded },
        text: crit
            ? `${user.name} lands a critical hit on ${target.name} for ${damage} ${dmgType}.`
            : `${user.name} hits ${target.name} for ${damage} ${dmgType}.`,
    });
    if (target.hp <= 0 && target.status === 'up') markDown(ctx.draft, target, { actorId: user.id });
}

function guard(ctx: Ctx, target: Combatant): void {
    target.conditions = [...target.conditions.filter(c => c.id !== DEFEND_CONDITION), { id: DEFEND_CONDITION, rounds: 1 }];
    emit(ctx.draft, { type: 'defend', actorId: target.id, data: {}, text: `${target.name} takes a defensive stance.` });
}

function attackRoll(ctx: Ctx, target: Combatant): { hit: boolean; crit: boolean } {
    if (usesWeapon(ctx.ability)) return weaponRoll(ctx, target);
    if (isWilling(ctx, target)) return { hit: true, crit: false };
    const s = ctx.draft.state;
    const terrain = terrainOf(s);
    const from = ctx.user.position;
    const pierce = ctx.ability.form.augments.includes('pierce');
    const helpfulOnly = ctx.ability.effects.every(e => EFFECTS[e.id].helpful);
    const cover = ctx.ability.form.id === 'projectile' && !pierce && !helpfulOnly && terrain && from && target.position
        ? coverBetween(terrain, from, target.position)
        : 0;
    const adjacentShot = ctx.ability.form.id === 'projectile' && !!from && Object.values(s.combatants)
        .some(o => o.id !== ctx.user.id && canTarget(ctx.user, o) && !!o.position && distance(o.position, from) <= 1);
    const defending = hasCondition(target, DEFEND_CONDITION);
    const slowed = hasCondition(ctx.user, SLOWED);
    const disadvantage = defending || adjacentShot || slowed;
    const first = ctx.draft.rng.roll(20);
    const natural = disadvantage ? Math.min(first, ctx.draft.rng.roll(20)) : first;
    const total = natural + ctx.stats.proficiency + ctx.stats.castingMod;
    const ac = target.ac + cover;
    const crit = natural === 20;
    const hit = crit || (natural !== 1 && total >= ac);
    emit(ctx.draft, {
        type: 'ability_attack',
        actorId: ctx.user.id,
        targetId: target.id,
        data: {
            ability: ctx.ability.name, natural, total, ac, cover, disadvantage, hit, crit, fumble: natural === 1,
            ...(defending ? { defending: true } : {}),
            ...(!hit && (target.tempHp ?? 0) > 0 ? { shielded: true } : {}),
        },
        text: hit
            ? `${ctx.ability.name} ${crit ? 'critically hits' : 'hits'} ${target.name} (${total} against AC ${ac}).`
            : `${ctx.ability.name} misses ${target.name} (${total} against AC ${ac}).`,
    });
    return { hit, crit };
}

export function resolveAbility(draft: Draft, actorId: string, ability: GlyphAbility, aim: AimResult): void {
    const s = draft.state;
    const user = s.combatants[actorId];
    const turn = currentTurn(s) as TurnState;
    const slot = abilitySlot(ability);
    const cost = abilityCost(ability);
    if (ability.builtin) {
        s.turn = slot === 'bonus' ? { ...turn, bonusUsed: true } : spendAttackAction(turn);
    } else {
        s.turn = slot === 'bonus' ? { ...turn, bonusUsed: true } : { ...turn, actionUsed: true };
        if (usesMp(user)) user.mp = Math.max(0, (user.mp ?? 0) - cost);
        else user.cooldowns = { ...(user.cooldowns ?? {}), [ability.id]: s.round + N.enemyCooldownRounds };
    }
    applyChain(draft, actorId, ability, aim, false);
}

function stuntAimNow(state: CombatState, step: StuntStep): AimResult | null {
    const terrain = terrainOf(state);
    if (!terrain) return null;
    if (step.aim.destination) return isEmptyTile(state, terrain, step.aim.destination) ? step.aim : null;
    if (step.aim.barrierTiles) {
        const free = step.aim.barrierTiles.filter(p => isEmptyTile(state, terrain, p));
        return free.length > 0 ? { ...step.aim, tiles: free, barrierTiles: free } : null;
    }
    return step.aim;
}

export function resolveStunt(draft: Draft, actorId: string, plan: StuntPlan): boolean {
    const s = draft.state;
    const user = s.combatants[actorId];
    const turn = currentTurn(s) as TurnState;
    s.turn = { ...turn, actionUsed: true };
    const key = plan.check.ability;
    const modifier = abilityMod(user.abilities[key] ?? 10) + proficiencyOf(user);
    const natural = draft.rng.roll(20);
    const total = natural + modifier;
    const success = natural === 20 || (natural !== 1 && total >= plan.dc);
    const difficulty = plan.difficulty.replace('_', ' ');
    emit(draft, {
        type: 'stunt_check',
        actorId,
        data: {
            ability: key, difficulty: plan.difficulty, dc: plan.dc, natural, modifier, total, success,
            fumble: natural === 1, critical: natural === 20, outcomes: plan.steps.map(st => st.outcome),
        },
        text: `${user.name} tries a stunt (${key}, ${difficulty}): ${total} against DC ${plan.dc}, ${success ? 'success' : 'failure'}${natural === 1 ? ', a natural 1' : natural === 20 ? ', a natural 20' : ''}.`,
    });
    if (natural === 1 && plan.steps[0]) {
        const first = plan.steps[0];
        const ctx: Ctx = { draft, user, ability: first.ability, stats: statsFor(user, first.ability), aim: first.aim, type: N.defaultDamageType, saves: new Map(), rolls: new Map(), maximise: false };
        addCondition(ctx, user, SLOWED, N.stuntSlowTurns);
    }
    if (!success) return false;
    for (const step of plan.steps) {
        if (user.status !== 'up') break;
        const aim = stuntAimNow(s, step);
        if (aim) applyChain(draft, actorId, step.ability, aim, natural === 20);
    }
    return true;
}

function applyChain(draft: Draft, actorId: string, ability: GlyphAbility, aim: AimResult, maximise: boolean): void {
    const s = draft.state;
    const user = s.combatants[actorId];
    const slot = abilitySlot(ability);
    const cost = abilityCost(ability);
    const type = ability.damageType?.trim() || N.defaultDamageType;
    const targetIds = aim.targetIds.filter(id => s.combatants[id]);
    if (ability.builtin?.events !== 'compact') {
        emit(draft, {
            type: 'ability',
            actorId,
            data: {
                abilityId: ability.id, name: ability.name, damageType: type, form: ability.form.id,
                effects: ability.effects.map(e => e.id), cost, slot, targets: targetIds,
                ...(usesMp(user) ? { mpAfter: user.mp } : {}),
            },
            text: `${user.name} uses ${ability.name}${usesMp(user) && !ability.builtin ? ` (${cost} MP)` : ''}.`,
        });
    }
    const ctx: Ctx = { draft, user, ability, stats: statsFor(user, ability), aim, type, saves: new Map(), rolls: new Map(), maximise };
    if (ability.form.id === 'dash' && aim.destination) teleport(ctx, aim.destination, 'dash', targetIds[0]);
    if (ability.effects.some(e => e.id === 'blink') && aim.destination) teleport(ctx, aim.destination, 'blink');
    if (ability.effects.some(e => e.id === 'leap') && aim.destination) leapTo(ctx, aim.destination);
    const roll = abilityRoll(ability);
    const crits = new Map<string, boolean>();
    let targets = targetIds.map(id => s.combatants[id]).filter(c => c.status === 'up' || ability.builtin?.kind === 'help');
    if (roll === 'attack') {
        targets = targets.filter(t => {
            const r = attackRoll(ctx, t);
            crits.set(t.id, r.crit);
            return r.hit;
        });
    }
    if (ability.form.id === 'self') targets = [user];
    for (const effect of ability.effects) {
        const a = effect.augments;
        if (effect.id === 'barrier') {
            raiseBarrier(ctx, barrierRounds(a));
            continue;
        }
        if (effect.id === 'summon') {
            summon(ctx, a);
            continue;
        }
        if (effect.id === 'blink' || effect.id === 'leap') continue;
        let drained = 0;
        for (const target of targets) {
            if (target.status !== 'up' && effect.id !== 'rally') continue;
            const saveKey = needsSave(ctx, effect.id, target);
            const crit = crits.get(target.id) ?? false;
            switch (effect.id) {
                case 'damage': {
                    const dice = user.abilityDamage
                        ? { count: user.abilityDamage.count + a.filter(x => x === 'amplify').length, sides: user.abilityDamage.sides, bonus: user.abilityDamage.bonus }
                        : { count: damageDice(ctx.stats, a), sides: 6, bonus: 0 };
                    dealDamage(ctx, target, dice, crit, saveKey, 'damage');
                    break;
                }
                case 'drain':
                    drained += dealDamage(ctx, target, { count: drainDice(ctx.stats, a), sides: 6, bonus: 0 }, crit, saveKey, 'drain');
                    break;
                case 'heal':
                    heal(ctx, target, rollDamage(draft.rng, healDice(ctx.stats, a), 4, ctx.stats.castingMod), 'heal');
                    break;
                case 'shield':
                    applyShield(ctx, target, shieldAmount(ctx.stats, a), shieldTurns(a));
                    break;
                case 'haste':
                    applyHaste(ctx, target, hasteTurns(a));
                    break;
                case 'push':
                case 'pull':
                    if (saveKey && rollSave(ctx, target, saveKey)) break;
                    moveBy(ctx, target, effect.id, pushDistance(a));
                    break;
                case 'stun':
                    if (saveKey && rollSave(ctx, target, saveKey)) break;
                    applyStun(ctx, target, stunTurns(a));
                    break;
                case 'slow':
                    if (saveKey && rollSave(ctx, target, saveKey)) break;
                    addCondition(ctx, target, SLOWED, isStunt(ability) ? N.stuntSlowTurns : slowTurns(a));
                    break;
                case 'weapon':
                    if (isStunt(ability)) {
                        const sides = ability.form.id === 'burst' ? N.stuntAreaDie : N.stuntDie;
                        dealDamage(ctx, target, { count: 1, sides, bonus: ctx.stats.castingMod }, false, saveKey, 'damage');
                        break;
                    }
                    weaponHit(ctx, target, crit);
                    break;
                case 'guard':
                    guard(ctx, target);
                    break;
                case 'sprint':
                    sprint(ctx);
                    break;
                case 'rally':
                    rally(ctx, target);
                    break;
                case 'swap':
                    if (!isWilling(ctx, target) && saveKey && rollSave(ctx, target, saveKey)) break;
                    swap(ctx, target);
                    break;
                default:
                    break;
            }
        }
        if (effect.id === 'drain' && Math.floor(drained / 2) > 0 && user.status === 'up') heal(ctx, user, Math.floor(drained / 2), 'drain');
    }
}
