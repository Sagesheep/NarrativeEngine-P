import { abilityMod, TIER_LEVEL } from './abilities';
import { distance, inBounds, isWalkable, terrainOf } from './grid';
import { TIER_TABLE } from './tiers';
import { dismissSummon, emit, endFight, isHostile, isPlayerSide, playerCharacterOf } from './core';
import type { Draft } from './core';
import { proficiencyOf } from './glyphs/numbers';
import type {
    CombatState, Combatant, Grid, MoraleBook, ParleyEffect, ParleyIntent, ParleyRating, ParleyRecord, Pos, Team, TurnState,
} from './types';

export const MORALE_DC = 10;
export const MORALE_DC_LEADER_DOWN = 15;
export const PARLEY_DC: Readonly<Record<Exclude<ParleyRating, 'hopeless'>, number>> = { easy: 8, even: 13, hard: 18 };
export const PARLEY_LOSING_SHIFT = 3;
export const PARLEY_FAILURE_STEP = 2;
export const PARLEY_INTENTS: readonly ParleyIntent[] = ['ceasefire', 'let_go', 'surrender_demand', 'bargain', 'taunt', 'other'];
export const PARLEY_RATINGS: readonly ParleyRating[] = ['hopeless', 'hard', 'even', 'easy'];
export const MECHANICAL_INTENTS: ReadonlySet<ParleyIntent> = new Set<ParleyIntent>(['ceasefire', 'let_go', 'surrender_demand', 'bargain']);

const MORALE_TIERS: ReadonlySet<Combatant['tier']> = new Set<Combatant['tier']>(['minion', 'grunt']);

export type FleeReason = 'no_grid' | 'not_your_turn' | 'action_used' | 'first_round' | 'not_on_edge' | 'started_off_edge';

export type FleeCheck = { ok: boolean; reason?: FleeReason; contested: boolean };

export type ParleyReason = 'not_your_turn' | 'not_player_character' | 'action_used' | 'no_enemy';

export function teamOfSide(side: Combatant['side']): Team | null {
    if (isPlayerSide(side)) return 'party';
    if (side === 'enemy') return 'enemy';
    return null;
}

export function isEdgeTile(grid: Grid, p: Pos): boolean {
    if (!inBounds(grid, p) || !isWalkable(grid, p)) return false;
    return p.x === 0 || p.y === 0 || p.x === grid.width - 1 || p.y === grid.height - 1;
}

export function edgeTiles(state: Pick<CombatState, 'grid' | 'barriers'>): Pos[] {
    const grid = terrainOf(state);
    if (!grid) return [];
    const out: Pos[] = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            if (isEdgeTile(grid, { x, y })) out.push({ x, y });
        }
    }
    return out;
}

function members(state: CombatState, team: Team): Combatant[] {
    return Object.values(state.combatants).filter(c => !c.summonerId && teamOfSide(c.side) === team);
}

export function buildMoraleBook(state: CombatState): MoraleBook {
    const startHp: Record<Team, number> = { party: 0, enemy: 0 };
    const leaders: Partial<Record<Team, string>> = {};
    for (const team of ['party', 'enemy'] as const) {
        let best: Combatant | null = null;
        let lowest = Infinity;
        for (const id of state.order) {
            const c = state.combatants[id];
            if (!c || c.summonerId || teamOfSide(c.side) !== team) continue;
            startHp[team] += c.startHp ?? c.hp;
            const level = TIER_LEVEL[c.tier] ?? 0;
            lowest = Math.min(lowest, level);
            if (!best || level > (TIER_LEVEL[best.tier] ?? 0)) best = c;
        }
        if (best && (TIER_LEVEL[best.tier] ?? 0) > lowest) leaders[team] = best.id;
    }
    return { startHp, leaders };
}

export function teamLoss(state: CombatState, team: Team): { lost: number; start: number } {
    const start = state.morale?.startHp[team] ?? 0;
    let lost = 0;
    for (const c of members(state, team)) {
        const begin = c.startHp ?? c.maxHp;
        if (c.status === 'fled' || c.status === 'surrendered') lost += begin;
        else lost += Math.max(0, begin - Math.max(0, c.hp));
    }
    return { lost, start };
}

export function lostHalf(state: CombatState, team: Team): boolean {
    const { lost, start } = teamLoss(state, team);
    return start > 0 && lost * 2 >= start;
}

export function isLeaderDown(state: CombatState, team: Team): boolean {
    const id = state.morale?.leaders[team];
    const leader = id ? state.combatants[id] : undefined;
    return !!leader && leader.status !== 'up';
}

export function isOutnumbered(state: CombatState, team: Team): boolean {
    const other: Team = team === 'party' ? 'enemy' : 'party';
    const up = (t: Team) => members(state, t).filter(c => c.status === 'up').length;
    return up(team) < up(other);
}

