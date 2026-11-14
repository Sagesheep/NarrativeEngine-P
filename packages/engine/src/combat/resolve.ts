import { abilityMod, proficiencyForLevel, TIER_LEVEL } from './abilities';
import { createRng } from './rng';
import { buildTierBlock, DEFAULT_JITTER_RANGE, TIER_TABLE } from './tiers';
import {
    coverBetween, distance, hasLineOfSight, inBounds, isOccupied, pathCost, pathFromSearch, rangeOf, REACH_DISTANCE,
    RANGED_DISTANCE, searchMoves, destinations, samePos, sameTeam, terrainOf, tileAt,
} from './grid';
import { buildMapFromSeed, DEFAULT_HAZARD_TYPE, openArena, placeCombatants } from './mapBuilder';
import { resolveMapSpec } from './mapSpec';
import {
    applyDamage, canAttackWith, canTarget, closeDraft, currentActorId, currentTurn, DEFEND_CONDITION, dismissSummon, emit,
    freshTurn, hasCondition, isPlayerSide, markDown, openDraft, rollDamage, settleOutcome, SHIELDED, SLOWED,
    spendAttackAction, STUNNED,
} from './core';
import type { Draft } from './core';
import { abilityReadiness, abilitySlot, checkAbility, resolveAbility } from './glyphs/apply';
import {
    abandonFight, attemptFlee, buildMoraleBook, canAbandon, checkFlee, checkParley, concedeFight, isEdgeTile, isRetreating,
    PARLEY_INTENTS, PARLEY_RATINGS, resolveParley, rollMoraleIfDue,
} from './party';

const PARLEY_INTENT_SET: ReadonlySet<string> = new Set(PARLEY_INTENTS);
const PARLEY_RATING_SET: ReadonlySet<string> = new Set(PARLEY_RATINGS);
import { abilityTargets } from './glyphs/targeting';
import { enemyKit } from './glyphs/kits';
import { defaultCastingAbility } from './glyphs/numbers';
import type {
    AttackRange, CombatAction, CombatCondition, CombatEvent, CombatSpec, CombatState, Combatant, GlyphAbility, Pos, TurnState,
} from './types';

export { DEFEND_CONDITION, isHostile, canTarget, currentActorId, freshTurn, currentTurn, checkOutcome } from './core';

export const HAZARD_DAMAGE_DIE = 6;

const MAX_ENGINE_ACTIONS = 2000;
const MAP_SEED_SALT = 0x5bd1e995;

function startTurn(draft: Draft): void {
    const id = currentActorId(draft.state);
    if (!id) return;
    const actor = draft.state.combatants[id];
    if (!actor) return;
    draft.state.turnCount = (draft.state.turnCount ?? 0) + 1;
    draft.state.turn = freshTurn(draft.state, id);
    if (actor.position) draft.state.turnStart = { actorId: id, pos: { ...actor.position } };
    else delete draft.state.turnStart;
    actor.conditions = actor.conditions.filter(c => c.id !== DEFEND_CONDITION);
    rollMoraleIfDue(draft, actor);
}

function endedText(c: Combatant, condition: string): string {
    return `${c.name} is no longer ${condition}.`;
}

function tickTurnConditions(draft: Draft, c: Combatant): void {
    const s = draft.state;
    const kept: CombatCondition[] = [];
    for (const cond of c.conditions) {
        if (typeof cond.turns !== 'number' || cond.appliedTurn === s.turnCount) {
            kept.push(cond);
            continue;
        }
        const turns = cond.turns - 1;
        if (turns > 0) {
            kept.push({ ...cond, turns });
            continue;
        }
        if (cond.id === SHIELDED) delete c.tempHp;
        emit(draft, { type: 'condition_ended', targetId: c.id, data: { condition: cond.id }, text: endedText(c, cond.id) });
    }
    c.conditions = kept;
}

function loseTurn(draft: Draft, c: Combatant): void {
    const s = draft.state;
    s.turnCount = (s.turnCount ?? 0) + 1;
    s.turn = { actorId: c.id, moveLeft: 0, actionUsed: true };
    c.conditions = c.conditions.filter(x => x.id !== DEFEND_CONDITION);
    emit(draft, { type: 'turn_lost', actorId: c.id, data: { condition: STUNNED }, text: `${c.name} is stunned and loses the turn.` });
    tickTurnConditions(draft, c);
    c.stunGuard = true;
}

