import { leaderIdOf, objectiveClock, objectiveMarks, wardIdOf } from '@narrative/engine';
import type { CombatObjective, CombatSession, CombatState, Combatant, LoseKind, ObjectiveResult, SideKind } from '../../types';

type Win = CombatObjective['win'];

function nameOf(state: CombatState, id: string | undefined, fallback: string): string {
    return (id && state.combatants[id]?.name) || fallback;
}

export function hasObjectiveStakes(o: CombatObjective | undefined): o is CombatObjective {
    if (!o) return false;
    return o.win.kind !== 'rout' || !!o.lose?.length || !!o.side || o.roundLimit !== undefined;
}

function winPhrase(state: CombatState, win: Win): string {
    switch (win.kind) {
        case 'rout':
            return 'beat every enemy';
        case 'defeat_leader':
            return `bring down ${nameOf(state, win.leaderId, 'the enemy leader')}, whose fall breaks the rest`;
        case 'survive':
            return `hold out for ${win.rounds} rounds`;
        case 'escape':
            return win.everyone ? 'get every one of the party out through the exit' : 'get the player character out through the exit';
        case 'seize':
            return 'take and hold the marked ground';
        case 'protect': {
            const ward = nameOf(state, win.wardId, 'the ward');
            if (win.with) return `${winPhrase(state, win.with)} while ${ward} stays alive`;
            return `keep ${ward} alive for ${win.rounds ?? 0} rounds`;
        }
    }
}

function losePhrase(state: CombatState, o: CombatObjective, kind: LoseKind): string {
    switch (kind) {
        case 'pc_falls':
            return 'the player character falls';
        case 'ward_falls':
            return `${nameOf(state, wardIdOf(o), 'the ward')} falls`;
        case 'round_limit':
            return 'time runs out';
        case 'leader_escapes':
            return `${nameOf(state, leaderIdOf(o), 'the enemy leader')} gets away`;
    }
}

function sidePhrase(state: CombatState, o: CombatObjective): string {
    const side = o.side;
    if (!side) return '';
    switch (side.kind) {
        case 'within_rounds':
            return `win within ${side.rounds} rounds`;
        case 'no_one_falls':
            return 'no one in the party falls';
        case 'save_bystander':
            return `${nameOf(state, side.bystanderId, 'the bystander')} comes through alive`;
        case 'reach_tile':
            return 'reach the marked spot';
    }
}

export function objectiveStakes(state: CombatState): string | null {
    const o = state.objective;
    if (!hasObjectiveStakes(o)) return null;
    const parts = [`the party's aim is to ${winPhrase(state, o.win)}`];
    const lose = (o.lose ?? []).map(l => losePhrase(state, o, l.kind));
    if (lose.length > 0) parts.push(`the fight is lost if ${lose.join(' or ')}`);
    const side = sidePhrase(state, o);
    if (side) parts.push(`a smaller aim is that ${side}`);
    const clock = objectiveClock(state);
    if (clock && clock.left <= 1) parts.push('this is the last round');
    else if (clock && clock.left === 2) parts.push('time is nearly gone');
    if (objectiveMarks(state).incoming.length > 0) parts.push('more enemies are about to arrive');
    return `Stakes: ${parts.join('; ')}. Let the prose carry these stakes (time pressing, who is in danger, what is within reach) without stating numbers or deciding the result; the listed events decide it.`;
}

const WON_BY: Readonly<Record<string, string>> = {
    rout: 'by beating every enemy',
    defeat_leader: 'by bringing down the enemy leader',
    survive: 'by holding out to the end',
    escape: 'by getting out through the exit',
    protect: 'by keeping the ward safe',
    seize: 'by holding the marked ground',
    parley: 'through the enemy\'s surrender',
};

const LOST_BY: Readonly<Record<string, string>> = {
    pc_falls: 'the player character fell',
    ward_falls: 'the ward fell',
    round_limit: 'time ran out',
    leader_escapes: 'the enemy leader got away',
    survive: 'the player character did not hold out',
    defeat: 'the party was beaten',
    conceded: 'the player conceded',
};

const ENDED_BY: Readonly<Record<string, string>> = {
    parley: 'the sides stopped fighting after words',
    fled: 'the party left the field',
    abandoned: 'the player abandoned the others',
    conceded: 'the player conceded',
};

const SIDE_NAME: Readonly<Record<SideKind, string>> = {
    within_rounds: 'win quickly',
    no_one_falls: 'no one in the party falls',
    save_bystander: 'save the bystander',
    reach_tile: 'reach the marked spot',
};

function resultPhrase(result: ObjectiveResult): string {
    if (result.status === 'won') return `achieved ${WON_BY[result.by] ?? 'in the end'}`;
    if (result.status === 'lost') return `lost: ${LOST_BY[result.by] ?? 'the fight was lost'}`;
    return `not decided: ${ENDED_BY[result.by] ?? 'the fight was broken off'}`;
}

export function objectiveResultClause(state: CombatState): string {
    const o = state.objective;
    if (!hasObjectiveStakes(o) || !o.result) return '';
    const side = o.result.side ? ` Side aim (${SIDE_NAME[o.result.side.kind]}): ${o.result.side.met ? 'met' : 'missed'}.` : '';
    return `Objective ${resultPhrase(o.result)}.${side}`;
}

function arrivals(session: CombatSession): string[] {
    const names: string[] = [];
    for (const e of session.log) {
        if (e.type !== 'reinforcements_arrive' || !Array.isArray(e.data.units)) continue;
        for (const u of e.data.units as Array<{ name?: unknown }>) if (typeof u?.name === 'string') names.push(u.name);
    }
    return names;
}

function joined(list: readonly Combatant[]): string {
    return list.map(c => c.name).join(', ');
}

export function objectiveOutcomeLines(session: CombatSession, all: readonly Combatant[]): string[] {
    const state = session.state;
    const o = state.objective;
    if (!hasObjectiveStakes(o)) return [];
    const lines: string[] = [];
    const aim = winPhrase(state, o.win);
    const lose = (o.lose ?? []).map(l => losePhrase(state, o, l.kind));
    lines.push(`The fight's objective was to ${aim}${lose.length > 0 ? `; it was lost if ${lose.join(' or ')}` : ''}.`);
    const result = objectiveResultClause(state);
    if (result) lines.push(result);
    const out = all.filter(c => c.status === 'escaped');
    const partyOut = out.filter(c => c.side === 'player' || c.side === 'ally');
    const enemyOut = out.filter(c => c.side === 'enemy');
    if (partyOut.length > 0) lines.push(`Got out through the exit: ${joined(partyOut)}. They are safe and alive.`);
    if (enemyOut.length > 0) lines.push(`${joined(enemyOut)} escaped through the exit and is still at large.`);
    const came = arrivals(session);
    if (came.length > 0) lines.push(`Reinforcements arrived during the fight: ${came.join(', ')}.`);
    return lines;
}

export function objectiveLossLine(state: CombatState, party: readonly Combatant[]): string | null {
    const o = state.objective;
    const result = o?.result;
    if (!o || !result || state.outcome !== 'defeat') return null;
    const standing = party.filter(c => c.status === 'up' || c.status === 'escaped');
    if (standing.length === 0) return null;
    const reason = LOST_BY[result.by];
    if (!reason) return null;
    return `The fight was lost although the party is not beaten: ${reason}. Those still standing: ${joined(standing)}. Nobody is unconscious unless stated above; what the failure costs is your decision as the story AI.`;
}
