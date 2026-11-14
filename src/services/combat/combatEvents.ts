import { coverBetween, distance, hasLineOfSight, hpBand, terrainOf } from '@narrative/engine';
import type { CombatEvent, CombatPos, CombatSide, CombatState, Combatant } from '../../types';

export const ACTION_EVENT_TYPES: ReadonlySet<string> = new Set(['attack', 'defend', 'end_turn', 'ability', 'turn_lost', 'flee', 'parley', 'stunt_check']);
export const TURN_ACTION_TYPES: ReadonlySet<string> = new Set(['moved', 'attack', 'defend', 'end_turn', 'ability', 'turn_lost', 'flee', 'parley', 'stunt_check']);
const ACTED_TYPES: ReadonlySet<string> = new Set(['moved', 'attack', 'defend', 'ability', 'turn_lost', 'flee', 'parley', 'stunt_check']);

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
        if (event.type === 'stunt_check') continue;
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
        if (event.type === 'rallied' && event.data.kind === 'revive') target.status = 'down';
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

const LEAP_ORDER = ['hazard', 'difficult', 'cover'] as const;

function leapLine(event: CombatEvent, state: CombatState, actor: string): string {
    const over = Array.isArray(event.data.over) ? event.data.over : [];
    for (const tile of LEAP_ORDER) {
        if (!over.includes(tile)) continue;
        const label = state.grid?.labels?.[tile]?.trim();
        if (label) return `${actor} leaps across the ${label}.`;
    }
    return `${actor} leaps across to a new spot.`;
}

function builtinKind(event: CombatEvent): string {
    if (typeof event.data.builtin === 'string') return event.data.builtin;
    const id = event.data.abilityId;
    return typeof id === 'string' && id.startsWith('builtin:') ? id.slice('builtin:'.length) : '';
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
    'flee', 'morale', 'parley', 'surrendered', 'fate', 'rallied', 'stunt_check',
];