function environmentStep(draft: Draft): void {
    const s = draft.state;
    const grid = s.grid;
    for (const id of s.order) {
        const c = s.combatants[id];
        if (!c || c.status !== 'up') continue;
        if (grid && c.position && tileAt(grid, c.position) === 'hazard') {
            const damage = draft.rng.roll(HAZARD_DAMAGE_DIE);
            const damageType = grid.hazardType || DEFAULT_HAZARD_TYPE;
            const hit = applyDamage(c, damage);
            emit(draft, {
                type: 'hazard',
                targetId: c.id,
                data: {
                    damage, damageType, hpAfter: c.hp,
                    ...(hit.absorbed > 0 ? { absorbed: hit.absorbed, hpBefore: hit.hpBefore, tempBefore: hit.tempBefore } : {}),
                },
                text: grid.labels?.hazard ? `${c.name} takes ${damage} damage from the ${grid.labels.hazard}.` : `${c.name} takes ${damage} ${damageType} damage from the hazard.`,
            });
            if (c.hp <= 0) markDown(draft, c, { hazard: true });
            if (c.status !== 'up') continue;
        }
        const kept: CombatCondition[] = [];
        for (const cond of c.conditions) {
            if (cond.id === DEFEND_CONDITION || typeof cond.turns === 'number') {
                kept.push(cond);
                continue;
            }
            const rounds = (cond.rounds ?? 1) - 1;
            if (rounds > 0) kept.push({ ...cond, rounds });
            else emit(draft, { type: 'condition_ended', targetId: c.id, data: { condition: cond.id }, text: endedText(c, cond.id) });
        }
        c.conditions = kept;
    }
    const nextRound = s.round + 1;
    for (const id of s.order) {
        const c = s.combatants[id];
        if (c && c.summonerId && c.status === 'up' && typeof c.expiresRound === 'number' && c.expiresRound <= nextRound) {
            dismissSummon(draft, c, 'expired');
        }
    }
    if (s.barriers && s.barriers.length > 0) {
        const ending = s.barriers.filter(b => b.expiresRound <= nextRound);
        if (ending.length > 0) {
            s.barriers = s.barriers.filter(b => b.expiresRound > nextRound);
            emit(draft, {
                type: 'barrier_ended',
                data: { tiles: ending.map(b => ({ ...b.pos })), expiresRound: ending[0].expiresRound },
                text: ending.length === 1 ? 'A barrier square fades.' : `${ending.length} barrier squares fade.`,
            });
        }
    }
}

function endOfTurn(draft: Draft, actorId: string): void {
    const c = draft.state.combatants[actorId];
    if (!c || c.status !== 'up') return;
    tickTurnConditions(draft, c);
    delete c.stunGuard;
}

function advanceTurn(draft: Draft): void {
    const s = draft.state;
    if (s.order.length === 0) return;
    const outgoing = currentActorId(s);
    if (outgoing && s.turn?.actorId === outgoing) endOfTurn(draft, outgoing);
    const bound = s.order.length * 8;
    for (let step = 0; step < bound; step++) {
        s.turnIndex += 1;
        if (s.turnIndex >= s.order.length) {
            s.turnIndex = 0;
            environmentStep(draft);
            settleOutcome(draft);
            if (s.outcome) return;
            s.round += 1;
            emit(draft, { type: 'round', data: { round: s.round }, text: `Round ${s.round} begins.` });
        }
        const next = s.combatants[s.order[s.turnIndex]];
        if (!next || next.status !== 'up') continue;
        if (hasCondition(next, STUNNED)) {
            loseTurn(draft, next);
            settleOutcome(draft);
            if (s.outcome) return;
            continue;
        }
        startTurn(draft);
        return;
    }
}

export type AttackCheck = {
    ok: boolean;
    reason?: 'invalid_target' | 'out_of_range' | 'no_line_of_sight';
    range: AttackRange;
    distance: number;
    cover: number;
    disadvantage: boolean;
};

function hostileAdjacent(state: CombatState, actor: Combatant, at: Pos): boolean {
    return Object.values(state.combatants).some(o => o.id !== actor.id && canTarget(actor, o) && !!o.position && distance(o.position, at) <= 1);
}

