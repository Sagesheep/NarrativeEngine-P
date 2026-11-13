import { coverBetween, distance, hasLineOfSight, hpBand, terrainOf } from '@narrative/engine';
import type { CombatEvent, CombatPos, CombatSide, CombatState, Combatant } from '../../types';

export const ACTION_EVENT_TYPES: ReadonlySet<string> = new Set(['attack', 'defend', 'end_turn', 'ability', 'turn_lost', 'flee', 'parley']);
export const TURN_ACTION_TYPES: ReadonlySet<string> = new Set(['moved', 'attack', 'defend', 'end_turn', 'ability', 'turn_lost', 'flee', 'parley']);
const ACTED_TYPES: ReadonlySet<string> = new Set(['moved', 'attack', 'defend', 'ability', 'turn_lost', 'flee', 'parley']);

export type TurnGroup = {
    actorId?: string;
    turn?: number;
    events: CombatEvent[];
};

export function isPresent(c: Pick<Combatant, 'status'> | undefined): boolean {
    return !!c && c.status !== 'gone';
}

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

type Move = { id: string; from: CombatPos; to: CombatPos };

function movesOf(event: CombatEvent): Move[] {
    const raw = event.data.moves;
    if (!Array.isArray(raw)) return [];
    return raw.filter((m): m is Move => !!m && typeof m === 'object' && typeof (m as Move).id === 'string'
        && typeof (m as Move).from?.x === 'number' && typeof (m as Move).from?.y === 'number');
}

function tilesOf(raw: unknown): CombatPos[] {
    return Array.isArray(raw) ? raw.filter((p): p is CombatPos => !!p && typeof p.x === 'number' && typeof p.y === 'number') : [];
}

function restoreTemp(target: Combatant, value: unknown): void {
    if (typeof value !== 'number') return;
    if (value > 0) target.tempHp = value;
    else delete target.tempHp;
}

export function stateAtSeq(state: CombatState, log: readonly CombatEvent[], seq: number): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) {
        combatants[id] = { ...c, ...(c.position ? { position: { ...c.position } } : {}) };
    }
    let barriers = (state.barriers ?? []).map(b => ({ ...b, pos: { ...b.pos } }));
    const later = log.filter(e => e.seq > seq).sort((a, b) => b.seq - a.seq);
    for (const event of later) {
        if (event.type === 'moved') {
            const actor = event.actorId ? combatants[event.actorId] : undefined;
            const from = event.data.from as { x: number; y: number } | undefined;
            if (actor && from && typeof from.x === 'number' && typeof from.y === 'number') actor.position = { x: from.x, y: from.y };
            continue;
        }
        for (const move of movesOf(event)) {
            const c = combatants[move.id];
            if (c) c.position = { x: move.from.x, y: move.from.y };
        }
        if (event.type === 'barrier') {
            const made = tilesOf(event.data.tiles);
            barriers = barriers.filter(b => !made.some(p => p.x === b.pos.x && p.y === b.pos.y));
            continue;
        }
        if (event.type === 'barrier_ended') {
            const expiresRound = typeof event.data.expiresRound === 'number' ? event.data.expiresRound : state.round;
            barriers = [...barriers, ...tilesOf(event.data.tiles).map(pos => ({ pos: { ...pos }, expiresRound, sourceId: '' }))];
            continue;
        }
        const target = event.targetId ? combatants[event.targetId] : undefined;
        if (!target) continue;
        if (typeof event.data.hpBefore === 'number') {
            target.hp = event.data.hpBefore;
            restoreTemp(target, event.data.tempBefore);
        } else if (event.type === 'attack' && event.data.hit === true && typeof event.data.damage === 'number') {
            target.hp = Math.min(target.maxHp, target.hp + event.data.damage);
        } else if (event.type === 'hazard' && typeof event.data.damage === 'number') {
            target.hp = Math.min(target.maxHp, target.hp + event.data.damage);
        }
        if (event.type === 'shield') restoreTemp(target, event.data.tempBefore);
        if (event.type === 'down' || event.type === 'dismissed' || event.type === 'surrendered') target.status = 'up';
        if (event.type === 'flee' && event.data.success === true) target.status = 'up';
        if (event.type === 'summoned') target.status = 'gone';
    }
    return { ...state, combatants, ...(state.barriers || barriers.length > 0 ? { barriers } : {}) };
}

export type HpBandLabel = 'unhurt' | 'hurt' | 'badly hurt' | 'down' | 'fled' | 'yielded';

export function hpBandLabel(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): HpBandLabel {
    const band = hpBand(c);
    return band === 'badly_hurt' ? 'badly hurt' : band;
}

export type PositionPhrase = 'adjacent' | 'close' | 'at range' | 'behind cover' | `behind the ${string}` | 'out of sight';