function num(raw: unknown): number | null {
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

export type HitSeverity = 'graze' | 'hit' | 'hard' | 'devastating';

export function hitSeverity(event: CombatEvent, state: CombatState): HitSeverity | null {
    const damage = num(event.data.damage);
    const target = event.targetId ? state.combatants[event.targetId] : undefined;
    if (damage === null || !target || !(target.maxHp > 0)) return null;
    const dealt = Math.max(0, damage - (num(event.data.absorbed) ?? 0));
    const pct = dealt * 100;
    if (pct < target.maxHp * 15) return 'graze';
    if (pct < target.maxHp * 35) return 'hit';
    if (pct <= target.maxHp * 60) return 'hard';
    return 'devastating';
}

export function isNearMiss(event: CombatEvent): boolean {
    if (event.data.hit === true || event.data.fumble === true) return false;
    const total = num(event.data.total);
    const ac = num(event.data.ac);
    return total !== null && ac !== null && ac - total <= 2;
}

export function isCloseSave(event: CombatEvent): boolean {
    const total = num(event.data.total);
    const dc = num(event.data.dc);
    return total !== null && dc !== null && Math.abs(total - dc) <= 2;
}

function guardWord(event: CombatEvent): 'guard' | 'shield' | null {
    if (event.data.defending === true) return 'guard';
    if (event.data.shielded === true) return 'shield';
    return null;
}

function weaponPhrase(event: CombatEvent): string {
    const raw = typeof event.data.weapon === 'string' ? event.data.weapon.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    if (!raw) return '';
    return /^(a|an|the|his|her|their|my|your|something)\s/i.test(raw) || /'s\s/.test(raw) ? ` with ${raw}` : ` with the ${raw}`;
}

function attackLine(event: CombatEvent, state: CombatState): string {
    const actor = nameIn(state, event.actorId);
    const target = nameIn(state, event.targetId);
    const weapon = weaponPhrase(event);
    if (event.data.hit !== true) {
        if (!isNearMiss(event)) return `${actor} attacks ${target}${weapon} and misses.`;
        const guard = guardWord(event);
        return guard ? `${actor}'s attack is turned aside by ${target}'s ${guard}.` : `${actor} narrowly misses ${target}${weapon}.`;
    }
    const type = typeof event.data.damageType === 'string' ? event.data.damageType : '';
    const tail = `${weapon}${type ? ` (${type})` : ''}.`;
    if (event.data.crit === true) return `${actor} lands a critical hit on ${target}${tail}`;
    const severity = hitSeverity(event, state);
    if (severity === 'graze') return `${actor} grazes ${target}${tail}`;
    if (severity === 'hard') return `${actor} hits ${target} hard${tail}`;
    if (severity === 'devastating') return `${actor} lands a devastating blow on ${target}${tail}`;
    return `${actor} hits ${target}${tail}`;
}

function abilityDamageHow(event: CombatEvent, state: CombatState): string {
    if (event.data.saved === true) return 'is grazed by the';
    if (event.data.crit === true) return 'takes the full';
    const severity = hitSeverity(event, state);
    if (severity === 'graze') return 'is grazed by the';
    if (severity === 'hard') return 'is hit hard by the';
    if (severity === 'devastating') return 'takes a devastating blow from the';
    return 'takes the full';
}

export function narrationLine(event: CombatEvent, state: CombatState): string {
    const name = (id?: string) => nameIn(state, id);
    switch (event.type) {
        case 'attack':
            return attackLine(event, state);
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
        case 'ability': {
            const kind = builtinKind(event);
            if (kind === 'dash') return `${name(event.actorId)} sprints.`;
            if (kind) return '';
            return `${name(event.actorId)} uses ${abilityLabel(event)}.`;
        }
        case 'ability_attack':
            if (event.data.hit !== true) {
                if (!isNearMiss(event)) return `${abilityName(event)} misses ${name(event.targetId)}.`;
                const guard = guardWord(event);
                return guard ? `${abilityName(event)} is turned aside by ${name(event.targetId)}'s ${guard}.` : `${abilityName(event)} narrowly misses ${name(event.targetId)}.`;
            }
            return event.data.crit === true
                ? `${abilityName(event)} strikes ${name(event.targetId)} squarely.`
                : `${abilityName(event)} hits ${name(event.targetId)}.`;
        case 'save': {
            if (builtinKind(event) === 'shove') {
                return event.data.success === true ? `${name(event.actorId)} shoves ${name(event.targetId)}, who holds their ground.` : '';
            }
            const close = isCloseSave(event);
            if (event.data.success === true) return `${name(event.targetId)} ${close ? 'only just ' : ''}${dodgeVerb(event.data.save)} the worst of it.`;
            return close ? `${name(event.targetId)} only just fails to get clear and is caught.` : `${name(event.targetId)} is caught full on.`;
        }
        case 'ability_damage': {
            const type = typeof event.data.damageType === 'string' && event.data.damageType.trim() ? event.data.damageType.trim() : '';
            const how = abilityDamageHow(event, state);
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
            if (builtinKind(event) === 'stunt' && Number(event.data.squares) <= 0) return `${name(event.targetId)} does not budge.`;
            if (builtinKind(event) === 'shove') {
                return Number(event.data.squares) > 0
                    ? `${name(event.actorId)} shoves ${name(event.targetId)} back.`
                    : `${name(event.actorId)} shoves ${name(event.targetId)}, who has nowhere to go.`;
            }
            return event.data.kind === 'pull'
                ? `${name(event.targetId)} is dragged toward ${name(event.actorId)}.`
                : `${name(event.targetId)} is thrown back.`;
        case 'teleported':
            if (event.data.kind === 'leap') return leapLine(event, state, name(event.actorId));
            if (builtinKind(event) === 'stunt') return `${name(event.actorId)} gets across to a new spot.`;
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
            return builtinKind(event) === 'stunt' ? `${name(event.actorId)} throws up cover.` : `${name(event.actorId)} raises a barrier.`;
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
        case 'rallied':
            return event.data.kind === 'revive'
                ? `${name(event.actorId)} hauls ${name(event.targetId)} back to their feet.`
                : `${name(event.actorId)} shakes ${name(event.targetId)} out of it.`;
        case 'fate':
            return event.data.dies === true ? `${name(event.targetId)} does not survive.` : `${name(event.targetId)} clings to life.`;
        case 'stunt_check':
            if (event.data.success === true) return `${name(event.actorId)} pulls it off.`;
            return event.data.fumble === true ? `${name(event.actorId)}'s attempt goes badly wrong.` : `${name(event.actorId)}'s attempt does not come off.`;
        default:
            return '';
    }
}

export type TurnLine = { seq: number; text: string };

export function turnLineEntries(group: TurnGroup, state: CombatState, opts: { numbers: boolean; tags?: ReadonlyMap<number, string> }): TurnLine[] {
    const events = group.events.filter(e => e.type !== 'rejected');
    const acted = events.some(e => ACTED_TYPES.has(e.type));
    const lines: TurnLine[] = [];
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
            lines.push({ seq: event.seq, text: moveClause(state, event.actorId, squares, last.data, opts.numbers) });
            continue;
        }
        if (event.type === 'end_turn' && acted) continue;
        const line = opts.numbers ? event.text : narrationLine(event, state);
        if (!line) continue;
        const tag = opts.numbers ? undefined : opts.tags?.get(event.seq);
        lines.push({ seq: event.seq, text: tag ? `${line} [${tag}]` : line });
    }
    return lines;
}