export function checkAttack(state: CombatState, actorId: string, targetId: string, from?: Pos): AttackCheck {
    const actor = state.combatants[actorId];
    const target = state.combatants[targetId];
    const range = actor ? rangeOf(actor) : 'close';
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
    const limit = range === 'reach' ? REACH_DISTANCE : RANGED_DISTANCE;
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

function resolveAttack(draft: Draft, actor: Combatant, target: Combatant, check: AttackCheck): void {
    const defending = target.conditions.some(c => c.id === DEFEND_CONDITION);
    const disadvantage = defending || check.disadvantage || hasCondition(actor, SLOWED);
    const first = draft.rng.roll(20);
    const natural = disadvantage ? Math.min(first, draft.rng.roll(20)) : first;
    const total = natural + actor.attackBonus;
    const ac = target.ac + check.cover;
    const crit = natural === 20;
    const hit = crit || (natural !== 1 && total >= ac);
    const dmgType = actor.damage.type;
    const base = {
        natural, total, ac, cover: check.cover, range: check.range, disadvantage, defending, adjacentShot: check.disadvantage,
        ...(actor.weaponName ? { weapon: actor.weaponName } : {}),
    };
    if (!hit) {
        const shielded = (target.tempHp ?? 0) > 0;
        emit(draft, {
            type: 'attack',
            actorId: actor.id,
            targetId: target.id,
            data: { ...base, hit: false, crit: false, fumble: natural === 1, ...(shielded ? { shielded: true } : {}) },
            text: `${actor.name} attacks ${target.name} and misses.`,
        });
        return;
    }
    const count = crit ? actor.damage.count * 2 : actor.damage.count;
    const damage = rollDamage(draft.rng, count, actor.damage.sides, actor.damage.bonus);
    const result = applyDamage(target, damage);
    const shielded = result.absorbed > 0 ? { absorbed: result.absorbed, hpBefore: result.hpBefore, tempBefore: result.tempBefore } : {};
    emit(draft, {
        type: 'attack',
        actorId: actor.id,
        targetId: target.id,
        data: { ...base, hit: true, crit, damage, damageType: dmgType, hpAfter: target.hp, ...shielded },
        text: crit
            ? `${actor.name} lands a critical hit on ${target.name} for ${damage} ${dmgType}.`
            : `${actor.name} hits ${target.name} for ${damage} ${dmgType}.`,
    });
    if (target.hp <= 0 && target.status === 'up') markDown(draft, target, { actorId: actor.id });
}

function rejection(state: CombatState, action: CombatAction, reason: string): { state: CombatState; events: CombatEvent[] } {
    return {
        state,
        events: [{
            seq: state.eventSeq + 1,
            round: state.round,
            turn: state.turnCount ?? 0,
            type: 'rejected',
            actorId: action?.actorId,
            data: { reason, action: action?.type },
            text: `Action rejected: ${reason}.`,
        }],
    };
}

export function moveSearchFor(state: CombatState, actorId: string, budget?: number) {
    const actor = state.combatants[actorId];
    if (!actor) return null;
    const turn = currentActorId(state) === actorId ? currentTurn(state) : freshTurn(state, actorId);
    const limit = budget ?? turn?.moveLeft ?? 0;
    return searchMoves(state, actorId, { budget: limit, avoidHazards: actor.controller === 'engine' });
}

export function reachable(state: CombatState, actorId: string): Array<Pos & { cost: number }> {
    const search = moveSearchFor(state, actorId);
    if (!search) return [];
    return destinations(search).map(({ x, y, cost }) => ({ x, y, cost }));
}

export function pathTo(state: CombatState, actorId: string, to: Pos): { path: Pos[]; cost: number } | null {
    const actor = state.combatants[actorId];
    const grid = state.grid;
    if (!actor || !grid || !actor.position || !inBounds(grid, to) || samePos(actor.position, to)) return null;
    if (isOccupied(state, to, actorId)) return null;
    const search = moveSearchFor(state, actorId);
    let path = search ? pathFromSearch(search, to) : null;
    if (!path && actor.controller === 'engine') {
        const turn = currentActorId(state) === actorId ? currentTurn(state) : freshTurn(state, actorId);
        const plain = searchMoves(state, actorId, { budget: turn?.moveLeft ?? 0, avoidHazards: false });
        path = plain ? pathFromSearch(plain, to) : null;
    }
    if (!path || path.length === 0) return null;
    return { path, cost: pathCost(grid, path) };
}

function opponentsOf(state: CombatState, actor: Combatant): Combatant[] {
    return state.order.map(id => state.combatants[id]).filter(c => !!c && !!c.position && canTarget(actor, c));
}

function nearest(state: CombatState, actor: Combatant, at: Pos): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    for (const o of opponentsOf(state, actor)) {
        const d = distance(at, o.position as Pos);
        if (!best || d < best.dist) best = { id: o.id, dist: d };
    }
    return best;
}

function moveData(state: CombatState, actor: Combatant, from: Pos, to: Pos): { towardId?: string; awayFromId?: string } {
    const after = nearest(state, actor, to);
    if (after && after.dist < distance(from, state.combatants[after.id].position as Pos)) return { towardId: after.id };
    const before = nearest(state, actor, from);
    if (before && distance(to, state.combatants[before.id].position as Pos) > before.dist) return { awayFromId: before.id };
    return {};
}

function moveText(state: CombatState, actor: Combatant, squares: number, rel: { towardId?: string; awayFromId?: string }): string {
    const unit = squares === 1 ? 'square' : 'squares';
    if (rel.towardId) return `${actor.name} moves ${squares} ${unit} toward ${state.combatants[rel.towardId].name}.`;
    if (rel.awayFromId) return `${actor.name} moves ${squares} ${unit} away from ${state.combatants[rel.awayFromId].name}.`;
    return `${actor.name} moves ${squares} ${unit}.`;
}

function hasAnyMove(state: CombatState, actorId: string): boolean {
    const search = moveSearchFor(state, actorId);
    return !!search && destinations(search).length > 0;
}

