import { coverBetween, distance, hasLineOfSight, hpBand } from '@narrative/engine';
import type { CombatEvent, CombatSide, CombatState, Combatant } from '../../types';

export const ACTION_EVENT_TYPES: ReadonlySet<string> = new Set(['attack', 'defend', 'end_turn']);
export const TURN_ACTION_TYPES: ReadonlySet<string> = new Set(['moved', 'attack', 'defend', 'end_turn']);

export type TurnGroup = {
    actorId?: string;
    turn?: number;
    events: CombatEvent[];
};

function actorOf(events: readonly CombatEvent[]): string | undefined {
    return events.find(e => TURN_ACTION_TYPES.has(e.type) && e.actorId)?.actorId;
}

export function groupEventsByTurn(events: readonly CombatEvent[]): TurnGroup[] {
    const groups: TurnGroup[] = [];
    let lead: CombatEvent[] = [];
    for (const event of events) {
        if (event.type === 'rejected') continue;
        if (typeof event.turn === 'number') {
            if (lead.length > 0) {
                groups.push({ events: lead });
                lead = [];
            }
            const last = groups[groups.length - 1];
            if (last && last.turn === event.turn) last.events.push(event);
            else groups.push({ turn: event.turn, events: [event] });
            continue;
        }
        if (ACTION_EVENT_TYPES.has(event.type)) {
            groups.push({ events: [...lead, event] });
            lead = [];
            continue;
        }
        if (groups.length === 0) lead.push(event);
        else groups[groups.length - 1].events.push(event);
    }
    if (lead.length > 0) groups.push({ events: lead });
    for (const group of groups) {
        const actorId = actorOf(group.events);
        if (actorId) group.actorId = actorId;
    }
    return groups;
}

export function isGroupComplete(group: TurnGroup, state: CombatState): boolean {
    if (group.turn === undefined || state.outcome !== null) return true;
    return group.turn < (state.turnCount ?? 0);
}

export function sideGroup(side: CombatSide | undefined): 'party' | 'enemy' | 'neutral' | 'none' {
    if (side === 'player' || side === 'ally') return 'party';
    if (side === 'enemy') return 'enemy';
    if (side === 'neutral') return 'neutral';
    return 'none';
}

export function stateAtSeq(state: CombatState, log: readonly CombatEvent[], seq: number): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) {
        combatants[id] = { ...c, ...(c.position ? { position: { ...c.position } } : {}) };
    }
    const later = log.filter(e => e.seq > seq).sort((a, b) => b.seq - a.seq);
    for (const event of later) {
        if (event.type === 'moved') {
            const actor = event.actorId ? combatants[event.actorId] : undefined;
            const from = event.data.from as { x: number; y: number } | undefined;
            if (actor && from && typeof from.x === 'number' && typeof from.y === 'number') actor.position = { x: from.x, y: from.y };
            continue;
        }
        const target = event.targetId ? combatants[event.targetId] : undefined;
        if (!target) continue;
        if (event.type === 'attack' && event.data.hit === true && typeof event.data.damage === 'number') {
            target.hp = Math.min(target.maxHp, target.hp + event.data.damage);
        }
        if (event.type === 'hazard' && typeof event.data.damage === 'number') {
            target.hp = Math.min(target.maxHp, target.hp + event.data.damage);
        }
        if (event.type === 'down') target.status = 'up';
    }
    return { ...state, combatants };
}

export type HpBandLabel = 'unhurt' | 'hurt' | 'badly hurt' | 'down';

export function hpBandLabel(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): HpBandLabel {
    const band = hpBand(c);
    return band === 'badly_hurt' ? 'badly hurt' : band;
}

export type PositionPhrase = 'adjacent' | 'close' | 'at range' | 'behind cover' | `behind the ${string}` | 'out of sight';

export function positionPhrase(state: CombatState, c: Combatant): PositionPhrase | null {
    const grid = state.grid;
    const pc = Object.values(state.combatants).find(x => x.side === 'player');
    if (!grid || !pc || pc.id === c.id || !pc.position || !c.position) return null;
    if (!hasLineOfSight(grid, pc.position, c.position)) return 'out of sight';
    if (coverBetween(grid, pc.position, c.position) > 0) {
        const label = grid.labels?.cover?.trim();
        return label ? `behind the ${label}` : 'behind cover';
    }
    const d = distance(pc.position, c.position);
    if (d <= 1) return 'adjacent';
    if (d <= 3) return 'close';
    return 'at range';
}

function nameIn(state: CombatState, id?: string): string {
    return (id && state.combatants[id]?.name) || 'Someone';
}

function moveClause(state: CombatState, actorId: string | undefined, squares: number, rel: { towardId?: unknown; awayFromId?: unknown }, numbers: boolean): string {
    const name = nameIn(state, actorId);
    const toward = typeof rel.towardId === 'string' ? rel.towardId : undefined;
    const away = typeof rel.awayFromId === 'string' ? rel.awayFromId : undefined;
    if (numbers) {
        const unit = squares === 1 ? 'square' : 'squares';
        if (toward) return `${name} moves ${squares} ${unit} toward ${nameIn(state, toward)}.`;
        if (away) return `${name} moves ${squares} ${unit} away from ${nameIn(state, away)}.`;
        return `${name} moves ${squares} ${unit}.`;
    }
    if (toward) return `${name} closes on ${nameIn(state, toward)}.`;
    if (away) return `${name} falls back from ${nameIn(state, away)}.`;
    return `${name} shifts position.`;
}

export function narrationLine(event: CombatEvent, state: CombatState): string {
    const name = (id?: string) => nameIn(state, id);
    switch (event.type) {
        case 'attack': {
            const type = typeof event.data.damageType === 'string' ? event.data.damageType : '';
            if (event.data.hit !== true) return `${name(event.actorId)} attacks ${name(event.targetId)} and misses.`;
            const how = event.data.crit === true ? 'lands a critical hit on' : 'hits';
            return `${name(event.actorId)} ${how} ${name(event.targetId)}${type ? ` (${type})` : ''}.`;
        }
        case 'initiative': {
            const order = state.order.map(id => name(id));
            return `Order of action: ${order.join(', ')}.`;
        }
        case 'round':
            return 'A new round begins.';
        case 'moved':
            return moveClause(state, event.actorId, Number(event.data.squares) || 0, event.data, false);
        case 'hazard': {
            const label = state.grid?.labels?.hazard?.trim();
            const type = label || (typeof event.data.damageType === 'string' ? event.data.damageType : 'hazard');
            return `${name(event.targetId)} is hurt by the ${type} underfoot.`;
        }
        default:
            return event.text;
    }
}

export function turnLines(group: TurnGroup, state: CombatState, opts: { numbers: boolean }): string[] {
    const events = group.events.filter(e => e.type !== 'rejected');
    const acted = events.some(e => e.type === 'moved' || e.type === 'attack' || e.type === 'defend');
    const lines: string[] = [];
    for (let i = 0; i < events.length; i++) {
        const event = events[i];
        if (event.type === 'moved') {
            let squares = Number(event.data.squares) || 0;
            let last = event;
            while (i + 1 < events.length && events[i + 1].type === 'moved' && events[i + 1].actorId === event.actorId) {
                i++;
                last = events[i];
                squares += Number(last.data.squares) || 0;
            }
            lines.push(moveClause(state, event.actorId, squares, last.data, opts.numbers));
            continue;
        }
        if (event.type === 'end_turn' && acted) continue;
        const line = opts.numbers ? event.text : narrationLine(event, state);
        if (line) lines.push(line);
    }
    return lines;
}
