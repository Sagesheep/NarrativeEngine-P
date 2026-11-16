import { bareHands, bystanderIdOf, coverBetween, distance, hasLineOfSight, hpBand, leaderIdOf, terrainOf, undoDirectorEvent, undoObjectiveEvent, wardIdOf } from '@narrative/engine';
import type { CarriedItem, FieldItem, WeaponFields } from '@narrative/engine';
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

function fieldItemFrom(raw: unknown): FieldItem | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as FieldItem;
    if (typeof r.id !== 'string' || typeof r.ownerId !== 'string' || typeof r.pos?.x !== 'number' || typeof r.pos?.y !== 'number') return null;
    return { ...r, pos: { x: r.pos.x, y: r.pos.y } };
}

function carriedFrom(item: FieldItem): CarriedItem {
    return {
        id: item.id, name: item.name, count: item.count, sides: item.sides,
        ...(item.damageType ? { damageType: item.damageType } : {}),
        ...(item.equipped ? { equipped: true } : {}),
    };
}

function setWeapon(c: Combatant, fields: WeaponFields): void {
    c.damage = { ...fields.damage };
    if (fields.weaponName) c.weaponName = fields.weaponName;
    else delete c.weaponName;
    if (fields.range) c.range = fields.range;
    else delete c.range;
}

export function stateAtSeq(state: CombatState, log: readonly CombatEvent[], seq: number): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) {
        combatants[id] = { ...c, ...(c.position ? { position: { ...c.position } } : {}) };
    }
    let barriers = (state.barriers ?? []).map(b => ({ ...b, pos: { ...b.pos } }));
    let terrainEdits = (state.terrainEdits ?? []).map(e => ({ ...e, pos: { ...e.pos } }));
    let fieldItems = (state.fieldItems ?? []).map(i => ({ ...i, pos: { ...i.pos } }));
    const later = log.filter(e => e.seq > seq).sort((a, b) => b.seq - a.seq);
    for (const event of later) {
        if (event.type === 'stunt_check') continue;
        if (undoObjectiveEvent(combatants, event)) continue;
        if (undoDirectorEvent(combatants, event)) continue;
        if (event.type === 'item_dropped') {
            const item = fieldItemFrom(event.data.item);
            if (!item) continue;
            fieldItems = fieldItems.filter(i => i.id !== item.id);
            const owner = combatants[item.ownerId];
            if (owner) {
                const carried = (owner.carried ?? []).filter(i => i.id !== item.id);
                const index = typeof event.data.index === 'number' && event.data.index >= 0 ? Math.min(event.data.index, carried.length) : carried.length;
                carried.splice(index, 0, carriedFrom(item));
                owner.carried = carried;
                if (item.armed) setWeapon(owner, item.armed);
            }
            continue;
        }
        if (event.type === 'item_recovered') {
            const item = fieldItemFrom(event.data.item);
            if (!item) continue;
            fieldItems = [...fieldItems.filter(i => i.id !== item.id), item];
            if (event.data.how === 'picked_up') {
                const picker = event.actorId ? combatants[event.actorId] : undefined;
                if (picker) {
                    picker.carried = (picker.carried ?? []).filter(i => i.id !== item.id);
                    if (event.data.rearmed === true && item.armed) setWeapon(picker, bareHands(item.armed));
                }
            }
            continue;
        }
        if (event.type === 'thrown' && Array.isArray(event.data.terrain)) {
            terrainEdits = terrainEdits.slice(0, Math.max(0, terrainEdits.length - event.data.terrain.length));
        }
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
    return {
        ...state,
        combatants,
        ...(state.barriers || barriers.length > 0 ? { barriers } : {}),
        ...(state.terrainEdits || terrainEdits.length > 0 ? { terrainEdits } : {}),
        ...(state.fieldItems || fieldItems.length > 0 ? { fieldItems } : {}),
    };
}

export type HpBandLabel = 'unhurt' | 'hurt' | 'badly hurt' | 'down' | 'fled' | 'yielded' | 'escaped';

