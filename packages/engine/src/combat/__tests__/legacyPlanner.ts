import { createRng } from '../rng';
import { destinations, isOccupied, pathFromSearch, rangeOf, samePos, sameTeam, searchMoves, terrainOf } from '../grid';
import { canAttackWith, canTarget, currentActorId, currentTurn, freshTurn } from '../core';
import { abilityReadiness } from '../glyphs/apply';
import { checkAttack, hostileAdjacent } from '../glyphs/builtins';
import { abilityTargets } from '../glyphs/targeting';
import { checkFlee, isEdgeTile, isRetreating } from '../party';
import type { CombatAction, CombatState, Combatant, GlyphAbility, Pos, TurnState } from '../types';

type Candidate = Pos & { cost: number; weight: number };
type Choice = { actions: CombatAction[]; state: CombatState };

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

function weaponTurn(state: CombatState, actor: Combatant, turn: TurnState, targets: Combatant[]): Choice {
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
    if (isSafe(here) && atHere.size > 0) return plan(here, pickTarget(state, targets.filter(t => atHere.has(t.id)), atHere));
    const shooting = tiles.filter(t => !samePos(t, here) && shotsFrom(t).length > 0);
    const safe = shooting.filter(isSafe).sort(byCost);
    if (safe.length > 0) {
        const from = new Set(shotsFrom(safe[0]).map(t => t.id));
        return plan(safe[0], pickTarget(state, targets.filter(t => from.has(t.id)), from));
    }
    if (atHere.size > 0) return plan(here, pickTarget(state, targets.filter(t => atHere.has(t.id)), atHere));
    const fallback = shooting.sort(byCost)[0];
    if (fallback) {
        const from = new Set(shotsFrom(fallback).map(t => t.id));
        return plan(fallback, pickTarget(state, targets.filter(t => from.has(t.id)), from));
    }
    const stop = approach(state, actor, turn, p => isSafe(p) && targets.some(t => checkAttack(state, actorId, t.id, p).ok));
    return { actions: stop ? [{ type: 'move', actorId, to: stop }, end] : [end], state };
}

function retreatTurn(state: CombatState, actor: Combatant, turn: TurnState): Choice {
    const actorId = actor.id;
    const end: CombatAction = { type: 'end_turn', actorId };
    const targets = state.order.map(id => state.combatants[id]).filter(c => !!c && canTarget(actor, c));
    const grid = terrainOf(state);
    if (!grid || !actor.position) {
        if (!canAttackWith(turn) || targets.length === 0) return { actions: [end], state };
        return weaponTurn(state, actor, turn, targets);
    }
    const standAndStrike = (): Choice => {
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

export function legacyEngineTurn(state: CombatState, actorId: string): Choice {
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
