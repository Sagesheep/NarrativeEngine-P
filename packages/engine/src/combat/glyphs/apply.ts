import { abilityMod } from '../abilities';
import { buildTierBlock } from '../tiers';
import { abilityDamageType, abilityElement, blindPenalty, elementMultiplier, isImmune, revealedCover } from '../elements/rules';
import { COATED, ELEMENT_NUMBERS, ELEMENTS } from '../elements/tables';
import type { ConditionRiderId } from '../elements/tables';
import { addConditionRider, arcRider, consumeCondition, impactRider, pushRider } from './riders';
import type { RiderUnit } from './riders';
import { coverBetween, distance, samePos, sameTeam, speedOf, terrainOf, tileAt, traceLine } from '../grid';
import {
    applyDamage, canAttackWith, canTarget, currentActorId, currentTurn, DEFEND_CONDITION, dismissSummon, emit, FEARED, freshTurn, hasCondition,
    HASTED, hazardStrike, isPlayerSide, markDown, rollDamage, setCondition, SHIELDED, SLOWED, SNARED, spendAttackAction, STUNNED, VANISHED,
} from '../core';
import type { Draft } from '../core';
import type {
    AbilityKey, AttackRange, CombatCondition, CombatState, Combatant, DamageSpec, EffectId, ElementId, GlyphAbility, PlacedEffect, Pos, ThrowPayload,
    TurnState,
} from '../types';
import { abilityRoll, builtinStats, checkAttack, findBuiltin, recoverable } from './builtins';
import { DISPEL_HARMFUL, DISPEL_HELPFUL, EFFECTS, FORMS, GLYPH_NUMBERS as N, UNSTUNNABLE_TIERS } from './registry';
import {
    barrierRounds, casterStats, damageDice, decayDice, drainDice, fearTurns, gravitySquares, hasteTurns, healDice, isDelayed, isQuickened,
    mantleRadius, mantleRounds, power, proficiencyOf, pushDistance, saveDc, saveModifier, shieldAmount, shieldTurns, sigilRounds, slowTurns,
    snareTurns, stunTurns, summonRounds, summonTier, wallRounds,
} from './numbers';
import { addPlaced, endPlaced, mantleOf, placedCovers, placedOf, sigilTriggersOn, sweepOwnerless, touchesUnit } from './placed';
import {
    announceConduct, conductRow, dimBonus, leaveMarks, markedTiles, reactExtend, reactTiles, slideUnit, strikeStanding,
} from './marks';
import type { CasterStats } from './numbers';
import { abilityCost, validateAbility } from './validate';
import { abilityTargets, hasPinnedShoveTarget, isEmptyTile, legalAims } from './targeting';
import type { AimResult } from './targeting';
import { blockerLabel, previewPush, previewPushes, SHOVE_NO_ROOM } from './push';
import type { PushPreview } from './push';
import type { StuntPlan, StuntStep } from './stunt';
import { resolveThrow, throwReason } from './throw';

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
    if (actor.signature && actor.signature.abilityId === ability.id && actor.signature.usesLeft <= 0) return 'the signature move has no uses left';
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

export function checkAbility(state: CombatState, actorId: string, abilityId: string, aim?: Pos | null, payload?: ThrowPayload): AbilityCheck {
    const actor = state.combatants[actorId];
    const ability = findUsableAbility(actor, abilityId);
    const base = { cost: ability ? abilityCost(ability) : 0, slot: ability ? abilitySlot(ability) : 'action' as AbilitySlot };
    if (state.outcome) return { ok: false, reason: 'the fight is over', ...base };
    if (!actor || currentActorId(state) !== actorId || actor.status !== 'up') return { ok: false, reason: 'not this combatant\'s turn', ...base };
    if (!ability) return { ok: false, reason: 'unknown ability', ...base };
    const ready = abilityReadiness(state, actor, ability, currentTurn(state));
    if (ready) return { ok: false, reason: ready, ...base, ability };
    if (aim === undefined) {
        if (ability.builtin?.kind === 'throw') {
            const refusal = throwReason(state, actorId);
            return refusal ? { ok: false, reason: refusal, ...base, ability } : { ok: true, ...base, ability };
        }
        if (legalAims(state, actorId, ability).length > 0) return { ok: true, ...base, ability };
        const pinned = ability.builtin?.kind === 'shove' && hasPinnedShoveTarget(state, actorId);
        return { ok: false, reason: pinned ? SHOVE_NO_ROOM : 'no target', ...base, ability };
    }
    const result = abilityTargets(state, actorId, ability, aim, payload);
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
    element?: ElementId;
    track: Track;
    coat: number;
    fire?: PlacedEffect;
};