export function rollMoraleIfDue(draft: Draft, actor: Combatant): void {
    const s = draft.state;
    if (actor.side !== 'enemy' || actor.summonerId || actor.moraleRolled || actor.routed || actor.status !== 'up') return;
    if (!MORALE_TIERS.has(actor.tier) || !s.morale) return;
    if (!lostHalf(s, 'enemy')) return;
    const leaderDown = isLeaderDown(s, 'enemy');
    if (!leaderDown && !isOutnumbered(s, 'enemy')) return;
    actor.moraleRolled = true;
    const dc = leaderDown ? MORALE_DC_LEADER_DOWN : MORALE_DC;
    const bonus = TIER_TABLE[actor.tier]?.save ?? 0;
    const natural = draft.rng.roll(20);
    const total = natural + bonus;
    const success = total >= dc;
    if (!success) actor.routed = true;
    emit(draft, {
        type: 'morale',
        actorId: actor.id,
        targetId: actor.id,
        data: { natural, total, dc, success, leaderDown },
        text: success
            ? `${actor.name} holds its nerve (${total} against DC ${dc}).`
            : `${actor.name} breaks and routs (${total} against DC ${dc}).`,
    });
}

export function startedOnEdge(state: CombatState, actor: Combatant): boolean {
    const grid = terrainOf(state);
    const start = state.turnStart;
    if (!grid || !start || start.actorId !== actor.id) return false;
    return isEdgeTile(grid, start.pos);
}

function adjacentHostiles(state: CombatState, actor: Combatant): Combatant[] {
    if (!actor.position) return [];
    return state.order
        .map(id => state.combatants[id])
        .filter((o): o is Combatant => !!o && o.id !== actor.id && o.status === 'up' && !!o.position
            && isHostile(actor.side, o.side) && distance(o.position, actor.position as Pos) <= 1);
}

export function checkFlee(state: CombatState, actorId: string, turn: TurnState | null): FleeCheck {
    const actor = state.combatants[actorId];
    const grid = terrainOf(state);
    if (!grid || !actor?.position) return { ok: false, reason: 'no_grid', contested: false };
    if (!turn || turn.actorId !== actorId || actor.status !== 'up' || state.outcome) return { ok: false, reason: 'not_your_turn', contested: false };
    const contested = adjacentHostiles(state, actor).length > 0;
    if (turn.actionUsed) return { ok: false, reason: 'action_used', contested };
    if (state.round <= 1) return { ok: false, reason: 'first_round', contested };
    if (!isEdgeTile(grid, actor.position)) return { ok: false, reason: 'not_on_edge', contested };
    if (!startedOnEdge(state, actor)) return { ok: false, reason: 'started_off_edge', contested };
    return { ok: true, contested };
}

export function leaveField(draft: Draft, actor: Combatant): void {
    actor.status = 'fled';
    actor.conditions = [];
    delete actor.tempHp;
    for (const id of draft.state.order) {
        const c = draft.state.combatants[id];
        if (c && c.summonerId === actor.id && c.status === 'up') dismissSummon(draft, c, 'summoner_left');
    }
}

export function attemptFlee(draft: Draft, actor: Combatant): boolean {
    const hostiles = adjacentHostiles(draft.state, actor);
    let success = true;
    let data: Record<string, unknown> = { contested: false, success: true };
    let text = `${actor.name} breaks away and leaves the fight.`;
    if (hostiles.length > 0) {
        const best = hostiles.reduce((a, b) => (abilityMod(b.abilities.DEX) > abilityMod(a.abilities.DEX) ? b : a));
        const natural = draft.rng.roll(20);
        const total = natural + abilityMod(actor.abilities.DEX);
        const against = draft.rng.roll(20);
        const againstTotal = against + abilityMod(best.abilities.DEX);
        success = total >= againstTotal;
        data = { contested: true, success, natural, total, against, againstTotal, blockerId: best.id };
        text = success
            ? `${actor.name} slips past ${best.name} and leaves the fight (${total} against ${againstTotal}).`
            : `${actor.name} tries to flee but ${best.name} cuts them off (${total} against ${againstTotal}).`;
    }
    emit(draft, {
        type: 'flee',
        actorId: actor.id,
        targetId: actor.id,
        data,
        text,
    });
    if (success) leaveField(draft, actor);
    return success;
}

export function isRetreating(state: CombatState, actor: Combatant): boolean {
    if (actor.status !== 'up' || actor.summonerId || actor.controller === 'player') return false;
    if (actor.routed) return true;
    if (actor.side !== 'ally') return false;
    return playerCharacterOf(state)?.status === 'fled';
}

export function canAbandon(state: CombatState, actorId: string): boolean {
    const actor = state.combatants[actorId];
    if (!actor || state.outcome || actor.status !== 'up' || actor.controller !== 'player' || !isPlayerSide(actor.side)) return false;
    return playerCharacterOf(state)?.status === 'fled';
}

export function abandonFight(draft: Draft): void {
    draft.state.ending = { ...(draft.state.ending ?? {}), abandoned: true };
    endFight(draft, 'fled', { abandoned: true });
}

export function checkParley(state: CombatState, actorId: string, turn: TurnState | null): { ok: boolean; reason?: ParleyReason } {
    const actor = state.combatants[actorId];
    if (!actor || !turn || turn.actorId !== actorId || actor.status !== 'up' || state.outcome) return { ok: false, reason: 'not_your_turn' };
    if (actor.side !== 'player') return { ok: false, reason: 'not_player_character' };
    if (turn.actionUsed) return { ok: false, reason: 'action_used' };
    if (!Object.values(state.combatants).some(c => c.side === 'enemy' && c.status === 'up')) return { ok: false, reason: 'no_enemy' };
    return { ok: true };
}

