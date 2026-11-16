import { countsForOutcome, emit, endFight, playerCharacterOf } from '../core';
import type { Draft } from '../core';
import { distance, inBounds, isWalkable, terrainOf, tileAt } from '../grid';
import { leaveField, MORALE_DC_LEADER_DOWN } from '../party';
import { TIER_TABLE } from '../tiers';
import type {
    CombatEvent, CombatObjective, CombatOutcome, CombatState, Combatant, ObjectiveEndReason, ObjectiveProgress, ObjectiveResult, Pos,
    ReinforcementWave,
} from '../types';
import {
    exitsOf, hasLose, isPartySide, leaderExitsOf, leaderIdOf, mainWin, objectiveClock, onTiles, reachTileOf, seizeTileOf,
} from './marks';
import { OBJECTIVE_EVENT_TYPES, OBJECTIVE_LIMITS } from './tables';

export type ObjectiveSummary = { status: ObjectiveResult['status']; by: ObjectiveEndReason; side?: ObjectiveResult['side'] };

function setProgress(draft: Draft, patch: Partial<ObjectiveProgress>): void {
    const o = draft.state.objective as CombatObjective;
    draft.state.objective = { ...o, progress: { ...(o.progress ?? {}), ...patch } };
}

function party(state: CombatState): Combatant[] {
    return state.order.map(id => state.combatants[id]).filter((c): c is Combatant => !!c && !c.summonerId && isPartySide(c.side));
}

function wardUp(state: CombatState, o: CombatObjective): boolean {
    if (o.win.kind !== 'protect') return true;
    const status = state.combatants[o.win.wardId]?.status;
    return status === 'up' || status === 'escaped';
}

function trackProgress(draft: Draft): void {
    const s = draft.state;
    const o = s.objective as CombatObjective;
    if (!o.progress?.someoneFell && party(s).some(c => c.status === 'down')) setProgress(draft, { someoneFell: true });
    const holderId = s.objective?.progress?.holderId;
    if (holderId) {
        const holder = s.combatants[holderId];
        const tile = seizeTileOf(o);
        if (!holder || holder.status !== 'up' || !tile || !onTiles([tile], holder.position)) {
            setProgress(draft, { holderId: undefined });
            emit(draft, {
                type: 'objective_progress',
                targetId: holderId,
                data: { kind: 'hold_broken', unitId: holderId },
                text: `${holder?.name ?? 'Someone'} loses the hold on the marked square.`,
            });
        }
    }
}

function immediateLoss(state: CombatState, o: CombatObjective): ObjectiveEndReason | null {
    for (const l of o.lose ?? []) {
        if (l.kind === 'pc_falls' && playerCharacterOf(state)?.status === 'down') return 'pc_falls';
        if (l.kind === 'ward_falls') {
            const ward = state.combatants[l.wardId];
            if (!ward || ward.status === 'down' || ward.status === 'gone') return 'ward_falls';
        }
        if (l.kind === 'leader_escapes' && state.combatants[l.leaderId]?.status === 'escaped') return 'leader_escapes';
    }
    return null;
}

function enemiesStanding(state: CombatState): boolean {
    return Object.values(state.combatants).some(c => countsForOutcome(c) && c.side === 'enemy' && c.status === 'up');
}

function immediateWin(state: CombatState, o: CombatObjective): ObjectiveEndReason | null {
    if (!wardUp(state, o)) return null;
    const win = mainWin(o);
    if (win?.kind === 'defeat_leader' && state.combatants[win.leaderId]?.status !== 'up') return 'defeat_leader';
    if (win?.kind === 'escape') {
        const pc = playerCharacterOf(state);
        if (pc?.status === 'escaped' && (!win.everyone || !party(state).some(c => c.status === 'up'))) return 'escape';
    }
    if (!enemiesStanding(state)) return 'rout';
    return null;
}

function baseOutcome(state: CombatState): CombatOutcome | null {
    const all = party(state).filter(c => c.status !== 'gone');
    if (all.some(c => c.status === 'up')) return null;
    return all.some(c => c.status === 'fled') ? 'fled' : 'defeat';
}

function winText(by: ObjectiveEndReason): string {
    const texts: Partial<Record<ObjectiveEndReason, string>> = {
        rout: 'No enemy is left standing.',
        defeat_leader: 'The enemy leader is beaten.',
        survive: 'The party holds out to the end.',
        escape: 'The party gets out through the exit.',
        protect: 'The ward is kept safe to the end.',
        seize: 'The party holds the marked square.',
    };
    return `Objective met: ${texts[by] ?? 'the fight is won.'}`;
}