export function hpBandLabel(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): HpBandLabel {
    if (c.status === 'escaped') return 'escaped';
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
    'flee', 'morale', 'parley', 'surrendered', 'fate', 'rallied', 'stunt_check', 'thrown', 'item_dropped', 'item_recovered',
    'objective_progress', 'objective_met', 'objective_failed', 'reinforcements_warning', 'reinforcements_arrive', 'order_given',
];

type ThrownPayload = { kind: string; name: string; willing?: boolean };

function itemName(raw: unknown): string {
    const text = typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, 60) : '';
    if (!text) return 'the item';
    return /^(a|an|the|his|her|their|my|your|something)\s/i.test(text) || /'s\s/.test(text) ? text : `the ${text}`;
}

function thrownWhat(payload: ThrownPayload): string {
    if (payload.kind === 'hand') return 'something snatched up';
    if (payload.kind === 'cover') return payload.name && payload.name !== 'cover' ? `the ${payload.name}` : 'a chunk of cover';
    if (payload.kind === 'item') return itemName(payload.name);
    return payload.name || 'someone';
}

const THROW_HIT_TAILS: Readonly<Record<HitSeverity, string>> = {
    graze: ', just grazing them',
    hit: ', hitting them',
    hard: ', hitting hard',
    devastating: ', a crushing blow',
};

function thrownLine(event: CombatEvent, state: CombatState): string {
    const actor = nameIn(state, event.actorId);
    const raw = event.data.payload as Partial<ThrownPayload> | undefined;
    const payload: ThrownPayload = { kind: typeof raw?.kind === 'string' ? raw.kind : 'hand', name: typeof raw?.name === 'string' ? raw.name : '', willing: raw?.willing === true };
    const what = thrownWhat(payload);
    const struck = event.targetId ? nameIn(state, event.targetId) : '';
    const cover = payload.kind === 'cover';
    if (struck) {
        if (event.data.hit === true) {
            if (cover) return `${actor} heaves ${what} across the room and it crashes into ${struck}.`;
            if (event.data.crit === true) return `${actor} hurls ${what} at ${struck}, a perfect throw.`;
            const severity = hitSeverity(event, state) ?? 'hit';
            return `${actor} hurls ${what} at ${struck}${THROW_HIT_TAILS[severity]}.`;
        }
        if (cover) return `${actor} heaves ${what} across the room; it smashes where ${struck} stood.`;
        if (payload.kind === 'creature') return `${actor} hurls ${what} at ${struck} and misses; ${what} crashes down beside ${struck}.`;
        return `${actor} hurls ${what} at ${struck} and misses; it clatters down beside ${struck}.`;
    }
    if (payload.kind === 'creature') return payload.willing ? `${actor} throws ${what} clear to a new spot.` : `${actor} hurls ${what} across the field.`;
    if (cover) return `${actor} heaves ${what} across the room; it smashes down on open ground.`;
    if (payload.kind === 'hand') return `${actor} flings something snatched up across the field.`;
    return `${actor} throws ${what} across the field.`;
}

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

function objectiveName(state: CombatState, pick: (o: NonNullable<CombatState['objective']>) => string | undefined, fallback: string): string {
    const id = state.objective ? pick(state.objective) : undefined;
    return (id && state.combatants[id]?.name) || fallback;
}

function clockLine(event: CombatEvent, state: CombatState): string {
    const left = num(event.data.left);
    if (left === null || left > 2) return '';
    if (left === 2) return 'Time is running short.';
    if (event.data.clock === 'protect') return `This is the last round to keep ${objectiveName(state, wardIdOf, 'the ward')} alive.`;
    if (event.data.clock === 'survive') return 'This is the last round to hold out.';
    return 'This is the last round before time runs out.';
}

function progressLine(event: CombatEvent, state: CombatState): string {
    const unit = nameIn(state, typeof event.data.unitId === 'string' ? event.data.unitId : event.targetId);
    switch (event.data.kind) {
        case 'rounds_left':
            return clockLine(event, state);
        case 'escaped':
            return event.data.how === 'leader_exit' ? `${unit} slips away through the exit.` : `${unit} gets out through the exit.`;
        case 'holding':
            return `${unit} takes the marked ground.`;
        case 'reached':
            return `${unit} reaches the marked spot.`;
        case 'hold_broken':
            return `${unit} loses the hold on the marked ground.`;
        default:
            return '';
    }
}