function scaleOf(ctx: Ctx, target: Combatant): number {
    return ctx.aim.scales?.[target.id] ?? 1;
}

function scaled(ctx: Ctx, target: Combatant, amount: number): number {
    const k = scaleOf(ctx, target);
    return k === 1 ? amount : Math.max(1, Math.floor(amount * k));
}

type Track = { hurt: Set<string>; failed: Set<string>; base: Map<string, number> };

function newTrack(): Track {
    return { hurt: new Set(), failed: new Set(), base: new Map() };
}

function isStunt(ability: GlyphAbility): boolean {
    return ability.builtin?.kind === 'stunt';
}

function statsFor(user: Combatant, ability: GlyphAbility): CasterStats {
    const check = ability.builtin?.check;
    if (check) return { proficiency: proficiencyOf(user), castingMod: abilityMod(user.abilities[check.ability] ?? 10) };
    return ability.builtin ? builtinStats(user) : casterStats(user);
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
    const dc = saveDc(ctx.stats) + (ctx.element ? ELEMENTS[ctx.element].dcBonus ?? 0 : 0);
    const natural = ctx.draft.rng.roll(20);
    const total = natural + saveModifier(target, key);
    const success = total >= dc;
    ctx.saves.set(cacheKey, success);
    if (!success) ctx.track.failed.add(target.id);
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
    const base = EFFECTS[effect].save ?? null;
    if (base && ctx.element && ELEMENTS[ctx.element].saveAgainst) return ELEMENTS[ctx.element].saveAgainst ?? base;
    return base;
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
    const rolled = scaled(ctx, target, ctx.maximise
        ? Math.max(1, dice.count * dice.sides + dice.bonus)
        : rollDamage(ctx.draft.rng, crit ? dice.count * 2 : dice.count, dice.sides, dice.bonus));
    const weakened = ctx.coat > 0 ? Math.max(1, rolled - ctx.coat) : rolled;
    const halved = saved ? Math.floor(weakened / 2) : weakened;
    const found = ctx.element ? elementMultiplier(target, ctx.element) : null;
    const mult = found ?? damageMultiplier(target, ctx.type);
    const amount = Math.floor(halved * mult.factor);
    if (amount <= 0) {
        if (found?.immune) {
            emit(ctx.draft, {
                type: 'ability_damage',
                actorId: ctx.user.id,
                targetId: target.id,
                data: {
                    ability: ctx.ability.name, kind, damage: 0, damageType: ctx.type, element: ctx.element, saved, crit, weakness: false, resisted: false,
                    immune: true, absorbed: 0, hpBefore: target.hp, tempBefore: target.tempHp ?? 0, hpAfter: target.hp,
                },
                text: `${target.name} is immune to ${ctx.type}.`,
            });
        }
        return 0;
    }
    const result = applyDamage(target, amount);
    ctx.track.hurt.add(target.id);
    ctx.track.base.set(target.id, Math.max(ctx.track.base.get(target.id) ?? 0, halved));
    emit(ctx.draft, {
        type: 'ability_damage',
        actorId: ctx.user.id,
        targetId: target.id,
        data: {
            ability: ctx.ability.name, kind, damage: amount, damageType: ctx.type, ...(ctx.element ? { element: ctx.element } : {}), saved, crit,
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

export function strikesOnEntry(ability: GlyphAbility): boolean {
    return ability.builtin?.kind === 'shove' || isStunt(ability);
}

function moveBy(ctx: Ctx, target: Combatant, kind: 'push' | 'pull', squares: number): void {
    const state = ctx.draft.state;
    const shoved = strikesOnEntry(ctx.ability);
    const plan = previewPush(state, ctx.user.id, target.id, kind, squares, { ...(ctx.aim.origin ? { origin: ctx.aim.origin } : {}), strike: shoved });
    if (!plan) return;
    const moved = plan.squares;
    const stopped = plan.stoppedBy;
    const why = stopped ? `, stopped by ${blockerLabel(stopped, id => state.combatants[id]?.name ?? 'another creature')}` : '';
    const extra = { ...(stopped ? { stopped } : {}), ...(plan.slid ? { slid: true } : {}) };
    if (moved === 0) {
        const lead = isStunt(ctx.ability)
            ? `${target.name} has nowhere to go`
            : shoved
                ? `${target.name} is shoved but has nowhere to go`
                : `${target.name} is ${kind === 'push' ? 'pushed' : 'pulled'} but has nowhere to go`;
        emit(ctx.draft, {
            type: 'pushed',
            actorId: ctx.user.id,
            targetId: target.id,
            data: { kind, squares: 0, ability: ctx.ability.name, moves: [], ...extra, ...tag(ctx) },
            text: `${lead}${why}.`,
        });
        return;
    }
    target.position = { ...plan.landing };
    const unit = moved === 1 ? 'square' : 'squares';
    emit(ctx.draft, {
        type: 'pushed',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { kind, squares: moved, ability: ctx.ability.name, moves: [{ id: target.id, from: { ...plan.from }, to: { ...plan.landing } }], ...extra, ...tag(ctx) },
        text: `${kind === 'push' ? `${target.name} is pushed back ${moved} ${unit}` : `${target.name} is pulled ${moved} ${unit}`}${why}.`,
    });
    if (shoved) {
        for (let i = 0; i < plan.hazards.length && target.status === 'up'; i++) hazardStrike(ctx.draft, target);
    }
    enteredTile(ctx.draft, target, plan.from);
}

export function previewAbilityPushes(state: CombatState, userId: string, ability: GlyphAbility, aim: AimResult): PushPreview[] {
    if (ability.form.id === 'self' || !aim.ok) return [];
    const out: PushPreview[] = [];
    let live = state;
    for (const effect of ability.effects) {
        if (effect.id !== 'push' && effect.id !== 'pull') continue;
        const plans = previewPushes(live, userId, aim.targetIds, effect.id, pushDistance(effect.augments), {
            ...(aim.origin ? { origin: aim.origin } : {}),
            strike: strikesOnEntry(ability),
        });
        for (const plan of plans) {
            out.push(plan);
            const mover = live.combatants[plan.targetId];
            if (plan.squares > 0 && mover) live = { ...live, combatants: { ...live.combatants, [plan.targetId]: { ...mover, position: { ...plan.landing } } } };
        }
    }
    return out;
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
    enteredTile(ctx.draft, ctx.user);
}

function leapGlyphTo(ctx: Ctx, to: Pos): void {
    const s = ctx.draft.state;
    const from = ctx.user.position as Pos;
    const grid = terrainOf(s);
    const crossed = new Set<string>();
    if (grid) {
        for (const step of traceLine(from, to).slice(1, -1)) {
            for (const p of step) crossed.add(tileAt(grid, p));
        }
    }
    teleport(ctx, to, 'leap', undefined, [...LEAP_TERRAIN, 'wall'].filter(k => crossed.has(k)));
}

const LEAP_TERRAIN: readonly string[] = ['hazard', 'difficult', 'cover'];

function leapTo(ctx: Ctx, to: Pos): void {
    const s = ctx.draft.state;
    const from = ctx.user.position as Pos;
    const grid = terrainOf(s);
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
    enteredTile(ctx.draft, ctx.user);
    enteredTile(ctx.draft, target);
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

function addGlyphCondition(ctx: Ctx, target: Combatant, id: string, turns: number, effect: EffectId): void {
    const s = ctx.draft.state;
    const own = currentActorId(s) === target.id && s.turn?.actorId === target.id;
    const found = target.conditions.find(c => c.id === id);
    const before: CombatCondition | null = found ? { ...found } : null;
    setCondition(target, { id, turns, sourceId: ctx.user.id, ...(own ? { appliedTurn: s.turnCount ?? 0 } : {}) });
    emit(ctx.draft, {
        type: 'condition_added',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { condition: id, turns, ability: ctx.ability.name, effect, glyph: true, before },
        text: id === VANISHED ? `${target.name} vanishes from sight.` : `${target.name} is ${id} for ${turns} ${turns === 1 ? 'turn' : 'turns'}.`,
    });
    if (id === SNARED && own && s.turn) s.turn = { ...s.turn, moveLeft: 0 };
}

function dispel(ctx: Ctx, target: Combatant, saveKey: AbilityKey | null): void {
    const friend = isWilling(ctx, target);
    const strip = friend ? DISPEL_HARMFUL : DISPEL_HELPFUL;
    const removed = target.conditions.filter(c => strip.includes(c.id));
    if (removed.length === 0) return;
    if (!friend && saveKey && rollSave(ctx, target, saveKey)) return;
    const before = target.conditions.map(c => ({ ...c }));
    const tempBefore = target.tempHp ?? 0;
    target.conditions = target.conditions.filter(c => !strip.includes(c.id));
    if (!friend && removed.some(c => c.id === SHIELDED)) delete target.tempHp;
    emit(ctx.draft, {
        type: 'dispelled',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { ability: ctx.ability.name, removed: removed.map(c => c.id), before, tempBefore, friend },
        text: `${target.name} is stripped of ${removed.map(c => c.id).join(', ')}.`,
    });
}

function decay(ctx: Ctx, target: Combatant, augments: readonly GlyphAbility['effects'][number]['augments'][number][], saveKey: AbilityKey | null): void {
    if (saveKey && rollSave(ctx, target, saveKey)) return;
    const original = target.maxHp + (target.decayed ?? 0);
    const floor = Math.ceil(original * N.decayFloor);
    const rolled = scaled(ctx, target, rollDamage(ctx.draft.rng, decayDice(ctx.stats, augments), N.decaySides, 0));
    const amount = Math.min(rolled, target.maxHp - floor);
    if (amount <= 0) return;
    const maxBefore = target.maxHp;
    const hpBefore = target.hp;
    const tempBefore = target.tempHp ?? 0;
    const decayedBefore = target.decayed ?? 0;
    target.maxHp -= amount;
    target.hp = Math.max(0, Math.min(target.maxHp, target.hp - amount));
    target.decayed = decayedBefore + amount;
    ctx.track.hurt.add(target.id);
    emit(ctx.draft, {
        type: 'decayed',
        actorId: ctx.user.id,
        targetId: target.id,
        data: { ability: ctx.ability.name, amount, maxBefore, maxAfter: target.maxHp, hpBefore, tempBefore, hpAfter: target.hp, decayedBefore },
        text: `${target.name} withers, losing ${amount} maximum HP.`,
    });
    if (target.hp <= 0) markDown(ctx.draft, target, { actorId: ctx.user.id });
}

function rewind(ctx: Ctx, target: Combatant): void {
    const point = target.rewind;
    if (!point || target.status !== 'up') return;
    const s = ctx.draft.state;
    const terrain = terrainOf(s);
    const from = target.position ? { ...target.position } : undefined;
    const free = !!point.pos && !!terrain && (samePos(point.pos, from) || isEmptyTile(s, terrain, point.pos));
    const before = { hp: target.hp, tempHp: target.tempHp ?? 0, conditions: target.conditions.map(c => ({ ...c })), ...(from ? { pos: from } : {}) };
    if (free && point.pos) target.position = { ...point.pos };
    target.hp = Math.max(1, Math.min(target.maxHp, point.hp));
    if (point.tempHp && point.tempHp > 0) target.tempHp = point.tempHp;
    else delete target.tempHp;
    target.conditions = point.conditions.map(c => ({ ...c }));
    const moved = free && !!from && !!point.pos && !samePos(from, point.pos);
    emit(ctx.draft, {
        type: 'rewound',
        actorId: ctx.user.id,
        targetId: target.id,
        data: {
            ability: ctx.ability.name, before, hpBefore: before.hp, tempBefore: before.tempHp, hpAfter: target.hp, turn: point.turn,
            ...(moved ? { moves: [{ id: target.id, from, to: { ...(point.pos as Pos) } }] } : {}),
        },
        text: `${target.name} slips back to where they stood a turn ago.`,
    });
    if (moved) enteredTile(ctx.draft, target);
}

function gravityPull(ctx: Ctx, targets: readonly Combatant[], augments: GlyphAbility['effects'][number]['augments']): void {
    const s = ctx.draft.state;
    const centre = ctx.aim.origin;
    if (!centre) return;
    const pulled = targets
        .filter(t => t.status === 'up' && !!t.position && !samePos(t.position, centre))
        .sort((a, b) => (distance(a.position as Pos, centre) - distance(b.position as Pos, centre)) || (s.order.indexOf(a.id) - s.order.indexOf(b.id)));
    if (pulled.length === 0) return;
    emit(ctx.draft, { type: 'gravity', actorId: ctx.user.id, data: { ability: ctx.ability.name, centre: { ...centre }, targets: pulled.map(t => t.id) }, text: `${ctx.ability.name} drags everything toward its centre.` });
    for (const t of pulled) {
        if (t.status !== 'up' || !t.position) continue;
        const key = needsSave(ctx, 'gravity', t);
        if (key && rollSave(ctx, t, key)) continue;
        const squares = Math.min(gravitySquares(augments), distance(t.position, centre));
        const plan = previewPush(s, ctx.user.id, t.id, 'pull', squares, { origin: centre });
        if (!plan || plan.squares === 0) continue;
        t.position = { ...plan.landing };
        emit(ctx.draft, {
            type: 'pushed',
            actorId: ctx.user.id,
            targetId: t.id,
            data: { kind: 'pull', squares: plan.squares, ability: ctx.ability.name, gravity: true, moves: [{ id: t.id, from: { ...plan.from }, to: { ...plan.landing } }] },
            text: `${t.name} is dragged ${plan.squares} ${plan.squares === 1 ? 'square' : 'squares'}.`,
        });
        enteredTile(ctx.draft, t, plan.from);
    }
}

export function delayedPayload(ability: GlyphAbility): GlyphAbility {
    const boost = new Array<'amplify'>(N.delayBoost).fill('amplify');
    return {
        ...ability,
        form: { id: ability.form.id, augments: ability.form.augments.filter(a => a !== 'delay') },
        effects: ability.effects.map(e => (DELAY_BOOSTED.has(e.id) ? { id: e.id, augments: [...e.augments, ...boost] } : { id: e.id, augments: [...e.augments] })),
    };
}

const DELAY_BOOSTED: ReadonlySet<EffectId> = new Set<EffectId>(['damage', 'drain', 'heal', 'decay', 'shield']);

function castPlaced(ctx: Ctx): void {
    const s = ctx.draft.state;
    const ability = ctx.ability;
    const user = ctx.user;
    const base = { ownerId: user.id, side: user.side, name: ability.name, placedRound: s.round, ...(ctx.element ? { element: ctx.element } : {}) };
    if (isDelayed(ability)) {
        addPlaced(ctx.draft, {
            ...base, kind: 'delay', trigger: 'owner_turn_start', tiles: ctx.aim.tiles.map(p => ({ ...p })), payload: delayedPayload(ability),
            ...(ctx.aim.origin ? { origin: { ...ctx.aim.origin } } : {}), targetIds: [...ctx.aim.targetIds], expiresRound: s.round + 2,
        });
        return;
    }
    const payload: GlyphAbility = { ...ability, form: { id: ability.form.id, augments: [] }, effects: ability.effects.map(e => ({ id: e.id, augments: [...e.augments] })) };
    if (ability.form.id === 'sigil') {
        const mine = placedOf(s).filter(p => p.kind === 'sigil' && p.ownerId === user.id);
        if (mine.length >= N.maxSigils) endPlaced(ctx.draft, mine[0], 'replaced');
        addPlaced(ctx.draft, { ...base, kind: 'sigil', trigger: 'enter', tiles: [{ ...ctx.aim.tiles[0] }], payload, expiresRound: s.round + sigilRounds(ability) });
        return;
    }
    if (ability.form.id === 'mantle') {
        const old = mantleOf(s, user.id);
        if (old) endPlaced(ctx.draft, old, 'replaced');
        addPlaced(ctx.draft, { ...base, kind: 'mantle', trigger: 'turn_start', tiles: [], radius: mantleRadius(ability), payload, expiresRound: s.round + mantleRounds(ability) });
        return;
    }
    const rounds = wallRounds(ability);
    raiseBarrier(ctx, rounds);
    addPlaced(ctx.draft, { ...base, kind: 'wall', trigger: 'turn_start', tiles: (ctx.aim.barrierTiles ?? []).map(p => ({ ...p })), payload, expiresRound: s.round + rounds });
}

export function firePlaced(draft: Draft, placed: PlacedEffect, targets: readonly Combatant[], origin?: Pos): void {
    const owner = draft.state.combatants[placed.ownerId];
    if (!owner || !placed.payload) return;
    const live = targets.filter(t => t.status === 'up');
    if (live.length === 0) return;
    const aim: AimResult = {
        ok: true,
        tiles: live.filter(t => !!t.position).map(t => ({ ...(t.position as Pos) })),
        targetIds: live.map(t => t.id),
        ...(origin ? { origin: { ...origin } } : {}),
    };
    applyChain(draft, owner.id, placed.payload, aim, false, placed);
}

function fireDelay(draft: Draft, placed: PlacedEffect): void {
    const s = draft.state;
    const owner = s.combatants[placed.ownerId];
    if (!owner || !placed.payload) return;
    const includeOwner = placed.payload.form.id === 'burst';
    const targets = s.order
        .map(id => s.combatants[id])
        .filter((c): c is Combatant => !!c && c.status === 'up' && !!c.position && (includeOwner || c.id !== owner.id) && placed.tiles.some(t => samePos(t, c.position)));
    if (targets.length === 0) {
        emit(draft, {
            type: 'placed_triggered',
            actorId: owner.id,
            data: { placedId: placed.id, kind: placed.kind, ability: placed.name, targets: [], missed: true },
            text: `${placed.name} goes off, but nobody is there.`,
        });
        return;
    }
    firePlaced(draft, placed, targets, placed.origin);
}

export function enteredTile(draft: Draft, unit: Combatant, from?: Pos): void {
    const s = draft.state;
    if (!s.placed || s.placed.length === 0 || !unit.position || unit.status !== 'up') return;
    strikeStanding(draft, unit, 'enter');
    if (unit.status !== 'up' || !unit.position) return;
    const at = { ...unit.position };
    const sigil = sigilTriggersOn(s, at, unit);
    if (sigil) {
        endPlaced(draft, sigil, 'spent');
        const owner = s.combatants[sigil.ownerId];
        const origin = owner?.status === 'up' && owner.position && !samePos(owner.position, at) ? owner.position : sigil.tiles[0];
        firePlaced(draft, sigil, [unit], origin);
    }
    if (!from || unit.status !== 'up' || !samePos(unit.position, at)) return;
    if (slideUnit(draft, unit, from)) enteredTile(draft, unit);
}

function nearestTile(tiles: readonly Pos[], p: Pos): Pos | undefined {
    let best: Pos | undefined;
    for (const t of tiles) if (!best || distance(t, p) < distance(best, p)) best = t;
    return best;
}

export function turnStartPlaced(draft: Draft, unit: Combatant): void {
    const s = draft.state;
    if (!s.placed || s.placed.length === 0) return;
    sweepOwnerless(draft);
    strikeStanding(draft, unit, 'turn_start');
    if (unit.status !== 'up') return;
    for (const p of [...placedOf(s)]) {
        if (p.kind !== 'delay' || p.ownerId !== unit.id || unit.status !== 'up') continue;
        endPlaced(draft, p, 'spent');
        fireDelay(draft, p);
    }
    for (const p of [...placedOf(s)]) {
        if (unit.status !== 'up' || !unit.position) return;
        if (p.trigger !== 'turn_start' || !placedOf(s).some(q => q.id === p.id)) continue;
        if (!touchesUnit(p, unit) || !placedCovers(s, p, unit.position)) continue;
        const origin = p.kind === 'mantle' ? s.combatants[p.ownerId]?.position : nearestTile(p.tiles, unit.position);
        firePlaced(draft, p, [unit], origin);
    }
}

function placedTriggerText(placed: PlacedEffect, target: Combatant | undefined): string {
    const who = target?.name ?? 'someone';
    if (placed.kind === 'sigil') return `The sigil (${placed.name}) goes off under ${who}.`;
    if (placed.kind === 'mantle') return `The mantle (${placed.name}) touches ${who}.`;
    if (placed.kind === 'wall') return `The wall (${placed.name}) lashes ${who}.`;
    return `${placed.name} goes off on ${who}.`;
}

function usesWeapon(ability: GlyphAbility): boolean {
    return ability.effects.some(e => e.id === 'weapon');
}

type Wield = { attackBonus: number; damage: DamageSpec; weapon?: string };

function wieldOf(ctx: Ctx): Wield {
    return { attackBonus: ctx.user.attackBonus, damage: ctx.user.damage, ...(ctx.user.weaponName ? { weapon: ctx.user.weaponName } : {}) };
}

function weaponRoll(ctx: Ctx, target: Combatant): { hit: boolean; crit: boolean } {
    const user = ctx.user;
    const wield = wieldOf(ctx);
    const check = checkAttack(ctx.draft.state, user.id, target.id, undefined, !canTarget(user, target));
    const defending = hasCondition(target, DEFEND_CONDITION);
    const disadvantage = defending || check.disadvantage || hasCondition(user, SLOWED);
    const first = ctx.draft.rng.roll(20);
    const natural = disadvantage ? Math.min(first, ctx.draft.rng.roll(20)) : first;
    const total = natural + wield.attackBonus - blindPenalty(user);
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
    const rolledDamage = rollDamage(ctx.draft.rng, count, spec.sides, spec.bonus);
    const damage = ctx.coat > 0 ? Math.max(1, rolledDamage - ctx.coat) : rolledDamage;
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
    const mentalSave = ctx.element ? ELEMENTS[ctx.element].saveAgainst : undefined;
    if (mentalSave && ctx.element) {
        if (isImmune(target, ctx.element)) return { hit: true, crit: false };
        return { hit: !rollSave(ctx, target, mentalSave), crit: false };
    }
    const s = ctx.draft.state;
    const terrain = terrainOf(s);
    const from = ctx.user.position;
    const pierce = ctx.ability.form.augments.includes('pierce');
    const helpfulOnly = ctx.ability.effects.every(e => EFFECTS[e.id].helpful);
    const terrainCover = ctx.ability.form.id === 'projectile' && !pierce && !helpfulOnly && terrain && from && target.position
        ? revealedCover(target, coverBetween(terrain, from, target.position))
        : 0;
    const cover = terrainCover + (helpfulOnly ? 0 : dimBonus(s, from, target.position));
    const armourIgnored = ctx.element ? ELEMENTS[ctx.element].ignoresArmour ?? 0 : 0;
    const adjacentShot = ctx.ability.form.id === 'projectile' && !!from && Object.values(s.combatants)
        .some(o => o.id !== ctx.user.id && canTarget(ctx.user, o) && !!o.position && distance(o.position, from) <= 1);
    const defending = hasCondition(target, DEFEND_CONDITION);
    const slowed = hasCondition(ctx.user, SLOWED);
    const disadvantage = defending || adjacentShot || slowed;
    const first = ctx.draft.rng.roll(20);
    const natural = disadvantage ? Math.min(first, ctx.draft.rng.roll(20)) : first;
    const total = natural + ctx.stats.proficiency + ctx.stats.castingMod - blindPenalty(ctx.user);
    const ac = target.ac + cover - armourIgnored;
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
        if (user.signature && user.signature.abilityId === ability.id) user.signature = { ...user.signature, usesLeft: Math.max(0, user.signature.usesLeft - 1) };
    }
    if (ability.builtin?.kind === 'throw') {
        if (aim.throw) {
            const thrown = resolveThrow(draft, actorId, ability, aim.throw.payload, aim.throw.landing);
            const creature = thrown ? s.combatants[thrown.creatureId] : undefined;
            if (creature) enteredTile(draft, creature, thrown?.from);
        }
        return;
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
        const ctx: Ctx = { draft, user, ability: first.ability, stats: statsFor(user, first.ability), aim: first.aim, type: N.defaultDamageType, saves: new Map(), rolls: new Map(), maximise: false, track: newTrack(), coat: 0 };
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

const HOSTILE_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['damage', 'drain', 'push', 'pull', 'stun', 'slow', 'swap', 'snare', 'fear', 'decay', 'gravity']);

const DAMAGING_EFFECTS: ReadonlySet<EffectId> = new Set<EffectId>(['damage', 'drain', 'weapon']);

function runRiders(ctx: Ctx, targets: readonly Combatant[], roll: string): void {
    const element = ctx.element;
    if (!element) return;
    const row = ELEMENTS[element];
    const effects = ctx.ability.effects;
    if (row.riders.length === 0 || !effects.some(e => HOSTILE_EFFECTS.has(e.id))) return;
    const dealsDamage = effects.some(e => e.id === 'damage' || e.id === 'drain');
    const unit: RiderUnit = { draft: ctx.draft, user: ctx.user, abilityName: ctx.ability.name, element, ...(ctx.aim.origin ? { origin: ctx.aim.origin } : {}) };
    const inArea = new Set(targets.map(t => t.id));
    for (const target of targets) {
        if (target.status !== 'up' || isImmune(target, element)) continue;
        const landed = ctx.track.hurt.has(target.id) || ctx.track.failed.has(target.id) || (roll === 'attack' && !dealsDamage && !isWilling(ctx, target));
        if (!landed) continue;
        for (const rider of row.riders) {
            if (target.status !== 'up') break;
            const origin = target.position ? { ...target.position } : undefined;
            switch (rider) {
                case 'shove':
                    if (pushRider(unit, target, ELEMENT_NUMBERS.shoveSquares).moved > 0) enteredTile(ctx.draft, target, origin);
                    break;
                case 'kinetic': {
                    const shoved = pushRider(unit, target, ELEMENT_NUMBERS.kineticSquares);
                    if (shoved.blocked && target.status === 'up') impactRider(unit, target);
                    if (shoved.moved > 0) enteredTile(ctx.draft, target, origin);
                    break;
                }
                case 'arc': {
                    const conduct = conductRow(target, element);
                    arcRider(
                        unit, target, ctx.track.base.get(target.id) ?? 0, inArea,
                        conduct ? () => announceConduct(ctx.draft, ctx.user, target, element, ctx.ability.name, conduct) : undefined,
                    );
                    break;
                }
                default:
                    addConditionRider(unit, target, rider as ConditionRiderId);
                    break;
            }
        }
        if (target.status === 'up') reactExtend(ctx.draft, ctx.user, target, element, ctx.ability.name);
    }
}

function applyChain(draft: Draft, actorId: string, ability: GlyphAbility, aim: AimResult, maximise: boolean, fire?: PlacedEffect): void {
    const s = draft.state;
    const user = s.combatants[actorId];
    const slot = abilitySlot(ability);
    const cost = abilityCost(ability);
    const element = abilityElement(ability);
    const type = abilityDamageType(ability);
    const targetIds = aim.targetIds.filter(id => s.combatants[id]);
    if (fire) {
        emit(draft, {
            type: 'placed_triggered',
            actorId,
            ...(targetIds[0] ? { targetId: targetIds[0] } : {}),
            data: { placedId: fire.id, kind: fire.kind, ability: fire.name, targets: targetIds, form: ability.form.id, effects: ability.effects.map(e => e.id), ...(element ? { element } : {}) },
            text: placedTriggerText(fire, targetIds[0] ? s.combatants[targetIds[0]] : undefined),
        });
    } else if (ability.builtin?.events !== 'compact') {
        emit(draft, {
            type: 'ability',
            actorId,
            data: {
                abilityId: ability.id, name: ability.name, damageType: type, ...(element ? { element } : {}), form: ability.form.id,
                effects: ability.effects.map(e => e.id), cost, slot, targets: targetIds,
                ...(usesMp(user) ? { mpAfter: user.mp } : {}),
                ...(user.signature && user.signature.abilityId === ability.id ? { signature: true, usesLeft: user.signature.usesLeft } : {}),
            },
            text: `${user.name} uses ${ability.name}${usesMp(user) && !ability.builtin ? ` (${cost} MP)` : ''}.`,
        });
    }
    const ctx: Ctx = {
        draft, user, ability, stats: statsFor(user, ability), aim, type, saves: new Map(), rolls: new Map(), maximise,
        ...(element ? { element } : {}), track: newTrack(), coat: 0, ...(fire ? { fire } : {}),
    };
    if (!fire && (FORMS[ability.form.id]?.placed || isDelayed(ability))) {
        castPlaced(ctx);
        return;
    }
    if (!fire && hasCondition(user, COATED) && ability.effects.some(e => DAMAGING_EFFECTS.has(e.id))) {
        if (consumeCondition(draft, user, COATED, 'attack')) ctx.coat = ELEMENT_NUMBERS.coatPenalty;
    }
    const marking = element && ability.effects.some(e => HOSTILE_EFFECTS.has(e.id))
        ? { draft, user, element, abilityName: ability.name, tiles: markedTiles(s, user, ability, aim, fire) }
        : null;
    if (marking && marking.tiles.length > 0) reactTiles(marking);
    if (ability.form.id === 'dash' && aim.destination) teleport(ctx, aim.destination, 'dash', targetIds[0]);
    if (ability.effects.some(e => e.id === 'blink') && aim.destination) teleport(ctx, aim.destination, 'blink');
    if (ability.effects.some(e => e.id === 'leap') && aim.destination) {
        if (ability.builtin?.kind === 'jump') leapTo(ctx, aim.destination);
        else leapGlyphTo(ctx, aim.destination);
    }
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
        if (effect.id === 'gravity') {
            gravityPull(ctx, targets, a);
            continue;
        }
        let drained = 0;
        for (const target of targets) {
            if (target.status !== 'up' && effect.id !== 'rally') continue;
            const saveKey = needsSave(ctx, effect.id, target);
            const crit = crits.get(target.id) ?? false;
            switch (effect.id) {
                case 'damage': {
                    const dice = user.abilityDamage
                        ? { count: Math.max(1, user.abilityDamage.count + power(a)), sides: user.abilityDamage.sides, bonus: user.abilityDamage.bonus }
                        : { count: damageDice(ctx.stats, a), sides: 6, bonus: 0 };
                    dealDamage(ctx, target, dice, crit, saveKey, 'damage');
                    break;
                }
                case 'drain':
                    drained += dealDamage(ctx, target, { count: drainDice(ctx.stats, a), sides: 6, bonus: 0 }, crit, saveKey, 'drain');
                    break;
                case 'heal':
                    heal(ctx, target, scaled(ctx, target, rollDamage(draft.rng, healDice(ctx.stats, a), 4, ctx.stats.castingMod)), 'heal');
                    break;
                case 'shield':
                    applyShield(ctx, target, scaled(ctx, target, shieldAmount(ctx.stats, a)), shieldTurns(a));
                    break;
                case 'snare':
                    if (saveKey && rollSave(ctx, target, saveKey)) break;
                    addGlyphCondition(ctx, target, SNARED, snareTurns(a), 'snare');
                    break;
                case 'fear':
                    if (saveKey && rollSave(ctx, target, saveKey)) break;
                    addGlyphCondition(ctx, target, FEARED, fearTurns(a), 'fear');
                    break;
                case 'dispel':
                    dispel(ctx, target, saveKey);
                    break;
                case 'decay':
                    decay(ctx, target, a, saveKey);
                    break;
                case 'vanish':
                    addGlyphCondition(ctx, target, VANISHED, 1, 'vanish');
                    break;
                case 'rewind':
                    rewind(ctx, target);
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
    if (element) runRiders(ctx, targets, roll);
    if (marking && marking.tiles.length > 0) leaveMarks(marking);
}