function loseText(by: ObjectiveEndReason): string {
    const texts: Partial<Record<ObjectiveEndReason, string>> = {
        pc_falls: 'the player character has fallen.',
        ward_falls: 'the ward has fallen.',
        round_limit: 'time has run out.',
        leader_escapes: 'the enemy leader has got away.',
        survive: 'the player character did not hold out.',
    };
    return `Objective failed: ${texts[by] ?? 'the fight is lost.'}`;
}

function breakRanks(draft: Draft, leaderId: string): void {
    const s = draft.state;
    const dc = MORALE_DC_LEADER_DOWN + OBJECTIVE_LIMITS.breakPenalty;
    for (const id of s.order) {
        const c = s.combatants[id];
        if (!c || c.id === leaderId || c.side !== 'enemy' || c.summonerId || c.status !== 'up') continue;
        const natural = draft.rng.roll(20);
        const total = natural + (TIER_TABLE[c.tier]?.save ?? 0);
        const success = total >= dc;
        emit(draft, {
            type: 'morale',
            actorId: c.id,
            targetId: c.id,
            data: { natural, total, dc, success, leaderDown: true, broken: true },
            text: success ? `${c.name} holds its nerve (${total} against DC ${dc}).` : `${c.name} breaks (${total} against DC ${dc}).`,
        });
        if (success) continue;
        emit(draft, {
            type: 'flee',
            actorId: c.id,
            targetId: c.id,
            data: { contested: false, success: true, broken: true },
            text: `${c.name} breaks away and leaves the fight.`,
        });
        leaveField(draft, c);
    }
}

function meet(draft: Draft, by: ObjectiveEndReason): void {
    const s = draft.state;
    const o = s.objective as CombatObjective;
    s.objective = { ...o, result: { status: 'won', by, round: s.round, outcome: 'victory' } };
    emit(draft, { type: 'objective_met', data: { part: 'win', kind: o.win.kind, by }, text: winText(by) });
    const leaderId = mainWin(o)?.kind === 'defeat_leader' ? leaderIdOf(o) : undefined;
    if (by === 'defeat_leader' && leaderId) breakRanks(draft, leaderId);
    endFight(draft, 'victory');
}

function fail(draft: Draft, by: ObjectiveEndReason): void {
    const s = draft.state;
    const o = s.objective as CombatObjective;
    s.objective = { ...o, result: { status: 'lost', by, round: s.round, outcome: 'defeat' } };
    emit(draft, { type: 'objective_failed', data: { part: 'lose', kind: by, by }, text: loseText(by) });
    endFight(draft, 'defeat');
}

export function settleObjective(draft: Draft): void {
    const s = draft.state;
    if (!s.objective || s.outcome) return;
    trackProgress(draft);
    const o = s.objective;
    const lost = immediateLoss(s, o);
    if (lost) {
        fail(draft, lost);
        return;
    }
    const won = immediateWin(s, o);
    if (won) {
        meet(draft, won);
        return;
    }
    const base = baseOutcome(s);
    if (base) endFight(draft, base);
}

function sideMet(state: CombatState, o: CombatObjective, status: ObjectiveResult['status']): boolean {
    const side = o.side;
    if (!side) return false;
    if (side.kind === 'within_rounds') return status === 'won' && state.round <= side.rounds;
    if (side.kind === 'no_one_falls') return !o.progress?.someoneFell && !party(state).some(c => c.status === 'down');
    if (side.kind === 'save_bystander') return state.combatants[side.bystanderId]?.status === 'up';
    return !!o.progress?.reachedBy;
}

function endReason(outcome: CombatOutcome, data: Record<string, unknown>): ObjectiveEndReason {
    if (typeof data.parley === 'string') return 'parley';
    if (data.conceded === true) return 'conceded';
    if (data.abandoned === true) return 'abandoned';
    if (outcome === 'fled') return 'fled';
    if (outcome === 'victory') return 'rout';
    return 'defeat';
}

