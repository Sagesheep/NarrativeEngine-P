import { createRng } from './rng';
import { speedOf } from './grid';
import { DEFAULT_HAZARD_TYPE } from './mapBuilder';
import type { CombatCondition, CombatEvent, CombatOutcome, CombatState, Combatant, Rng, Side, TurnState } from './types';

export const DEFEND_CONDITION = 'defending';
export const STUNNED = 'stunned';
export const SLOWED = 'slowed';
export const HASTED = 'hasted';
export const SHIELDED = 'shielded';

export type Draft = {
    state: CombatState;
    rng: Rng;
    events: CombatEvent[];
};

export function cloneState(state: CombatState): CombatState {
    const combatants: Record<string, Combatant> = {};
    for (const [id, c] of Object.entries(state.combatants)) {
        combatants[id] = {
            ...c,
            abilities: { ...c.abilities },
            damage: { ...c.damage },
            conditions: c.conditions.map(x => ({ ...x })),
            ...(c.position ? { position: { ...c.position } } : {}),
            ...(c.cooldowns ? { cooldowns: { ...c.cooldowns } } : {}),
        };
    }
    return {
        ...state,
        order: [...state.order],
        combatants,
        ...(state.turn ? { turn: { ...state.turn } } : {}),
        ...(state.barriers ? { barriers: state.barriers.map(b => ({ ...b, pos: { ...b.pos } })) } : {}),
    };
}

export function openDraft(state: CombatState): Draft {
    const next = cloneState(state);
    return { state: next, rng: createRng(next.rngSeed, next.rngCursor), events: [] };
}

export function closeDraft(draft: Draft): { state: CombatState; events: CombatEvent[] } {
    draft.state.rngCursor = draft.rng.cursor;
    return { state: draft.state, events: draft.events };
}

export function emit(draft: Draft, event: Omit<CombatEvent, 'seq' | 'round' | 'turn'>): void {
    draft.state.eventSeq += 1;
    draft.events.push({ seq: draft.state.eventSeq, round: draft.state.round, turn: draft.state.turnCount ?? 0, ...event });
}