export function turnLines(group: TurnGroup, state: CombatState, opts: { numbers: boolean; tags?: ReadonlyMap<number, string> }): string[] {
    return turnLineEntries(group, state, opts).map(l => l.text);
}

export type MomentTag = 'first blood' | 'now badly hurt' | 'killing blow' | 'last one standing' | 'the player character falls';

const DAMAGE_EVENT_TYPES: ReadonlySet<string> = new Set(['attack', 'ability_damage', 'hazard']);

function hpChange(event: CombatEvent, target: Combatant | undefined): { before: number; after: number } | null {
    if (!target || !DAMAGE_EVENT_TYPES.has(event.type)) return null;
    if (event.type === 'attack' && event.data.hit !== true) return null;
    const after = num(event.data.hpAfter);
    if (after === null) return null;
    const stated = num(event.data.hpBefore);
    const damage = num(event.data.damage);
    const before = stated ?? (damage !== null ? Math.min(target.maxHp, after + damage) : null);
    return before === null ? null : { before, after };
}

function enemyStillUp(c: Combatant): boolean {
    return c.side === 'enemy' && !c.summonerId && c.status === 'up';
}

export function momentTags(state: CombatState, log: readonly CombatEvent[], throughSeq: number): Map<number, MomentTag> {
    const tags = new Map<number, MomentTag>();
    const events = log.filter(e => e.type !== 'rejected' && e.seq <= throughSeq).sort((a, b) => a.seq - b.seq);
    const start = stateAtSeq(state, log, 0);
    const status = new Map(Object.values(start.combatants).map(c => [c.id, c.status]));
    const upCount = () => Object.values(state.combatants).filter(c => enemyStillUp({ ...c, status: status.get(c.id) ?? c.status })).length;
    let bled = false;
    let enemiesUp = upCount();
    for (const event of events) {
        const target = event.targetId ? state.combatants[event.targetId] : undefined;
        const change = hpChange(event, target);
        if (change && target && change.after < change.before) {
            let tag: MomentTag | null = null;
            if (change.after <= 0 && change.before > 0) {
                if (target.side === 'player') tag = 'the player character falls';
                else if (target.side !== 'ally') tag = 'killing blow';
            }
            if (!tag && change.after > 0) {
                const was = hpBand({ hp: change.before, maxHp: target.maxHp, status: 'up' });
                const now = hpBand({ hp: change.after, maxHp: target.maxHp, status: 'up' });
                if (now === 'badly_hurt' && was !== 'badly_hurt') tag = 'now badly hurt';
            }
            if (!tag && !bled) tag = 'first blood';
            bled = true;
            if (tag) tags.set(event.seq, tag);
        }
        if (event.type === 'down' && event.targetId) status.set(event.targetId, 'down');
        else if (event.type === 'surrendered' && event.targetId) status.set(event.targetId, 'surrendered');
        else if (event.type === 'flee' && event.data.success === true && event.actorId) status.set(event.actorId, 'fled');
        else if (event.type === 'dismissed' && event.targetId) status.set(event.targetId, 'gone');
        else if (event.type === 'summoned' && event.targetId) status.set(event.targetId, 'up');
        else continue;
        const now = upCount();
        if (now === 1 && enemiesUp > 1 && !tags.has(event.seq)) tags.set(event.seq, 'last one standing');
        enemiesUp = now;
    }
    return tags;
}
