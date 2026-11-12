import { abilityMod } from './abilities';
import { createRng } from './rng';
import { buildTierBlock, DEFAULT_JITTER_RANGE } from './tiers';
import {
    coverBetween, distance, hasLineOfSight, inBounds, isOccupied, pathCost, pathFromSearch, rangeOf, REACH_DISTANCE,
    RANGED_DISTANCE, searchMoves, destinations, samePos, speedOf, tileAt,
} from './grid';
import { buildMapFromSeed, DEFAULT_HAZARD_TYPE, placeCombatants } from './mapBuilder';
import type {
    AttackRange, CombatAction, CombatEvent, CombatOutcome, CombatSpec, CombatState, Combatant, Pos, Rng, Side, TurnState,
} from './types';

export const DEFEND_CONDITION = 'defending';
export const HAZARD_DAMAGE_DIE = 6;

const MAX_ENGINE_ACTIONS = 2000;
const MAP_SEED_SALT = 0x5bd1e995;

type Draft = {
    state: CombatState;
    rng: Rng;
    events: CombatEvent[];
};

function cloneState(state: CombatState): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) {
        combatants[id] = {
            ...c,
            abilities: { ...c.abilities },
            damage: { ...c.damage },
            conditions: c.conditions.map(x => ({ ...x })),
            ...(c.position ? { position: { ...c.position } } : {}),
        };
    }
    return { ...state, order: [...state.order], combatants, ...(state.turn ? { turn: { ...state.turn } } : {}) };
}

function openDraft(state: CombatState): Draft {
    const next = cloneState(state);
    return { state: next, rng: createRng(next.rngSeed, next.rngCursor), events: [] };
}

function closeDraft(draft: Draft): { state: CombatState; events: CombatEvent[] } {
    draft.state.rngCursor = draft.rng.cursor;
    return { state: draft.state, events: draft.events };
}

function emit(draft: Draft, event: Omit<CombatEvent, 'seq' | 'round' | 'turn'>): void {
    draft.state.eventSeq += 1;
    draft.events.push({ seq: draft.state.eventSeq, round: draft.state.round, turn: draft.state.turnCount ?? 0, ...event });
}

function isPlayerSide(side: Side): boolean {
    return side === 'player' || side === 'ally';
}

export function isHostile(a: Side, b: Side): boolean {
    if (a === 'neutral' || b === 'neutral') return false;
    return isPlayerSide(a) !== isPlayerSide(b);
}

export function canTarget(actor: Combatant, target: Combatant): boolean {
    if (actor.id === target.id || target.status !== 'up') return false;
    if (actor.controller === 'player') return target.side === 'enemy' || target.side === 'neutral';
    return isHostile(actor.side, target.side);
}

export function currentActorId(state: CombatState): string | null {
    return state.order[state.turnIndex] ?? null;
}

export function freshTurn(state: CombatState, actorId: string): TurnState {
    const actor = state.combatants[actorId];
    return { actorId, moveLeft: state.grid && actor ? speedOf(actor) : 0, actionUsed: false };
}

export function currentTurn(state: CombatState): TurnState | null {
    const id = currentActorId(state);
    if (!id) return null;
    if (state.turn && state.turn.actorId === id) return state.turn;
    return freshTurn(state, id);
}

export function checkOutcome(state: CombatState): CombatOutcome | null {
    if (state.outcome) return state.outcome;
    const all = Object.values(state.combatants);
    const enemiesUp = all.some(c => c.side === 'enemy' && c.status === 'up');
    const playersUp = all.some(c => isPlayerSide(c.side) && c.status === 'up');
    if (!playersUp) return 'defeat';
    if (!enemiesUp) return 'victory';
    return null;
}

function rollDamage(rng: Rng, count: number, sides: number, bonus: number): number {
    let total = bonus;
    for (let i = 0; i < count; i++) total += rng.roll(sides);
    return Math.max(1, total);
}