export function isPlayerSide(side: Side): boolean {
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

export function hasCondition(c: Pick<Combatant, 'conditions'>, id: string): boolean {
    return c.conditions.some(x => x.id === id);
}

export function freshTurn(state: CombatState, actorId: string): TurnState {
    const actor = state.combatants[actorId];
    let speed = state.grid && actor ? speedOf(actor) : 0;
    const hasted = !!actor && hasCondition(actor, HASTED);
    if (actor && hasted) speed *= 2;
    if (actor && hasCondition(actor, SLOWED)) speed = Math.floor(speed / 2);
    return { actorId, moveLeft: speed, actionUsed: false, ...(hasted ? { extraActions: 1 } : {}) };
}

export function currentTurn(state: CombatState): TurnState | null {
    const id = currentActorId(state);
    if (!id) return null;
    if (state.turn && state.turn.actorId === id) return state.turn;
    return freshTurn(state, id);
}

export function canAttackWith(turn: TurnState): boolean {
    return !turn.actionUsed || (turn.extraActions ?? 0) > 0;
}

export function spendAttackAction(turn: TurnState): TurnState {
    if ((turn.extraActions ?? 0) > 0) return { ...turn, extraActions: (turn.extraActions as number) - 1 };
    return { ...turn, actionUsed: true };
}

export function countsForOutcome(c: Combatant): boolean {
    return !c.summonerId && c.status !== 'gone';
}

export function checkOutcome(state: CombatState): CombatOutcome | null {
    if (state.outcome) return state.outcome;
    const all = Object.values(state.combatants).filter(countsForOutcome);
    const enemiesUp = all.some(c => c.side === 'enemy' && c.status === 'up');
    const party = all.filter(c => isPlayerSide(c.side));
    const playersUp = party.some(c => c.status === 'up');
    if (!enemiesUp) return 'victory';
    if (!playersUp) return party.some(c => c.status === 'fled') ? 'fled' : 'defeat';
    return null;
}

export function playerCharacterOf(state: CombatState): Combatant | undefined {
    return Object.values(state.combatants).find(c => c.side === 'player');
}

export const OUTCOME_TEXT: Readonly<Record<CombatOutcome, string>> = {
    victory: 'The fight is won.',
    defeat: 'The fight is lost.',
    fled: 'The party gets away from the fight.',
    truce: 'The fighting stops under a truce.',
    aborted: 'The fight is broken off.',
};

export const HARDCORE_DEATH_MAX = 7;

function fateApplies(state: CombatState, pc: Combatant | undefined): boolean {
    const mode = state.defeatMode;
    if (!pc || (mode !== 'hardcore' && mode !== 'ironman') || state.fate) return false;
    if (state.ending?.conceded) return true;
    if (state.ending?.carried) return false;
    if (state.outcome !== 'defeat' && state.outcome !== 'fled') return false;
    return pc.status === 'down';
}

export function rollFate(draft: Draft): void {
    const s = draft.state;
    const pc = playerCharacterOf(s);
    if (!pc || !fateApplies(s, pc)) return;
    const mode = s.defeatMode as 'hardcore' | 'ironman';
    const natural = mode === 'hardcore' ? draft.rng.roll(20) : undefined;
    const dies = mode === 'ironman' || (natural as number) <= HARDCORE_DEATH_MAX;
    s.fate = { pcId: pc.id, mode, ...(natural !== undefined ? { natural } : {}), dies };
    emit(draft, {
        type: 'fate',
        targetId: pc.id,
        data: { mode, dies, ...(natural !== undefined ? { natural } : {}) },
        text: dies
            ? `${pc.name} dies${natural !== undefined ? ` (fate roll ${natural})` : ''}.`
            : `${pc.name} survives, barely (fate roll ${natural}).`,
    });
}

export function endFight(draft: Draft, outcome: CombatOutcome, data: Record<string, unknown> = {}): void {
    if (draft.state.outcome) return;
    draft.state.outcome = outcome;
    emit(draft, { type: 'combat_ended', data: { outcome, ...data }, text: OUTCOME_TEXT[outcome] });
    rollFate(draft);
}

export function rollDamage(rng: Rng, count: number, sides: number, bonus: number): number {
    let total = bonus;
    for (let i = 0; i < count; i++) total += rng.roll(sides);
    return Math.max(1, total);
}

export function downText(target: Combatant): string {
    return isPlayerSide(target.side) ? `${target.name} falls unconscious.` : `${target.name} is down.`;
}

export function dismissSummon(draft: Draft, summon: Combatant, cause: 'expired' | 'summoner_down' | 'summoner_left' | 'replaced' | 'destroyed'): void {
    if (summon.status === 'gone') return;
    summon.status = 'gone';
    summon.conditions = [];
    delete summon.tempHp;
    const text = cause === 'destroyed' ? `${summon.name} is destroyed.` : `${summon.name} fades away.`;
    emit(draft, { type: 'dismissed', targetId: summon.id, data: { cause, summonerId: summon.summonerId }, text });
}

export function markDown(draft: Draft, target: Combatant, cause: { actorId?: string; hazard?: boolean }): void {
    if (target.status !== 'up') return;
    if (target.summonerId) {
        dismissSummon(draft, target, 'destroyed');
        return;
    }
    target.status = 'down';
    delete target.tempHp;
    emit(draft, {
        type: 'down',
        ...(cause.actorId ? { actorId: cause.actorId } : {}),
        targetId: target.id,
        data: { side: target.side, ...(cause.hazard ? { cause: 'hazard' } : {}) },
        text: downText(target),
    });
    for (const id of draft.state.order) {
        const c = draft.state.combatants[id];
        if (c && c.summonerId === target.id && c.status === 'up') dismissSummon(draft, c, 'summoner_down');
    }
}

export function applyDamage(target: Combatant, amount: number): { absorbed: number; dealt: number; hpBefore: number; tempBefore: number } {
    const hpBefore = target.hp;
    const tempBefore = target.tempHp ?? 0;
    const absorbed = Math.min(tempBefore, amount);
    const dealt = amount - absorbed;
    if (tempBefore > 0) {
        const left = tempBefore - absorbed;
        if (left > 0) target.tempHp = left;
        else {
            delete target.tempHp;
            target.conditions = target.conditions.filter(c => c.id !== SHIELDED);
        }
    }
    target.hp = Math.max(0, target.hp - dealt);
    return { absorbed, dealt, hpBefore, tempBefore };
}

export const HAZARD_DAMAGE_DIE = 6;

export function hazardStrike(draft: Draft, c: Combatant): void {
    const grid = draft.state.grid;
    if (!grid) return;
    const damage = draft.rng.roll(HAZARD_DAMAGE_DIE);
    const damageType = grid.hazardType || DEFAULT_HAZARD_TYPE;
    const hit = applyDamage(c, damage);
    emit(draft, {
        type: 'hazard',
        targetId: c.id,
        data: {
            damage, damageType, hpAfter: c.hp,
            ...(hit.absorbed > 0 ? { absorbed: hit.absorbed, hpBefore: hit.hpBefore, tempBefore: hit.tempBefore } : {}),
        },
        text: grid.labels?.hazard ? `${c.name} takes ${damage} damage from the ${grid.labels.hazard}.` : `${c.name} takes ${damage} ${damageType} damage from the hazard.`,
    });
    if (c.hp <= 0) markDown(draft, c, { hazard: true });
}

export function settleOutcome(draft: Draft): void {
    const outcome = checkOutcome(draft.state);
    if (!outcome || draft.state.outcome) return;
    endFight(draft, outcome);
}

export function setCondition(target: Combatant, cond: CombatCondition): void {
    const existing = target.conditions.find(c => c.id === cond.id);
    if (existing) {
        existing.turns = Math.max(existing.turns ?? 0, cond.turns ?? 0);
        if (cond.appliedTurn !== undefined) existing.appliedTurn = cond.appliedTurn;
        if (cond.sourceId) existing.sourceId = cond.sourceId;
        return;
    }
    target.conditions = [...target.conditions, cond];
}

export const COMBAT_EVENT_TYPES: readonly string[] = [
    'combat_started', 'initiative', 'round', 'moved', 'attack', 'defend', 'end_turn', 'down', 'hazard', 'condition_ended',
    'combat_ended', 'rejected', 'ability', 'ability_attack', 'save', 'ability_damage', 'heal', 'shield', 'pushed', 'teleported',
    'swapped', 'summoned', 'dismissed', 'barrier', 'barrier_ended', 'condition_added', 'turn_lost', 'unaffected',
    'flee', 'morale', 'parley', 'surrendered', 'fate', 'rallied', 'stunt_check',
];
