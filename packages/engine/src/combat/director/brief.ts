import { TACTICS } from '../ai/tables';
import { tacticOf } from '../ai/tactic';
import { canTarget, currentActorId, currentTurn, freshTurn } from '../core';
import { destinations, distance, sameTeam, searchMoves, terrainOf } from '../grid';
import { checkAttack } from '../glyphs/builtins';
import { hasLose, leaderIdOf, mainWin, objectiveClock, wardIdOf } from '../objectives/marks';
import type { CombatState, Combatant, CombatantStatus, OrderKind, Pos, Side, Tactic } from '../types';
import { activeOrder, isDirected } from './orders';
import { signatureReady } from './signature';
import { ORDER_LIMITS } from './tables';

export type BriefBand = 'full' | 'hurt' | 'bloodied' | 'near_death';

export type BriefUnit = {
    id: string;
    name: string;
    side: Side;
    tier: Combatant['tier'];
    controller: Combatant['controller'];
    tactic?: Tactic;
    hp: BriefBand;
    conditions: string[];
    at: Pos | null;
    directed: boolean;
    mark?: Combatant['mark'];
};

export type BriefFoe = { id: string; distance: number; canHit: boolean };

export type BriefAlly = { id: string; distance: number };

export type BriefDirected = {
    id: string;
    tactic: Tactic;
    kinds: OrderKind[];
    focus: string[];
    protect: string[];
    tactics: Tactic[];
    signature: { name: string; usesLeft: number; ready: boolean } | null;
    order: { kind: OrderKind; targetId?: string; tactic?: Tactic } | null;
    foes: BriefFoe[];
    allies: BriefAlly[];
};

export type BriefObjective = {
    win: string;
    with?: string;
    leader?: string;
    ward?: string;
    lose: string[];
    side?: string;
    clock?: { kind: string; left: number };
};

export type DirectorBrief = {
    round: number;
    objective: BriefObjective | null;
    units: BriefUnit[];
    adjacent: Array<[string, string]>;
    directed: BriefDirected[];
};

export function briefBand(c: Pick<Combatant, 'hp' | 'maxHp'>): BriefBand {
    const frac = c.maxHp > 0 ? c.hp / c.maxHp : 0;
    if (c.hp >= c.maxHp) return 'full';
    if (frac > ORDER_LIMITS.bloodiedBand) return 'hurt';
    if (frac > ORDER_LIMITS.nearDeathBand) return 'bloodied';
    return 'near_death';
}

const STANDING: CombatantStatus = 'up';

function objectiveBrief(state: CombatState): BriefObjective | null {
    const o = state.objective;
    if (!o) return null;
    const name = (id: string | undefined) => (id ? state.combatants[id]?.name : undefined);
    const main = mainWin(o);
    const leader = name(leaderIdOf(o));
    const ward = name(wardIdOf(o));
    const clock = objectiveClock(state);
    const lose = o.lose ? o.lose.map(l => l.kind) : [];
    if (hasLose(o, 'round_limit') && !lose.includes('round_limit')) lose.push('round_limit');
    return {
        win: o.win.kind,
        ...(o.win.kind === 'protect' && main ? { with: main.kind } : {}),
        ...(leader ? { leader } : {}),
        ...(ward ? { ward } : {}),
        lose,
        ...(o.side ? { side: o.side.kind } : {}),
        ...(clock ? { clock: { kind: clock.kind, left: clock.left } } : {}),
    };
}

function reachableTiles(state: CombatState, id: string): Pos[] {
    const unit = state.combatants[id];
    if (!unit.position) return [];
    const turn = currentActorId(state) === id ? currentTurn(state) : freshTurn(state, id);
    const search = searchMoves(state, id, { budget: turn?.moveLeft ?? 0, avoidHazards: false });
    return [unit.position, ...(search ? destinations(search).map(d => ({ x: d.x, y: d.y })) : [])];
}

function directedEntry(state: CombatState, unit: Combatant, standing: Combatant[]): BriefDirected {
    const here = unit.position;
    const foes = standing.filter(c => canTarget(unit, c));
    const allies = standing.filter(c => c.id !== unit.id && c.side !== 'neutral' && sameTeam(unit.side, c.side));
    const tiles = terrainOf(state) && here ? reachableTiles(state, unit.id) : [];
    const gridless = !terrainOf(state) || !here;
    const distanceTo = (c: Combatant) => (here && c.position ? distance(here, c.position) : 0);
    const foeList: BriefFoe[] = foes
        .map(c => ({
            id: c.id,
            distance: distanceTo(c),
            canHit: gridless || tiles.some(t => checkAttack(state, unit.id, c.id, t).ok),
        }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    const allyList: BriefAlly[] = allies
        .map(c => ({ id: c.id, distance: distanceTo(c) }))
        .sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
    const sig = unit.signature;
    const sigAbility = sig ? unit.kit?.find(a => a.id === sig.abilityId) : undefined;
    const current = tacticOf(unit);
    const kinds: OrderKind[] = [];
    if (foeList.length > 0) kinds.push('focus');
    if (allyList.length > 0) kinds.push('protect');
    kinds.push('hold', 'fall_back', 'press');
    if (sig && sigAbility && sig.usesLeft > 0) kinds.push('signature');
    kinds.push('switch_tactic');
    const order = activeOrder(state, unit);
    return {
        id: unit.id,
        tactic: current,
        kinds,
        focus: foeList.map(f => f.id),
        protect: allyList.map(a => a.id),
        tactics: TACTICS.filter(t => t !== current),
        signature: sig && sigAbility ? { name: sigAbility.name, usesLeft: sig.usesLeft, ready: signatureReady(state, unit) } : null,
        order: order ? { kind: order.kind, ...(order.targetId ? { targetId: order.targetId } : {}), ...(order.tactic ? { tactic: order.tactic } : {}) } : null,
        foes: foeList,
        allies: allyList,
    };
}

export function directorBrief(state: CombatState): DirectorBrief {
    const standing = state.order
        .map(id => state.combatants[id])
        .filter((c): c is Combatant => !!c && c.status === STANDING);
    const units: BriefUnit[] = standing.map(c => ({
        id: c.id,
        name: c.name,
        side: c.side,
        tier: c.tier,
        controller: c.controller,
        ...(c.controller === 'engine' ? { tactic: tacticOf(c) } : {}),
        hp: briefBand(c),
        conditions: c.conditions.map(x => x.id),
        at: c.position ? { x: c.position.x, y: c.position.y } : null,
        directed: isDirected(c),
        ...(c.mark ? { mark: c.mark } : {}),
    }));
    const adjacent: Array<[string, string]> = [];
    for (let i = 0; i < standing.length; i++) {
        for (let j = i + 1; j < standing.length; j++) {
            const a = standing[i].position;
            const b = standing[j].position;
            if (a && b && distance(a, b) <= 1) adjacent.push([standing[i].id, standing[j].id]);
        }
    }
    const directed = state.outcome ? [] : standing.filter(isDirected).map(c => directedEntry(state, c, standing));
    return { round: state.round, objective: objectiveBrief(state), units, adjacent, directed };
}