export function finalizeObjective(draft: Draft, outcome: CombatOutcome, data: Record<string, unknown>): ObjectiveSummary {
    const s = draft.state;
    const o = s.objective as CombatObjective;
    let result: ObjectiveResult = o.result ?? {
        status: outcome === 'victory' ? 'won' : outcome === 'defeat' ? 'lost' : 'ended',
        by: endReason(outcome, data),
        round: s.round,
        outcome,
        ...(typeof data.parley === 'string' ? { parleyIntent: data.parley as ObjectiveResult['parleyIntent'] } : {}),
    };
    if (o.side) {
        const met = sideMet(s, o, result.status);
        result = { ...result, side: { kind: o.side.kind, met } };
        emit(draft, {
            type: met ? 'objective_met' : 'objective_failed',
            data: { part: 'side', kind: o.side.kind },
            text: `Side objective ${met ? 'met' : 'missed'}: ${o.side.kind.replace(/_/g, ' ')}.`,
        });
    }
    s.objective = { ...o, result };
    return { status: result.status, by: result.by, ...(result.side ? { side: result.side } : {}) };
}

function leave(draft: Draft, c: Combatant, how: 'exit' | 'leader_exit'): void {
    const at = { ...(c.position as Pos) };
    emit(draft, {
        type: 'objective_progress',
        actorId: c.id,
        targetId: c.id,
        data: { kind: 'escaped', unitId: c.id, at, side: c.side, how },
        text: `${c.name} gets out through the exit.`,
    });
    leaveField(draft, c);
    c.status = 'escaped';
    delete c.position;
    const o = draft.state.objective as CombatObjective;
    setProgress(draft, { escaped: [...(o.progress?.escaped ?? []), c.id] });
}

function trigger(draft: Draft, wave: ReinforcementWave): ReinforcementWave {
    const s = draft.state;
    const arriveRound = s.round + OBJECTIVE_LIMITS.triggeredDelay;
    const tiles = arrivalTiles(s, wave, wave.units.length);
    const next = { ...wave, arriveRound, tiles };
    warn(draft, next, false);
    return next;
}

function triggered(state: CombatState, wave: ReinforcementWave): boolean {
    if (wave.done || typeof wave.arriveRound === 'number') return false;
    const t = wave.trigger;
    if (t.kind === 'leader_half') {
        const leader = state.combatants[t.leaderId];
        return !!leader && (leader.status !== 'up' || leader.hp * 2 <= leader.maxHp);
    }
    if (t.kind === 'tile') return party(state).some(c => c.status === 'up' && onTiles(t.tiles, c.position));
    return false;
}

export function objectiveTurnEnd(draft: Draft, actorId: string): void {
    const s = draft.state;
    const o = s.objective;
    const c = s.combatants[actorId];
    if (o && c && c.status === 'up' && c.position) {
        const exits = exitsOf(o);
        const win = mainWin(o);
        const mayLeave = win?.kind === 'escape' && isPartySide(c.side) && !c.summonerId;
        if (mayLeave && onTiles(exits, c.position)) leave(draft, c, 'exit');
        else if (c.id === leaderIdOf(o) && hasLose(o, 'leader_escapes') && onTiles(leaderExitsOf(o), c.position)) leave(draft, c, 'leader_exit');
        else {
            const seize = seizeTileOf(o);
            if (seize && isPartySide(c.side) && !c.summonerId && onTiles([seize], c.position) && o.progress?.holderId !== c.id) {
                setProgress(draft, { holderId: c.id });
                emit(draft, { type: 'objective_progress', actorId: c.id, targetId: c.id, data: { kind: 'holding', unitId: c.id, at: { ...seize } }, text: `${c.name} takes the marked square.` });
            }
            const reach = reachTileOf(o);
            if (reach && isPartySide(c.side) && !c.summonerId && !o.progress?.reachedBy && onTiles([reach], c.position)) {
                setProgress(draft, { reachedBy: c.id });
                emit(draft, { type: 'objective_progress', actorId: c.id, targetId: c.id, data: { kind: 'reached', unitId: c.id, at: { ...reach } }, text: `${c.name} reaches the marked spot.` });
            }
        }
    }
    const book = s.reinforcements;
    if (book && !s.outcome && book.waves.some(w => triggered(s, w))) {
        s.reinforcements = { ...book, waves: book.waves.map(w => (triggered(s, w) ? trigger(draft, w) : w)) };
    }
}