export function positionPhrase(state: CombatState, c: Combatant): PositionPhrase | null {
    const grid = terrainOf(state);
    const pc = Object.values(state.combatants).find(x => x.side === 'player');
    if (!grid || !pc || pc.id === c.id || pc.status === 'fled' || !pc.position || !c.position) return null;
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

function abilityLabel(event: CombatEvent): string {
    const n = typeof event.data.name === 'string' && event.data.name.trim() ? event.data.name.trim() : 'an ability';
    const type = typeof event.data.damageType === 'string' ? event.data.damageType.trim() : '';
    const effects = Array.isArray(event.data.effects) ? event.data.effects : [];
    const harmful = effects.some(e => e === 'damage' || e === 'drain');
    return harmful && type ? `${n} (${type})` : n;
}

function abilityName(event: CombatEvent): string {
    return typeof event.data.ability === 'string' && event.data.ability.trim() ? event.data.ability.trim() : 'The ability';
}

const CONDITION_WORDS: Readonly<Record<string, string>> = {
    stunned: 'stunned',
    slowed: 'slowed',
    hasted: 'hasted',
    shielded: 'shielded',
    defending: 'defending',
};

function conditionWord(raw: unknown): string {
    return typeof raw === 'string' && CONDITION_WORDS[raw] ? CONDITION_WORDS[raw] : 'affected';
}

function dodgeVerb(save: unknown): string {
    if (save === 'CON') return 'endures';
    if (save === 'WIS') return 'resists';
    return 'dives clear of';
}

export const NARRATED_EVENT_TYPES: readonly string[] = [
    'attack', 'initiative', 'round', 'moved', 'hazard', 'combat_started', 'defend', 'end_turn', 'down', 'combat_ended',
    'condition_ended', 'rejected', 'ability', 'ability_attack', 'save', 'ability_damage', 'heal', 'shield', 'pushed',
    'teleported', 'swapped', 'summoned', 'dismissed', 'barrier', 'barrier_ended', 'condition_added', 'turn_lost', 'unaffected',
    'flee', 'morale', 'parley', 'surrendered', 'fate',
];

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
            const order = state.order.filter(id => isPresent(state.combatants[id])).map(id => name(id));
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
        case 'combat_started':
        case 'defend':
        case 'end_turn':
        case 'down':
        case 'combat_ended':
            return event.text;
        case 'condition_ended':
            return `${name(event.targetId)} is no longer ${conditionWord(event.data.condition)}.`;
        case 'rejected':
            return '';
        case 'ability':
            return `${name(event.actorId)} uses ${abilityLabel(event)}.`;
        case 'ability_attack':
            if (event.data.hit !== true) return `${abilityName(event)} misses ${name(event.targetId)}.`;
            return event.data.crit === true
                ? `${abilityName(event)} strikes ${name(event.targetId)} squarely.`
                : `${abilityName(event)} hits ${name(event.targetId)}.`;
        case 'save':
            return event.data.success === true
                ? `${name(event.targetId)} ${dodgeVerb(event.data.save)} the worst of it.`
                : `${name(event.targetId)} is caught full on.`;
        case 'ability_damage': {
            const type = typeof event.data.damageType === 'string' && event.data.damageType.trim() ? event.data.damageType.trim() : '';
            const how = event.data.saved === true ? 'is grazed by the' : 'takes the full';
            const what = type ? `${type}` : 'blast';
            const extra = event.data.weakness === true ? ', which it is weak to' : event.data.resisted === true ? ', which it resists' : '';
            const soak = typeof event.data.absorbed === 'number' && event.data.absorbed > 0 ? ' A shield takes some of it.' : '';
            return `${name(event.targetId)} ${how} ${what}${extra}.${soak}`;
        }
        case 'heal':
            return event.data.source === 'drain'
                ? `${name(event.targetId)} draws strength from the stolen life.`
                : `${name(event.targetId)}'s wounds close.`;
        case 'shield':
            return event.data.applied === false
                ? `${name(event.targetId)} keeps the stronger shield it already has.`
                : `A shield settles over ${name(event.targetId)}.`;
        case 'pushed':
            return event.data.kind === 'pull'
                ? `${name(event.targetId)} is dragged toward ${name(event.actorId)}.`
                : `${name(event.targetId)} is thrown back.`;
        case 'teleported':
            return event.data.kind === 'dash'
                ? `${name(event.actorId)} dashes to ${name(event.targetId)}.`
                : `${name(event.actorId)} vanishes and reappears nearby.`;
        case 'swapped':
            return `${name(event.actorId)} and ${name(event.targetId)} trade places.`;
        case 'summoned':
            return `${name(event.actorId)} calls up ${name(event.targetId)}.`;
        case 'dismissed':
            return event.data.cause === 'destroyed' ? `${name(event.targetId)} is destroyed.` : `${name(event.targetId)} fades away.`;
        case 'barrier':
            return `${name(event.actorId)} raises a barrier.`;
        case 'barrier_ended':
            return 'A barrier fades.';
        case 'condition_added':
            return `${name(event.targetId)} is ${conditionWord(event.data.condition)}.`;
        case 'turn_lost':
            return `${name(event.actorId)} is stunned and cannot act.`;
        case 'unaffected':
            return `${name(event.targetId)} shakes off the stun.`;
        case 'flee':
            if (event.data.success === true) return `${name(event.actorId)} breaks away and leaves the fight.`;
            return `${name(event.actorId)} tries to break away but is cut off.`;
        case 'morale':
            return event.data.success === true ? '' : `${name(event.actorId)} loses its nerve and looks for a way out.`;
        case 'parley':
            return '';
        case 'surrendered':
            return `${name(event.targetId)} lowers its weapons and yields.`;
        case 'fate':
            return event.data.dies === true ? `${name(event.targetId)} does not survive.` : `${name(event.targetId)} clings to life.`;
        default:
            return '';
    }
}

export function turnLines(group: TurnGroup, state: CombatState, opts: { numbers: boolean }): string[] {
    const events = group.events.filter(e => e.type !== 'rejected');
    const acted = events.some(e => ACTED_TYPES.has(e.type));
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