function metLine(event: CombatEvent, state: CombatState): string {
    if (event.data.part === 'side') {
        switch (event.data.kind) {
            case 'within_rounds':
                return 'The fight is won in good time.';
            case 'no_one_falls':
                return 'No one in the party fell.';
            case 'save_bystander':
                return `${objectiveName(state, bystanderIdOf, 'The bystander')} is safe.`;
            case 'reach_tile':
                return 'The party got to the marked spot.';
            default:
                return '';
        }
    }
    switch (event.data.by) {
        case 'defeat_leader':
            return 'With their leader beaten, the fight goes out of the rest.';
        case 'survive':
            return 'The party has held out.';
        case 'escape':
            return 'The way out is taken and the party is clear.';
        case 'protect':
            return `${objectiveName(state, wardIdOf, 'The ward')} is safe.`;
        case 'seize':
            return 'The marked ground is held.';
        default:
            return '';
    }
}

function failedLine(event: CombatEvent, state: CombatState): string {
    if (event.data.part === 'side') {
        switch (event.data.kind) {
            case 'within_rounds':
                return 'The fight dragged on too long.';
            case 'no_one_falls':
                return 'Someone in the party went down.';
            case 'save_bystander':
                return `${objectiveName(state, bystanderIdOf, 'The bystander')} was lost.`;
            case 'reach_tile':
                return 'The party never got to the marked spot.';
            default:
                return '';
        }
    }
    switch (event.data.by) {
        case 'ward_falls':
            return `${objectiveName(state, wardIdOf, 'The ward')} is lost, and with them the party's aim.`;
        case 'round_limit':
            return 'Time has run out.';
        case 'leader_escapes':
            return `${objectiveName(state, leaderIdOf, 'The enemy leader')} has got away.`;
        case 'survive':
            return 'The party could not hold out.';
        default:
            return '';
    }
}

function arrivalLine(event: CombatEvent): string {
    const units = Array.isArray(event.data.units) ? event.data.units as Array<{ name?: unknown }> : [];
    const names = units.map(u => (typeof u?.name === 'string' ? u.name : '')).filter(Boolean);
    return names.length > 0 ? `Reinforcements arrive: ${names.join(', ')}.` : '';
}