export function objectiveTurnBegins(draft: Draft, actorId: string): void {
    const s = draft.state;
    const o = s.objective;
    if (!o || s.outcome || o.progress?.holderId !== actorId) return;
    const c = s.combatants[actorId];
    const seize = seizeTileOf(o);
    if (c?.status === 'up' && seize && onTiles([seize], c.position) && wardUp(s, o) && !immediateLoss(s, o)) meet(draft, 'seize');
}

export function objectiveRoundEnd(draft: Draft): void {
    const s = draft.state;
    const o = s.objective;
    if (!o || s.outcome) return;
    const win = mainWin(o);
    if (win?.kind === 'survive' && s.round >= win.rounds) {
        if (wardUp(s, o) && playerCharacterOf(s)?.status === 'up') meet(draft, 'survive');
        else fail(draft, 'survive');
        return;
    }
    if (o.win.kind === 'protect' && !o.win.with && typeof o.win.rounds === 'number' && s.round >= o.win.rounds) {
        if (wardUp(s, o)) meet(draft, 'protect');
        else fail(draft, 'ward_falls');
        return;
    }
    if (typeof o.roundLimit === 'number' && hasLose(o, 'round_limit') && s.round >= o.roundLimit) fail(draft, 'round_limit');
}

function edgeOk(grid: NonNullable<CombatState['grid']>, p: Pos, edge: ReinforcementWave['edge']): boolean {
    if (edge === 'far') return p.x === grid.width - 1;
    if (edge === 'near') return p.x === 0;
    return p.y === 0 || p.y === grid.height - 1;
}

export function arrivalTiles(state: CombatState, wave: Pick<ReinforcementWave, 'edge'>, count: number): Pos[] {
    const grid = terrainOf(state);
    if (!grid || count <= 0) return [];
    const taken = new Set<number>();
    for (const c of Object.values(state.combatants)) if (c.status === 'up' && c.position) taken.add(c.position.y * grid.width + c.position.x);
    const partyAt = party(state).filter(c => c.status === 'up' && c.position).map(c => c.position as Pos);
    const gapOf = (p: Pos) => (partyAt.length > 0 ? Math.min(...partyAt.map(q => distance(p, q))) : Infinity);
    const pick = (onEdge: (p: Pos) => boolean) => {
        const out: Array<{ p: Pos; gap: number }> = [];
        for (let y = 0; y < grid.height; y++) {
            for (let x = 0; x < grid.width; x++) {
                const p = { x, y };
                const border = x === 0 || y === 0 || x === grid.width - 1 || y === grid.height - 1;
                if (!border || !onEdge(p) || !isWalkable(grid, p) || tileAt(grid, p) === 'hazard' || taken.has(y * grid.width + x)) continue;
                const gap = gapOf(p);
                if (gap < OBJECTIVE_LIMITS.arrivalGap) continue;
                out.push({ p, gap });
            }
        }
        out.sort((a, b) => (Math.min(b.gap, 8) - Math.min(a.gap, 8)) || (a.p.y - b.p.y) || (a.p.x - b.p.x));
        return out.map(o => o.p);
    };
    let tiles = pick(p => edgeOk(grid, p, wave.edge));
    if (tiles.length === 0) tiles = pick(() => true);
    if (tiles.length <= count) return tiles;
    const centre = tiles[0];
    return [...tiles].sort((a, b) => (distance(a, centre) - distance(b, centre)) || (a.y - b.y) || (a.x - b.x)).slice(0, count).sort((a, b) => (a.y - b.y) || (a.x - b.x));
}

function warn(draft: Draft, wave: ReinforcementWave, delayed: boolean): void {
    const tiles = (wave.tiles ?? []).map(p => ({ ...p }));
    emit(draft, {
        type: 'reinforcements_warning',
        data: {
            waveId: wave.id, round: wave.arriveRound, tiles, count: wave.units.length, edge: wave.edge,
            trigger: wave.trigger.kind, ...(delayed ? { delayed: true } : {}),
        },
        text: delayed
            ? `The reinforcements are held up; they will arrive in round ${wave.arriveRound}.`
            : `Reinforcements are coming: ${wave.units.length} will arrive in round ${wave.arriveRound}.`,
    });
}

function insertByInitiative(state: CombatState, c: Combatant): void {
    let at = state.order.length;
    for (let i = 0; i < state.order.length; i++) {
        const other = state.combatants[state.order[i]];
        if (other && other.initiative < c.initiative) {
            at = i;
            break;
        }
    }
    state.order.splice(at, 0, c.id);
    if (at < state.turnIndex) state.turnIndex += 1;
}