function startTurn(draft: Draft): void {
    const id = currentActorId(draft.state);
    if (!id) return;
    const actor = draft.state.combatants[id];
    if (!actor) return;
    draft.state.turnCount = (draft.state.turnCount ?? 0) + 1;
    draft.state.turn = freshTurn(draft.state, id);
    actor.conditions = actor.conditions.filter(c => c.id !== DEFEND_CONDITION);
}

function downText(target: Combatant): string {
    return isPlayerSide(target.side) ? `${target.name} falls unconscious.` : `${target.name} is down.`;
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
            c.hp = Math.max(0, c.hp - damage);
            emit(draft, {
                type: 'hazard',
                targetId: c.id,
                data: { damage, damageType, hpAfter: c.hp },
                text: `${c.name} takes ${damage} ${damageType} damage from the hazard.`,
            });
            if (c.hp <= 0) {
                c.status = 'down';
                emit(draft, { type: 'down', targetId: c.id, data: { side: c.side, cause: 'hazard' }, text: downText(c) });
            }
        }
        const kept: { id: string; rounds: number }[] = [];
        for (const cond of c.conditions) {
            if (cond.id === DEFEND_CONDITION) {
                kept.push(cond);
                continue;
            }
            const rounds = cond.rounds - 1;
            if (rounds > 0) kept.push({ ...cond, rounds });
            else emit(draft, { type: 'condition_ended', targetId: c.id, data: { condition: cond.id }, text: `${c.name} is no longer ${cond.id}.` });
        }
        c.conditions = kept;
    }
}

function settleOutcome(draft: Draft): void {
    const outcome = checkOutcome(draft.state);
    if (!outcome || draft.state.outcome) return;
    draft.state.outcome = outcome;
    emit(draft, { type: 'combat_ended', data: { outcome }, text: outcome === 'victory' ? 'The fight is won.' : 'The fight is lost.' });
}