export function spokenLine(event: CombatEvent): string {
    const raw = typeof event.data.line === 'string' ? event.data.line : '';
    return raw.replace(/[\r\n]+/g, ' ').replace(/["“”]/g, '\'').replace(/\s+/g, ' ').trim();
}

function orderIntent(event: CombatEvent, state: CombatState): string {
    const actor = nameIn(state, event.actorId);
    const target = nameIn(state, typeof event.data.targetId === 'string' ? event.data.targetId : event.targetId);
    switch (event.data.kind) {
        case 'focus':
            return `${actor} marks ${target} as the one to bring down.`;
        case 'protect':
            return `${actor} means to keep ${target} safe.`;
        case 'hold':
            return `${actor} means to hold their ground.`;
        case 'fall_back':
            return `${actor} means to pull back.`;
        case 'press':
            return `${actor} throws caution aside to press the attack.`;
        case 'signature': {
            const move = typeof event.data.signatureName === 'string' && event.data.signatureName.trim() ? event.data.signatureName.trim() : 'a signature move';
            return `${actor} readies ${move}.`;
        }
        case 'switch_tactic':
            return `${actor} changes how they fight.`;
        default:
            return '';
    }
}

function orderLine(event: CombatEvent, state: CombatState): string {
    const intent = orderIntent(event, state);
    if (!intent) return '';
    const line = spokenLine(event);
    return line ? `${intent} ${nameIn(state, event.actorId)} calls out: "${line}"` : intent;
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
            if (builtinKind(event) === 'throw') {
                return event.data.success === true ? `${name(event.actorId)} tries to lift ${name(event.targetId)}, who wrenches free.` : '';
            }
            const close = isCloseSave(event);
            if (event.data.success === true) return `${name(event.targetId)} ${close ? 'only just ' : ''}${dodgeVerb(event.data.save)} the worst of it.`;
            return close ? `${name(event.targetId)} only just fails to get clear and is caught.` : `${name(event.targetId)} is caught full on.`;
        }
        case 'thrown':
            return thrownLine(event, state);
        case 'item_dropped':
            return '';
        case 'item_recovered':
            return event.data.how === 'picked_up' ? `${name(event.actorId)} picks up ${itemName(event.data.name)}.` : '';
        case 'ability_damage': {
            if (event.data.kind === 'landing' && builtinKind(event) === 'throw') return '';
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
        case 'pushed': {
            const moved = Number(event.data.squares) > 0;
            const target = name(event.targetId);
            if (builtinKind(event) === 'stunt' && !moved) return `${target} is pinned in place and does not move.`;
            if (builtinKind(event) === 'shove') {
                return moved
                    ? `${name(event.actorId)} shoves ${target} back.`
                    : `${name(event.actorId)} shoves ${target}, but ${target} is pinned in place and does not move.`;
            }
            if (!moved) return `${target} is ${event.data.kind === 'pull' ? 'pulled' : 'pushed'}, but is pinned in place and does not move.`;
            return event.data.kind === 'pull'
                ? `${target} is dragged toward ${name(event.actorId)}.`
                : `${target} is thrown back.`;
        }
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
        case 'objective_progress':
            return progressLine(event, state);
        case 'objective_met':
            return metLine(event, state);
        case 'objective_failed':
            return failedLine(event, state);
        case 'reinforcements_warning':
            return event.data.delayed === true ? 'The reinforcements are held up, but they are still coming.' : 'Reinforcements are coming.';
        case 'reinforcements_arrive':
            return arrivalLine(event);
        case 'order_given':
            return orderLine(event, state);
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

export type MomentTag =
    | 'first blood' | 'now badly hurt' | 'killing blow' | 'last one standing' | 'the player character falls'
    | 'a way out is taken' | 'the leader gets away' | 'the ground is taken' | 'the hold is broken' | 'the last round'
    | 'the objective is achieved' | 'the objective is lost' | 'reinforcements are coming' | 'reinforcements have arrived'
    | 'an officer gives an order';

function objectiveTag(event: CombatEvent, state: CombatState): MomentTag | null {
    let tag: MomentTag | null = null;
    if (event.type === 'objective_progress') {
        if (event.data.kind === 'escaped') tag = event.data.how === 'leader_exit' ? 'the leader gets away' : 'a way out is taken';
        else if (event.data.kind === 'holding') tag = 'the ground is taken';
        else if (event.data.kind === 'hold_broken') tag = 'the hold is broken';
        else if (event.data.kind === 'rounds_left' && num(event.data.left) === 1) tag = 'the last round';
    } else if (event.type === 'objective_met' && event.data.part === 'win') tag = 'the objective is achieved';
    else if (event.type === 'objective_failed' && event.data.part === 'lose') tag = 'the objective is lost';
    else if (event.type === 'reinforcements_warning') tag = 'reinforcements are coming';
    else if (event.type === 'reinforcements_arrive') tag = 'reinforcements have arrived';
    else if (event.type === 'order_given') tag = 'an officer gives an order';
    return tag && narrationLine(event, state) ? tag : null;
}

const DAMAGE_EVENT_TYPES: ReadonlySet<string> = new Set(['attack', 'ability_damage', 'hazard', 'thrown']);

function hpChange(event: CombatEvent, target: Combatant | undefined): { before: number; after: number } | null {
    if (!target || !DAMAGE_EVENT_TYPES.has(event.type)) return null;
    if ((event.type === 'attack' || event.type === 'thrown') && event.data.hit !== true) return null;
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
        const objective = objectiveTag(event, state);
        if (objective) tags.set(event.seq, objective);
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