function arrive(draft: Draft, wave: ReinforcementWave): ReinforcementWave {
    const s = draft.state;
    const grid = terrainOf(s);
    let tiles = wave.tiles ?? [];
    const free = (p: Pos) => !!grid && inBounds(grid, p) && isWalkable(grid, p)
        && !Object.values(s.combatants).some(c => c.status === 'up' && c.position?.x === p.x && c.position?.y === p.y)
        && !party(s).some(c => c.status === 'up' && c.position && distance(c.position, p) < OBJECTIVE_LIMITS.arrivalGap);
    if (tiles.length < wave.units.length || !tiles.every(free)) tiles = arrivalTiles(s, wave, wave.units.length);
    const placed: Array<{ id: string; name: string; tier: string; side: string; at: Pos }> = [];
    const left: Combatant[] = [];
    wave.units.forEach((unit, i) => {
        const at = tiles[i];
        if (!at) {
            left.push(unit);
            return;
        }
        let id = unit.id;
        while (s.combatants[id]) id = `${id}_`;
        const c: Combatant = { ...unit, id, status: 'up', conditions: [], position: { ...at }, startHp: unit.hp };
        s.combatants[id] = c;
        insertByInitiative(s, c);
        placed.push({ id, name: c.name, tier: c.tier, side: c.side, at: { ...at } });
        if (s.morale) s.morale = { ...s.morale, startHp: { ...s.morale.startHp, enemy: s.morale.startHp.enemy + c.hp } };
    });
    if (placed.length > 0) {
        emit(draft, {
            type: 'reinforcements_arrive',
            data: { waveId: wave.id, units: placed, waiting: left.length },
            text: `Reinforcements arrive: ${placed.map(p => p.name).join(', ')}.`,
        });
    }
    if (left.length === 0) return { ...wave, units: [], arrived: [...(wave.arrived ?? []), ...placed.map(p => p.id)], done: true };
    const next: ReinforcementWave = {
        ...wave, units: left, arriveRound: s.round + 1, arrived: [...(wave.arrived ?? []), ...placed.map(p => p.id)],
    };
    next.tiles = arrivalTiles(s, next, left.length);
    warn(draft, next, true);
    return next;
}

export function objectiveRoundStart(draft: Draft): void {
    const s = draft.state;
    if (s.outcome) return;
    const book = s.reinforcements;
    if (book) {
        const waves = book.waves.map(w => {
            if (w.done) return w;
            if (w.arriveRound === s.round) return arrive(draft, w);
            if (w.arriveRound === undefined && w.trigger.kind === 'round' && w.trigger.round === s.round + 1) {
                const next = { ...w, arriveRound: w.trigger.round, tiles: arrivalTiles(s, w, w.units.length) };
                warn(draft, next, false);
                return next;
            }
            if (w.arriveRound === undefined && w.trigger.kind === 'round' && w.trigger.round <= s.round) return arrive(draft, { ...w, arriveRound: s.round });
            return w;
        });
        s.reinforcements = { ...book, waves };
    }
    const clock = objectiveClock(s);
    if (clock) {
        emit(draft, {
            type: 'objective_progress',
            data: { kind: 'rounds_left', clock: clock.kind, left: clock.left, round: clock.round },
            text: clock.left === 1 ? 'This is the last round.' : `${clock.left} rounds left.`,
        });
    }
}

export function undoObjectiveEvent(combatants: Record<string, Combatant>, event: CombatEvent): boolean {
    if (event.type === 'reinforcements_arrive') {
        const units = Array.isArray(event.data.units) ? event.data.units as Array<{ id?: unknown }> : [];
        for (const u of units) {
            const c = typeof u?.id === 'string' ? combatants[u.id] : undefined;
            if (!c) continue;
            c.status = 'gone';
            delete c.position;
        }
        return true;
    }
    if (event.type === 'objective_progress' && event.data.kind === 'escaped') {
        const c = event.targetId ? combatants[event.targetId] : undefined;
        const at = event.data.at as Pos | undefined;
        if (c) {
            c.status = 'up';
            if (at && typeof at.x === 'number' && typeof at.y === 'number') c.position = { x: at.x, y: at.y };
        }
        return true;
    }
    return OBJECTIVE_EVENT_TYPES.includes(event.type);
}