function advanceTurn(draft: Draft): void {
    const s = draft.state;
    const n = s.order.length;
    if (n === 0) return;
    for (let step = 0; step < n; step++) {
        s.turnIndex += 1;
        if (s.turnIndex >= n) {
            s.turnIndex = 0;
            environmentStep(draft);
            settleOutcome(draft);
            if (s.outcome) return;
            s.round += 1;
            emit(draft, { type: 'round', data: { round: s.round }, text: `Round ${s.round} begins.` });
        }
        const next = s.combatants[s.order[s.turnIndex]];
        if (next && next.status === 'up') {
            startTurn(draft);
            return;
        }
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
    const grid = state.grid;
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
    const disadvantage = defending || check.disadvantage;
    const first = draft.rng.roll(20);
    const natural = disadvantage ? Math.min(first, draft.rng.roll(20)) : first;
    const total = natural + actor.attackBonus;
    const ac = target.ac + check.cover;
    const crit = natural === 20;
    const hit = crit || (natural !== 1 && total >= ac);
    const dmgType = actor.damage.type;
    const base = { natural, total, ac, cover: check.cover, range: check.range, disadvantage, defending, adjacentShot: check.disadvantage };
    if (!hit) {
        emit(draft, {
            type: 'attack',
            actorId: actor.id,
            targetId: target.id,
            data: { ...base, hit: false, crit: false, fumble: natural === 1 },
            text: `${actor.name} attacks ${target.name} and misses.`,
        });
        return;
    }
    const count = crit ? actor.damage.count * 2 : actor.damage.count;
    const damage = rollDamage(draft.rng, count, actor.damage.sides, actor.damage.bonus);
    target.hp = Math.max(0, target.hp - damage);
    emit(draft, {
        type: 'attack',
        actorId: actor.id,
        targetId: target.id,
        data: { ...base, hit: true, crit, damage, damageType: dmgType, hpAfter: target.hp },
        text: crit
            ? `${actor.name} lands a critical hit on ${target.name} for ${damage} ${dmgType}.`
            : `${actor.name} hits ${target.name} for ${damage} ${dmgType}.`,
    });
    if (target.hp <= 0 && target.status === 'up') {
        target.status = 'down';
        emit(draft, { type: 'down', actorId: actor.id, targetId: target.id, data: { side: target.side }, text: downText(target) });
    }
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

function maybeAutoEnd(draft: Draft, actorId: string): void {
    const s = draft.state;
    if (s.outcome || currentActorId(s) !== actorId) return;
    const turn = currentTurn(s);
    if (!turn || !turn.actionUsed) return;
    if (turn.moveLeft <= 0 || !hasAnyMove(s, actorId)) advanceTurn(draft);
}

export function applyAction(state: CombatState, action: CombatAction): { state: CombatState; events: CombatEvent[] } {
    if (state.outcome) return rejection(state, action, 'the fight is over');
    const actorId = currentActorId(state);
    const actor = actorId ? state.combatants[actorId] : undefined;
    if (!actor || !action || action.actorId !== actorId) return rejection(state, action, 'not this combatant\'s turn');
    if (actor.status !== 'up') return rejection(state, action, 'the combatant cannot act');
    const turn = currentTurn(state) as TurnState;

    if (action.type === 'attack') {
        if (turn.actionUsed) return rejection(state, action, 'the action is already used');
        const target = state.combatants[action.targetId];
        if (!target || !canTarget(actor, target)) return rejection(state, action, 'invalid target');
        const check = checkAttack(state, actor.id, target.id);
        if (!check.ok) return rejection(state, action, check.reason === 'no_line_of_sight' ? 'no line of sight' : 'out of range');
        const draft = openDraft(state);
        draft.state.turn = { ...turn, actionUsed: true };
        resolveAttack(draft, draft.state.combatants[actor.id], draft.state.combatants[target.id], check);
        settleOutcome(draft);
        maybeAutoEnd(draft, actor.id);
        return closeDraft(draft);
    }
    if (action.type === 'defend') {
        if (turn.actionUsed) return rejection(state, action, 'the action is already used');
        const draft = openDraft(state);
        draft.state.turn = { ...turn, actionUsed: true };
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
    if (action.type === 'end_turn') {
        const draft = openDraft(state);
        const acted = turn.actionUsed || turn.moveLeft < freshTurn(state, actor.id).moveLeft;
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

export function chooseEngineTurn(state: CombatState, actorId: string): { actions: CombatAction[]; state: CombatState } {
    const actor = state.combatants[actorId];
    const end: CombatAction = { type: 'end_turn', actorId };
    if (!actor || actor.status !== 'up') return { actions: [end], state };
    const turn = currentActorId(state) === actorId ? currentTurn(state) as TurnState : freshTurn(state, actorId);
    if (turn.actionUsed) return { actions: [end], state };
    const targets = state.order.map(id => state.combatants[id]).filter(c => !!c && canTarget(actor, c));
    if (targets.length === 0) return { actions: [end], state };

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
            controller: 'engine',
            tier: c.tier,
            ...(c.archetype ? { archetype: c.archetype } : {}),
            ...(c.npcId ? { npcId: c.npcId } : {}),
            ...(c.species ? { species: c.species } : {}),
            ...(c.look ? { look: c.look } : {}),
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
    const grid = buildMapFromSeed(spec.map, mapSeed);
    const positions = placeCombatants(grid, Object.values(combatants).map(c => ({ id: c.id, side: c.side })));
    for (const [id, pos] of Object.entries(positions)) combatants[id].position = pos;

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
    };
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

export type HpBand = 'unhurt' | 'hurt' | 'badly_hurt' | 'down';

export function hpBand(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): HpBand {
    if (c.status !== 'up' || c.hp <= 0) return 'down';
    if (c.hp >= c.maxHp) return 'unhurt';
    return c.hp * 2 > c.maxHp ? 'hurt' : 'badly_hurt';
}