export function hasUsableBonusAbility(state: CombatState, actorId: string): boolean {
    const actor = state.combatants[actorId];
    if (!actor?.kit || actor.kit.length === 0) return false;
    return actor.kit.some(a => abilitySlot(a) === 'bonus' && checkAbility(state, actorId, a.id).ok);
}

function maybeAutoEnd(draft: Draft, actorId: string): void {
    const s = draft.state;
    if (s.outcome || currentActorId(s) !== actorId) return;
    const turn = currentTurn(s);
    if (!turn || canAttackWith(turn)) return;
    if (turn.moveLeft > 0 && hasAnyMove(s, actorId)) return;
    if (!turn.bonusUsed && hasUsableBonusAbility(s, actorId)) return;
    advanceTurn(draft);
}

export function applyAction(state: CombatState, action: CombatAction): { state: CombatState; events: CombatEvent[] } {
    if (state.outcome) return rejection(state, action, 'the fight is over');
    const actorId = currentActorId(state);
    const actor = actorId ? state.combatants[actorId] : undefined;
    if (!actor || !action || action.actorId !== actorId) return rejection(state, action, 'not this combatant\'s turn');
    if (actor.status !== 'up') return rejection(state, action, 'the combatant cannot act');
    const turn = currentTurn(state) as TurnState;

    if (action.type === 'attack') {
        if (!canAttackWith(turn)) return rejection(state, action, 'the action is already used');
        const target = state.combatants[action.targetId];
        if (!target || !canTarget(actor, target)) return rejection(state, action, 'invalid target');
        const check = checkAttack(state, actor.id, target.id);
        if (!check.ok) return rejection(state, action, check.reason === 'no_line_of_sight' ? 'no line of sight' : 'out of range');
        const draft = openDraft(state);
        draft.state.turn = spendAttackAction(turn);
        resolveAttack(draft, draft.state.combatants[actor.id], draft.state.combatants[target.id], check);
        settleOutcome(draft);
        maybeAutoEnd(draft, actor.id);
        return closeDraft(draft);
    }
    if (action.type === 'defend') {
        if (!canAttackWith(turn)) return rejection(state, action, 'the action is already used');
        const draft = openDraft(state);
        draft.state.turn = spendAttackAction(turn);
        const self = draft.state.combatants[actor.id];
        self.conditions = [...self.conditions.filter(c => c.id !== DEFEND_CONDITION), { id: DEFEND_CONDITION, rounds: 1 }];
        emit(draft, { type: 'defend', actorId: actor.id, data: {}, text: `${actor.name} takes a defensive stance.` });
        maybeAutoEnd(draft, actor.id);
        return closeDraft(draft);
    }
    if (action.type === 'move') {
        const to = action.to;
        if (!state.grid || !actor.position || !to || typeof to.x !== 'number' || typeof to.y !== 'number') return rejection(state, action, 'cannot move here');
        const route = pathTo(state, actor.id, { x: to.x, y: to.y });
        if (!route || route.cost > turn.moveLeft) return rejection(state, action, 'that square cannot be reached');
        const draft = openDraft(state);
        const self = draft.state.combatants[actor.id];
        const from = { ...actor.position };
        const dest = { x: to.x, y: to.y };
        const rel = moveData(state, actor, from, dest);
        self.position = dest;
        draft.state.turn = { ...turn, moveLeft: turn.moveLeft - route.cost };
        emit(draft, {
            type: 'moved',
            actorId: actor.id,
            data: { from, to: dest, path: route.path, cost: route.cost, squares: route.path.length, ...rel },
            text: moveText(state, actor, route.path.length, rel),
        });
        maybeAutoEnd(draft, actor.id);
        return closeDraft(draft);
    }
    if (action.type === 'use_ability') {
        const aim = action.aim && typeof action.aim.x === 'number' && typeof action.aim.y === 'number' ? { x: action.aim.x, y: action.aim.y } : null;
        const check = checkAbility(state, actor.id, action.abilityId, aim);
        if (!check.ok || !check.ability || !check.aim) return rejection(state, action, check.reason ?? 'the ability cannot be used');
        const draft = openDraft(state);
        resolveAbility(draft, actor.id, check.ability, check.aim);
        settleOutcome(draft);
        maybeAutoEnd(draft, actor.id);
        return closeDraft(draft);
    }
    if (action.type === 'flee') {
        const check = checkFlee(state, actor.id, turn);
        if (!check.ok) return rejection(state, action, `cannot flee: ${(check.reason ?? 'unavailable').replace(/_/g, ' ')}`);
        const draft = openDraft(state);
        draft.state.turn = { ...turn, actionUsed: true };
        const escaped = attemptFlee(draft, draft.state.combatants[actor.id]);
        settleOutcome(draft);
        if (escaped) {
            if (!draft.state.outcome) advanceTurn(draft);
        } else {
            maybeAutoEnd(draft, actor.id);
        }
        return closeDraft(draft);
    }
    if (action.type === 'abandon') {
        if (!canAbandon(state, actor.id)) return rejection(state, action, 'cannot abandon the fight now');
        const draft = openDraft(state);
        abandonFight(draft);
        return closeDraft(draft);
    }
    if (action.type === 'parley') {
        const check = checkParley(state, actor.id, turn);
        if (!check.ok) return rejection(state, action, `cannot parley: ${(check.reason ?? 'unavailable').replace(/_/g, ' ')}`);
        if (!PARLEY_INTENT_SET.has(action.intent) || !PARLEY_RATING_SET.has(action.rating)) return rejection(state, action, 'invalid parley');
        const draft = openDraft(state);
        draft.state.turn = { ...turn, actionUsed: true };
        resolveParley(draft, draft.state.combatants[actor.id], action);
        if (!draft.state.outcome) {
            settleOutcome(draft);
            maybeAutoEnd(draft, actor.id);
        }
        return closeDraft(draft);
    }
    if (action.type === 'end_turn') {
        const draft = openDraft(state);
        const fresh = freshTurn(state, actor.id);
        const acted = turn.actionUsed || !!turn.bonusUsed || turn.moveLeft < fresh.moveLeft || (turn.extraActions ?? 0) < (fresh.extraActions ?? 0);
        emit(draft, { type: 'end_turn', actorId: actor.id, data: { acted }, text: acted ? `${actor.name} ends the turn.` : `${actor.name} holds.` });
        advanceTurn(draft);
        return closeDraft(draft);
    }
    return rejection(state, action, 'unknown action');
}