export function resolveSpeaker(state: CombatState, requested?: string | null): Combatant | undefined {
    const upEnemies = state.order.map(id => state.combatants[id]).filter((c): c is Combatant => !!c && c.side === 'enemy' && c.status === 'up');
    if (requested) {
        const want = requested.trim().toLowerCase();
        const hit = upEnemies.find(c => c.id === requested || c.name.trim().toLowerCase() === want);
        if (hit) return hit;
    }
    const leaderId = state.morale?.leaders.enemy;
    const leader = leaderId ? upEnemies.find(c => c.id === leaderId) : undefined;
    return leader ?? upEnemies[0];
}

export function onlySummonedEnemies(state: CombatState): boolean {
    const up = Object.values(state.combatants).filter(c => c.side === 'enemy' && c.status === 'up');
    return up.length > 0 && up.every(c => !!c.summonerId);
}

export function earlierParleyFailures(state: CombatState): number {
    return (state.parleys ?? []).filter(p => MECHANICAL_INTENTS.has(p.intent) && !p.success).length;
}

export function parleyDc(state: CombatState, rating: ParleyRating): number | null {
    if (rating === 'hopeless') return null;
    let dc = PARLEY_DC[rating];
    if (lostHalf(state, 'enemy')) dc -= PARLEY_LOSING_SHIFT;
    if (lostHalf(state, 'party')) dc += PARLEY_LOSING_SHIFT;
    return dc + PARLEY_FAILURE_STEP * earlierParleyFailures(state);
}

function surrenderAll(draft: Draft): void {
    const s = draft.state;
    for (const id of s.order) {
        const c = s.combatants[id];
        if (!c || c.side !== 'enemy' || c.status !== 'up') continue;
        if (c.summonerId) {
            dismissSummon(draft, c, 'summoner_left');
            continue;
        }
        c.status = 'surrendered';
        c.conditions = [];
        delete c.tempHp;
        emit(draft, { type: 'surrendered', targetId: c.id, data: {}, text: `${c.name} yields.` });
    }
}

export function resolveParley(
    draft: Draft,
    actor: Combatant,
    input: { intent: ParleyIntent; rating: ParleyRating; speakerId?: string; attemptId?: string },
): ParleyRecord {
    const s = draft.state;
    const speaker = resolveSpeaker(s, input.speakerId);
    const mechanical = MECHANICAL_INTENTS.has(input.intent);
    const base = {
        ...(input.attemptId ? { attemptId: input.attemptId } : {}),
        round: s.round,
        turn: s.turnCount ?? 0,
        actorId: actor.id,
        ...(speaker ? { speakerId: speaker.id } : {}),
        intent: input.intent,
        rating: input.rating,
    };
    let record: ParleyRecord;
    if (!mechanical) {
        record = { ...base, success: false, effect: 'none' };
    } else {
        const dc = parleyDc(s, input.rating);
        if (dc === null) {
            record = { ...base, success: false, effect: 'failed' };
        } else {
            const natural = draft.rng.roll(20);
            const total = natural + abilityMod(actor.abilities.CHA ?? 10) + proficiencyOf(actor);
            const success = total >= dc;
            let effect: ParleyEffect = 'failed';
            if (success) effect = input.intent === 'let_go' ? 'let_go' : input.intent === 'surrender_demand' ? 'surrender' : 'truce';
            record = { ...base, dc, natural, total, success, effect };
        }
    }
    s.parleys = [...(s.parleys ?? []), record];
    const rollText = record.dc !== undefined ? ` ${record.total} against DC ${record.dc}` : '';
    const verdict = record.effect === 'none' ? 'no effect' : record.success ? 'succeeds' : 'fails';
    emit(draft, {
        type: 'parley',
        actorId: actor.id,
        ...(speaker ? { targetId: speaker.id } : {}),
        data: { ...record },
        text: `${actor.name} parleys (${input.intent.replace('_', ' ')}, rated ${input.rating}):${rollText ? `${rollText},` : ''} ${verdict}.`,
    });
    if (record.effect === 'truce') {
        s.ending = { ...(s.ending ?? {}), parleyIntent: input.intent };
        endFight(draft, 'truce', { parley: input.intent });
    } else if (record.effect === 'let_go') {
        s.ending = { ...(s.ending ?? {}), parleyIntent: input.intent, carried: true };
        endFight(draft, 'fled', { parley: input.intent });
    } else if (record.effect === 'surrender') {
        s.ending = { ...(s.ending ?? {}), parleyIntent: input.intent };
        surrenderAll(draft);
        endFight(draft, 'victory', { parley: input.intent });
    }
    return record;
}

export function concedeFight(draft: Draft): void {
    draft.state.ending = { ...(draft.state.ending ?? {}), conceded: true };
    endFight(draft, 'defeat', { conceded: true });
}