type Candidate = Pos & { cost: number; weight: number };

function pickTarget(state: CombatState, targets: Combatant[], preferredIds: ReadonlySet<string>): { id: string; state: CombatState } {
    const lowest = Math.min(...targets.map(t => t.hp));
    let tied = targets.filter(t => t.hp === lowest).sort((a, b) => state.order.indexOf(a.id) - state.order.indexOf(b.id));
    const preferred = tied.filter(t => preferredIds.has(t.id));
    if (preferred.length > 0) tied = preferred;
    if (tied.length === 1) return { id: tied[0].id, state };
    const rng = createRng(state.rngSeed, state.rngCursor);
    const pick = tied[rng.int(0, tied.length - 1)];
    return { id: pick.id, state: { ...state, rngCursor: rng.cursor } };
}

function byCost(a: Candidate, b: Candidate): number {
    return (a.weight - b.weight) || (a.cost - b.cost) || (a.y - b.y) || (a.x - b.x);
}

function approach(state: CombatState, actor: Combatant, turn: TurnState, wants: (tile: Pos) => boolean): Pos | null {
    const open = searchMoves(state, actor.id, { budget: Infinity, avoidHazards: true });
    if (!open || !actor.position) return null;
    let goal: Candidate | null = null;
    for (const d of destinations(open)) {
        if (!wants(d)) continue;
        if (!goal || byCost(d, goal) < 0) goal = d;
    }
    if (!goal) return null;
    const path = pathFromSearch(open, goal) ?? [];
    let stop: Pos | null = null;
    for (const p of path) {
        if (open.cost[p.y * open.grid.width + p.x] > turn.moveLeft) break;
        if (!isOccupied(state, p, actor.id)) stop = p;
    }
    return stop;
}

const BURST_NEIGHBOURS: readonly Pos[] = [
    { x: 0, y: 0 }, { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
];

function isDamaging(ability: GlyphAbility): boolean {
    return ability.effects.some(e => e.id === 'damage' || e.id === 'drain');
}

function chooseKitAction(state: CombatState, actor: Combatant, turn: TurnState): { action: CombatAction; state: CombatState } | null {
    const kit = (actor.kit ?? []).filter(a => isDamaging(a) && abilityReadiness(state, actor, a, turn) === null);
    if (kit.length === 0) return null;
    const hostiles = state.order.map(id => state.combatants[id]).filter(c => !!c && !!c.position && canTarget(actor, c));
    if (hostiles.length === 0) return null;
    for (const ability of kit.filter(a => a.form.id === 'burst')) {
        let best: { aim: Pos; hits: number } | null = null;
        const seen = new Set<string>();
        for (const h of hostiles) {
            for (const d of BURST_NEIGHBOURS) {
                const aim = { x: (h.position as Pos).x + d.x, y: (h.position as Pos).y + d.y };
                const key = `${aim.x},${aim.y}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const res = abilityTargets(state, actor.id, ability, aim);
                if (!res.ok) continue;
                const caught = res.targetIds.map(id => state.combatants[id]);
                const hits = caught.filter(c => canTarget(actor, c)).length;
                const friendly = caught.some(c => c.id === actor.id || sameTeam(actor.side, c.side));
                if (friendly || hits < 2) continue;
                if (!best || hits > best.hits) best = { aim, hits };
            }
        }
        if (best) return { action: { type: 'use_ability', actorId: actor.id, abilityId: ability.id, aim: best.aim }, state };
    }
    for (const ability of kit.filter(a => a.form.id === 'projectile' || a.form.id === 'touch' || a.form.id === 'dash')) {
        const legal = hostiles.filter(h => abilityTargets(state, actor.id, ability, h.position as Pos).ok);
        if (legal.length === 0) continue;
        const choice = pickTarget(state, legal, new Set());
        const aim = state.combatants[choice.id].position as Pos;
        return { action: { type: 'use_ability', actorId: actor.id, abilityId: ability.id, aim: { ...aim } }, state: choice.state };
    }
    return null;
}

function weaponTurn(state: CombatState, actor: Combatant, turn: TurnState, targets: Combatant[]): { actions: CombatAction[]; state: CombatState } {
    const actorId = actor.id;
    const end: CombatAction = { type: 'end_turn', actorId };
    if (!state.grid || !actor.position) {
        const pick = pickTarget(state, targets, new Set());
        return { actions: [{ type: 'attack', actorId, targetId: pick.id }, end], state: pick.state };
    }

    const here: Candidate = { ...actor.position, cost: 0, weight: 0 };
    const search = searchMoves(state, actorId, { budget: turn.moveLeft, avoidHazards: true });
    const tiles: Candidate[] = [here, ...(search ? destinations(search) : [])];
    const shotsFrom = (p: Pos) => targets.filter(t => checkAttack(state, actorId, t.id, p).ok);
    const isSafe = (p: Pos) => !hostileAdjacent(state, actor, p);
    const atHere = new Set(shotsFrom(here).map(t => t.id));
    const plan = (tile: Candidate, choice: { id: string; state: CombatState }) => {
        const actions: CombatAction[] = [];
        if (!samePos(tile, actor.position)) actions.push({ type: 'move', actorId, to: { x: tile.x, y: tile.y } });
        actions.push({ type: 'attack', actorId, targetId: choice.id }, end);
        return { actions, state: choice.state };
    };

    if (rangeOf(actor) !== 'ranged') {
        const bestTile = new Map<string, Candidate>();
        for (const tile of tiles) {
            for (const t of shotsFrom(tile)) {
                const prev = bestTile.get(t.id);
                if (!prev || byCost(tile, prev) < 0) bestTile.set(t.id, tile);
            }
        }
        const attackable = targets.filter(t => bestTile.has(t.id));
        if (attackable.length > 0) {
            const choice = pickTarget(state, attackable, atHere);
            return plan(atHere.has(choice.id) ? here : bestTile.get(choice.id) as Candidate, choice);
        }
        const stop = approach(state, actor, turn, p => targets.some(t => checkAttack(state, actorId, t.id, p).ok));
        return { actions: stop ? [{ type: 'move', actorId, to: stop }, end] : [end], state };
    }

    if (isSafe(here) && atHere.size > 0) {
        return plan(here, pickTarget(state, targets.filter(t => atHere.has(t.id)), atHere));
    }
    const shooting = tiles.filter(t => !samePos(t, here) && shotsFrom(t).length > 0);
    const safe = shooting.filter(isSafe).sort(byCost);
    if (safe.length > 0) {
        const tile = safe[0];
        const from = new Set(shotsFrom(tile).map(t => t.id));
        return plan(tile, pickTarget(state, targets.filter(t => from.has(t.id)), from));
    }
    if (atHere.size > 0) {
        return plan(here, pickTarget(state, targets.filter(t => atHere.has(t.id)), atHere));
    }
    const fallback = shooting.sort(byCost)[0];
    if (fallback) {
        const from = new Set(shotsFrom(fallback).map(t => t.id));
        return plan(fallback, pickTarget(state, targets.filter(t => from.has(t.id)), from));
    }
    const stop = approach(state, actor, turn, p => isSafe(p) && targets.some(t => checkAttack(state, actorId, t.id, p).ok));
    return { actions: stop ? [{ type: 'move', actorId, to: stop }, end] : [end], state };
}

function retreatTurn(state: CombatState, actor: Combatant, turn: TurnState): { actions: CombatAction[]; state: CombatState } {
    const actorId = actor.id;
    const end: CombatAction = { type: 'end_turn', actorId };
    const targets = state.order.map(id => state.combatants[id]).filter(c => !!c && canTarget(actor, c));
    const grid = terrainOf(state);
    if (!grid || !actor.position) {
        if (!canAttackWith(turn) || targets.length === 0) return { actions: [end], state };
        return weaponTurn(state, actor, turn, targets);
    }
    const standAndStrike = (): { actions: CombatAction[]; state: CombatState } => {
        if (!canAttackWith(turn)) return { actions: [end], state };
        const here = targets.filter(t => checkAttack(state, actorId, t.id).ok);
        if (here.length === 0) return { actions: [end], state };
        const pick = pickTarget(state, here, new Set());
        return { actions: [{ type: 'attack', actorId, targetId: pick.id }, end], state: pick.state };
    };
    if (checkFlee(state, actorId, turn).ok) return { actions: [{ type: 'flee', actorId }, end], state };
    if (isEdgeTile(grid, actor.position)) return standAndStrike();
    const stop = turn.moveLeft > 0 ? approach(state, actor, turn, p => isEdgeTile(grid, p)) : null;
    if (stop) return { actions: [{ type: 'move', actorId, to: stop }, end], state };
    const open = searchMoves(state, actorId, { budget: Infinity, avoidHazards: true });
    if (open && destinations(open).some(d => isEdgeTile(grid, d))) return standAndStrike();
    if (!canAttackWith(turn) || targets.length === 0) return { actions: [end], state };
    return weaponTurn(state, actor, turn, targets);
}

export function chooseEngineTurn(state: CombatState, actorId: string): { actions: CombatAction[]; state: CombatState } {
    const actor = state.combatants[actorId];
    const end: CombatAction = { type: 'end_turn', actorId };
    if (!actor || actor.status !== 'up') return { actions: [end], state };
    const turn = currentActorId(state) === actorId ? currentTurn(state) as TurnState : freshTurn(state, actorId);
    if (isRetreating(state, actor)) return retreatTurn(state, actor, turn);
    if (!canAttackWith(turn)) return { actions: [end], state };
    const targets = state.order.map(id => state.combatants[id]).filter(c => !!c && canTarget(actor, c));
    if (targets.length === 0) return { actions: [end], state };
    const weapon = weaponTurn(state, actor, turn, targets);
    if (actor.kit && actor.kit.length > 0 && !turn.actionUsed && state.grid && actor.position) {
        const first = weapon.actions[0];
        const movingToAttack = first?.type === 'move' && weapon.actions.some(a => a.type === 'attack');
        if (!movingToAttack) {
            const kit = chooseKitAction(state, actor, turn);
            if (kit) return { actions: [kit.action, end], state: kit.state };
        }
    }
    return weapon;
}

export function stepEngine(state: CombatState): { state: CombatState; events: CombatEvent[] } | null {
    if (state.outcome) return null;
    const id = currentActorId(state);
    const actor = id ? state.combatants[id] : undefined;
    if (!actor) return null;
    if (actor.status !== 'up') {
        const draft = openDraft(state);
        advanceTurn(draft);
        return closeDraft(draft);
    }
    if (actor.controller === 'player') return null;
    const choice = chooseEngineTurn(state, actor.id);
    const action = choice.actions[0] ?? { type: 'end_turn', actorId: actor.id };
    const result = applyAction(choice.state, action);
    if (result.events.some(e => e.type === 'rejected')) return applyAction(choice.state, { type: 'end_turn', actorId: actor.id });
    return result;
}

export function runEngineTurns(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    let current = state;
    const events: CombatEvent[] = [];
    for (let i = 0; i < MAX_ENGINE_ACTIONS; i++) {
        const step = stepEngine(current);
        if (!step) break;
        current = step.state;
        events.push(...step.events);
    }
    return { state: current, events };
}

export function deriveMapSeed(seed: number): number {
    return (Math.imul((seed >>> 0) ^ MAP_SEED_SALT, 2654435761) >>> 0);
}

function casterKitFields(c: { side: Combatant['side']; tier: Combatant['tier']; archetype?: Combatant['archetype'] }, abilities: Combatant['abilities'], damageType: string): Partial<Combatant> {
    if (c.side === 'neutral') return {};
    const kit = enemyKit(c.tier, c.archetype, damageType);
    if (kit.length === 0) return {};
    const row = TIER_TABLE[c.tier] ?? TIER_TABLE.grunt;
    return {
        kit,
        proficiency: proficiencyForLevel(TIER_LEVEL[c.tier] ?? 3),
        castingAbility: defaultCastingAbility(abilities),
        abilityDamage: { ...row.damage },
    };
}

export function createCombat(spec: CombatSpec, pc: Combatant, seed: number): { state: CombatState; events: CombatEvent[] } {
    const rng = createRng(seed, 0);
    const jitter = spec.jitterRange ?? DEFAULT_JITTER_RANGE;
    const combatants: Record<string, Combatant> = {};
    const pcEntry: Combatant = { ...pc, status: 'up', conditions: [], initiative: 0 };
    combatants[pcEntry.id] = pcEntry;
    spec.combatants.forEach((c, index) => {
        let id = c.id && !combatants[c.id] ? c.id : `c${index + 1}`;
        while (combatants[id]) id = `${id}_`;
        const block = buildTierBlock(c.tier, c.archetype, jitter, rng, c.look);
        const t = c.template;
        let maxHp = block.maxHp;
        let ac = block.ac;
        let attackBonus = block.attackBonus;
        let damage = block.damage;
        if (t?.mode === 'replace') {
            if (t.maxHp !== undefined) maxHp = t.maxHp;
            if (t.ac !== undefined) ac = t.ac;
            if (t.attackBonus !== undefined) attackBonus = t.attackBonus;
            if (t.damage) damage = { ...t.damage, type: block.damage.type };
        } else if (t?.mode === 'floor') {
            if (t.maxHp !== undefined) maxHp = Math.max(maxHp, t.maxHp);
            if (t.ac !== undefined) ac = Math.max(ac, t.ac);
        }
        const range: AttackRange = c.range ?? (c.archetype === 'caster' ? 'ranged' : 'close');
        combatants[id] = {
            id,
            name: c.name,
            side: c.side,
            controller: c.side === 'ally' && spec.partyControl === 'player' ? 'player' : 'engine',
            tier: c.tier,
            ...(c.archetype ? { archetype: c.archetype } : {}),
            ...(c.npcId ? { npcId: c.npcId } : {}),
            ...(c.species ? { species: c.species } : {}),
            ...(c.look ? { look: c.look } : {}),
            ...(c.manner ? { manner: c.manner } : {}),
            abilities: block.abilities,
            maxHp: Math.max(1, Math.round(maxHp)),
            hp: Math.max(1, Math.round(maxHp)),
            ac,
            attackBonus,
            damage,
            initiative: 0,
            status: 'up',
            conditions: [],
            range,
            ...(t?.weaknesses && t.weaknesses.length > 0 ? { weaknesses: [...t.weaknesses] } : {}),
            ...(t?.resistances && t.resistances.length > 0 ? { resistances: [...t.resistances] } : {}),
            ...casterKitFields(c, block.abilities, damage.type),
        };
    });

    const tiebreak: Record<string, number> = {};
    for (const c of Object.values(combatants)) {
        c.initiative = rng.roll(20) + abilityMod(c.abilities.DEX);
        tiebreak[c.id] = rng.next();
    }
    const order = Object.values(combatants)
        .sort((a, b) => (b.initiative - a.initiative) || (b.abilities.DEX - a.abilities.DEX) || (tiebreak[b.id] - tiebreak[a.id]))
        .map(c => c.id);

    const mapSeed = Number.isFinite(spec.mapSeed) ? (spec.mapSeed as number) >>> 0 : deriveMapSeed(seed);
    const grid = spec.map ? buildMapFromSeed(resolveMapSpec(spec.map, { combatants: spec.combatants.length }), mapSeed) : openArena('medium');
    const positions = placeCombatants(grid, Object.values(combatants).map(c => ({ id: c.id, side: c.side })));
    for (const [id, pos] of Object.entries(positions)) combatants[id].position = pos;
    for (const c of Object.values(combatants)) c.startHp = c.hp;

    const state: CombatState = {
        id: spec.id,
        round: 1,
        order,
        turnIndex: 0,
        combatants,
        rngSeed: seed,
        rngCursor: rng.cursor,
        eventSeq: 0,
        outcome: null,
        grid,
        mapSeed,
        turnCount: 0,
        ...(Number.isFinite(spec.maxSummons) ? { maxSummons: Math.max(0, Math.floor(spec.maxSummons as number)) } : {}),
        ...(spec.partyControl ? { partyControl: spec.partyControl } : {}),
        ...(spec.defeatMode ? { defeatMode: spec.defeatMode } : {}),
    };
    state.morale = buildMoraleBook(state);
    const draft: Draft = { state, rng, events: [] };
    const roster = order.map(id => combatants[id]);
    emit(draft, {
        type: 'combat_started',
        data: { combatants: roster.map(c => ({ id: c.id, name: c.name, side: c.side, tier: c.tier })) },
        text: `Combat begins. ${roster.filter(c => isPlayerSide(c.side)).map(c => c.name).join(', ')} against ${roster.filter(c => !isPlayerSide(c.side)).map(c => c.name).join(', ')}.`,
    });
    emit(draft, {
        type: 'initiative',
        data: { order: roster.map(c => ({ id: c.id, initiative: c.initiative })) },
        text: `Initiative: ${roster.map(c => `${c.name} ${c.initiative}`).join(', ')}.`,
    });
    startTurn(draft);
    return closeDraft(draft);
}

export function concedeCombat(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    if (state.outcome) return { state, events: [] };
    const draft = openDraft(state);
    concedeFight(draft);
    return closeDraft(draft);
}

export type HpBand = 'unhurt' | 'hurt' | 'badly_hurt' | 'down' | 'fled' | 'yielded';

export function hpBand(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): HpBand {
    if (c.status === 'fled') return 'fled';
    if (c.status === 'surrendered') return 'yielded';
    if (c.status !== 'up' || c.hp <= 0) return 'down';
    if (c.hp >= c.maxHp) return 'unhurt';
    return c.hp * 2 > c.maxHp ? 'hurt' : 'badly_hurt';
}
