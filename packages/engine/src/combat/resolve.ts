import { abilityMod, proficiencyForLevel, TIER_LEVEL } from './abilities';
import { createRng } from './rng';
import { buildTierBlock, DEFAULT_JITTER_RANGE, TIER_TABLE } from './tiers';
import {
    distance, inBounds, isOccupied, pathCost, pathFromSearch, searchMoves, destinations, samePos, terrainOf, tileAt,
} from './grid';
import { MAP_GENERATOR_VERSION, buildMapFromSeed, openArena, placeCombatants } from './mapBuilder';
import { resolveMapSpec } from './mapSpec';
import {
    canAttackWith, canTarget, closeDraft, currentActorId, currentTurn, DEFEND_CONDITION, dismissSummon, emit,
    freshTurn, hasCondition, hazardStrike, isPlayerSide, openDraft, settleOutcome, SHIELDED, STUNNED,
} from './core';
import type { Draft } from './core';
import { abilitySlot, checkAbility, resolveAbility, resolveStunt } from './glyphs/apply';
import { checkStunt } from './glyphs/stunt';
import { normalizeThrowPayload, pickUpItems } from './glyphs/throw';
import { BUILTIN_JUMP_ID, BUILTIN_SHOVE_ID, builtinAttack, builtinDefend, checkAttack } from './glyphs/builtins';
import type { AimResult } from './glyphs/targeting';
import {
    abandonFight, attemptFlee, buildMoraleBook, canAbandon, checkFlee, checkParley, concedeFight,
    PARLEY_INTENTS, PARLEY_RATINGS, resolveParley, rollMoraleIfDue,
} from './party';

const PARLEY_INTENT_SET: ReadonlySet<string> = new Set(PARLEY_INTENTS);
const PARLEY_RATING_SET: ReadonlySet<string> = new Set(PARLEY_RATINGS);
import { enemyKit } from './glyphs/kits';
import { planTurn } from './ai/plan';
import { normalizeTactic } from './ai/tactic';
import { defaultCastingAbility } from './glyphs/numbers';
import { objectiveRoundEnd, objectiveRoundStart, objectiveTurnBegins, objectiveTurnEnd } from './objectives/run';
import { planReinforcements, validateObjective } from './objectives/validate';
import { bystanderIdOf, leaderIdOf, wardIdOf } from './objectives/marks';
import type {
    AttackRange, CombatAction, CombatCondition, CombatEvent, CombatObjective, CombatSpec, CombatState, Combatant, CombatantSpec, GlyphAbility, Grid,
    ObjectiveReport, Pos, ReinforcementBook, ReinforcementWave, Rng, TurnState,
} from './types';

export { DEFEND_CONDITION, isHostile, canTarget, currentActorId, freshTurn, currentTurn, checkOutcome } from './core';
export { checkAttack } from './glyphs/builtins';
export type { AttackCheck } from './glyphs/builtins';

export { HAZARD_DAMAGE_DIE } from './core';

const MAX_ENGINE_ACTIONS = 2000;
const MAP_SEED_SALT = 0x5bd1e995;

function startTurn(draft: Draft): void {
    const id = currentActorId(draft.state);
    if (!id) return;
    const actor = draft.state.combatants[id];
    if (!actor) return;
    draft.state.turnCount = (draft.state.turnCount ?? 0) + 1;
    draft.state.turn = freshTurn(draft.state, id);
    if (actor.position) draft.state.turnStart = { actorId: id, pos: { ...actor.position } };
    else delete draft.state.turnStart;
    actor.conditions = actor.conditions.filter(c => c.id !== DEFEND_CONDITION);
    rollMoraleIfDue(draft, actor);
}

function endedText(c: Combatant, condition: string): string {
    return `${c.name} is no longer ${condition}.`;
}

function tickTurnConditions(draft: Draft, c: Combatant): void {
    const s = draft.state;
    const kept: CombatCondition[] = [];
    for (const cond of c.conditions) {
        if (typeof cond.turns !== 'number' || cond.appliedTurn === s.turnCount) {
            kept.push(cond);
            continue;
        }
        const turns = cond.turns - 1;
        if (turns > 0) {
            kept.push({ ...cond, turns });
            continue;
        }
        if (cond.id === SHIELDED) delete c.tempHp;
        emit(draft, { type: 'condition_ended', targetId: c.id, data: { condition: cond.id }, text: endedText(c, cond.id) });
    }
    c.conditions = kept;
}

function loseTurn(draft: Draft, c: Combatant): void {
    const s = draft.state;
    s.turnCount = (s.turnCount ?? 0) + 1;
    s.turn = { actorId: c.id, moveLeft: 0, actionUsed: true };
    c.conditions = c.conditions.filter(x => x.id !== DEFEND_CONDITION);
    emit(draft, { type: 'turn_lost', actorId: c.id, data: { condition: STUNNED }, text: `${c.name} is stunned and loses the turn.` });
    tickTurnConditions(draft, c);
    c.stunGuard = true;
}

function environmentStep(draft: Draft): void {
    const s = draft.state;
    const grid = s.grid;
    for (const id of s.order) {
        const c = s.combatants[id];
        if (!c || c.status !== 'up') continue;
        if (grid && c.position && tileAt(grid, c.position) === 'hazard') {
            hazardStrike(draft, c);
            if (c.status !== 'up') continue;
        }
        const kept: CombatCondition[] = [];
        for (const cond of c.conditions) {
            if (cond.id === DEFEND_CONDITION || typeof cond.turns === 'number') {
                kept.push(cond);
                continue;
            }
            const rounds = (cond.rounds ?? 1) - 1;
            if (rounds > 0) kept.push({ ...cond, rounds });
            else emit(draft, { type: 'condition_ended', targetId: c.id, data: { condition: cond.id }, text: endedText(c, cond.id) });
        }
        c.conditions = kept;
    }
    const nextRound = s.round + 1;
    for (const id of s.order) {
        const c = s.combatants[id];
        if (c && c.summonerId && c.status === 'up' && typeof c.expiresRound === 'number' && c.expiresRound <= nextRound) {
            dismissSummon(draft, c, 'expired');
        }
    }
    if (s.barriers && s.barriers.length > 0) {
        const ending = s.barriers.filter(b => b.expiresRound <= nextRound);
        if (ending.length > 0) {
            s.barriers = s.barriers.filter(b => b.expiresRound > nextRound);
            emit(draft, {
                type: 'barrier_ended',
                data: { tiles: ending.map(b => ({ ...b.pos })), expiresRound: ending[0].expiresRound },
                text: ending.length === 1 ? 'A barrier square fades.' : `${ending.length} barrier squares fade.`,
            });
        }
    }
}

function endOfTurn(draft: Draft, actorId: string): void {
    const c = draft.state.combatants[actorId];
    if (!c || c.status !== 'up') return;
    tickTurnConditions(draft, c);
    delete c.stunGuard;
}

function advanceTurn(draft: Draft): void {
    const s = draft.state;
    if (s.order.length === 0) return;
    const outgoing = currentActorId(s);
    if (outgoing && s.turn?.actorId === outgoing) {
        endOfTurn(draft, outgoing);
        if (s.objective) {
            objectiveTurnEnd(draft, outgoing);
            settleOutcome(draft);
            if (s.outcome) return;
        }
    }
    const bound = s.order.length * 8;
    for (let step = 0; step < bound; step++) {
        s.turnIndex += 1;
        if (s.turnIndex >= s.order.length) {
            s.turnIndex = 0;
            environmentStep(draft);
            settleOutcome(draft);
            if (s.outcome) return;
            if (s.objective) {
                objectiveRoundEnd(draft);
                if (s.outcome) return;
            }
            s.round += 1;
            emit(draft, { type: 'round', data: { round: s.round }, text: `Round ${s.round} begins.` });
            if (s.objective) objectiveRoundStart(draft);
        }
        const next = s.combatants[s.order[s.turnIndex]];
        if (!next || next.status !== 'up') continue;
        if (s.objective) {
            objectiveTurnBegins(draft, next.id);
            if (s.outcome) return;
        }
        if (hasCondition(next, STUNNED)) {
            loseTurn(draft, next);
            settleOutcome(draft);
            if (s.outcome) return;
            continue;
        }
        startTurn(draft);
        return;
    }
}

function rejection(state: CombatState, action: CombatAction, reason: string): { state: CombatState; events: CombatEvent[] } {
    return {
        state,
        events: [{
            seq: state.eventSeq + 1,
            round: state.round,
            turn: state.turnCount ?? 0,
            type: 'rejected',
            actorId: action?.actorId,
            data: { reason, action: action?.type },
            text: `Action rejected: ${reason}.`,
        }],
    };
}

export function moveSearchFor(state: CombatState, actorId: string, budget?: number) {
    const actor = state.combatants[actorId];
    if (!actor) return null;
    const turn = currentActorId(state) === actorId ? currentTurn(state) : freshTurn(state, actorId);
    const limit = budget ?? turn?.moveLeft ?? 0;
    return searchMoves(state, actorId, { budget: limit, avoidHazards: actor.controller === 'engine' });
}

export function reachable(state: CombatState, actorId: string): Array<Pos & { cost: number }> {
    const search = moveSearchFor(state, actorId);
    if (!search) return [];
    return destinations(search).map(({ x, y, cost }) => ({ x, y, cost }));
}

export function pathTo(state: CombatState, actorId: string, to: Pos): { path: Pos[]; cost: number } | null {
    const actor = state.combatants[actorId];
    const grid = terrainOf(state);
    if (!actor || !grid || !actor.position || !inBounds(grid, to) || samePos(actor.position, to)) return null;
    if (isOccupied(state, to, actorId)) return null;
    const search = moveSearchFor(state, actorId);
    let path = search ? pathFromSearch(search, to) : null;
    if (!path && actor.controller === 'engine') {
        const turn = currentActorId(state) === actorId ? currentTurn(state) : freshTurn(state, actorId);
        const plain = searchMoves(state, actorId, { budget: turn?.moveLeft ?? 0, avoidHazards: false });
        path = plain ? pathFromSearch(plain, to) : null;
    }
    if (!path || path.length === 0) return null;
    return { path, cost: pathCost(grid, path) };
}

function opponentsOf(state: CombatState, actor: Combatant): Combatant[] {
    return state.order.map(id => state.combatants[id]).filter(c => !!c && !!c.position && canTarget(actor, c));
}

function nearest(state: CombatState, actor: Combatant, at: Pos): { id: string; dist: number } | null {
    let best: { id: string; dist: number } | null = null;
    for (const o of opponentsOf(state, actor)) {
        const d = distance(at, o.position as Pos);
        if (!best || d < best.dist) best = { id: o.id, dist: d };
    }
    return best;
}

function moveData(state: CombatState, actor: Combatant, from: Pos, to: Pos): { towardId?: string; awayFromId?: string } {
    const after = nearest(state, actor, to);
    if (after && after.dist < distance(from, state.combatants[after.id].position as Pos)) return { towardId: after.id };
    const before = nearest(state, actor, from);
    if (before && distance(to, state.combatants[before.id].position as Pos) > before.dist) return { awayFromId: before.id };
    return {};
}

function moveText(state: CombatState, actor: Combatant, squares: number, rel: { towardId?: string; awayFromId?: string }): string {
    const unit = squares === 1 ? 'square' : 'squares';
    if (rel.towardId) return `${actor.name} moves ${squares} ${unit} toward ${state.combatants[rel.towardId].name}.`;
    if (rel.awayFromId) return `${actor.name} moves ${squares} ${unit} away from ${state.combatants[rel.awayFromId].name}.`;
    return `${actor.name} moves ${squares} ${unit}.`;
}

function hasAnyMove(state: CombatState, actorId: string): boolean {
    const search = moveSearchFor(state, actorId);
    return !!search && destinations(search).length > 0;
}

export function hasUsableBonusAbility(state: CombatState, actorId: string): boolean {
    const actor = state.combatants[actorId];
    if (!actor?.kit || actor.kit.length === 0) return false;
    return actor.kit.some(a => abilitySlot(a) === 'bonus' && checkAbility(state, actorId, a.id).ok);
}

export type ActionOptions = { driven?: boolean };

function hasUsableBuiltinBonus(state: CombatState, actorId: string): boolean {
    return [BUILTIN_SHOVE_ID, BUILTIN_JUMP_ID].some(id => checkAbility(state, actorId, id).ok);
}

function maybeAutoEnd(draft: Draft, actorId: string, driven = false): void {
    const s = draft.state;
    if (s.outcome || currentActorId(s) !== actorId) return;
    const turn = currentTurn(s);
    if (!turn || canAttackWith(turn)) return;
    if (turn.moveLeft > 0 && hasAnyMove(s, actorId)) return;
    if (!turn.bonusUsed && hasUsableBonusAbility(s, actorId)) return;
    if (driven && !turn.bonusUsed && hasUsableBuiltinBonus(s, actorId)) return;
    advanceTurn(draft);
}

function runAbility(state: CombatState, actorId: string, ability: GlyphAbility, aim: AimResult, driven: boolean): { state: CombatState; events: CombatEvent[] } {
    const draft = openDraft(state);
    resolveAbility(draft, actorId, ability, aim);
    settleOutcome(draft);
    maybeAutoEnd(draft, actorId, driven);
    return closeDraft(draft);
}

export function applyAction(state: CombatState, action: CombatAction, options: ActionOptions = {}): { state: CombatState; events: CombatEvent[] } {
    const driven = options.driven === true;
    if (state.outcome) return rejection(state, action, 'the fight is over');
    const actorId = currentActorId(state);
    const actor = actorId ? state.combatants[actorId] : undefined;
    if (!actor || !action || action.actorId !== actorId) return rejection(state, action, 'not this combatant\'s turn');
    if (actor.status !== 'up') return rejection(state, action, 'the combatant cannot act');
    const turn = currentTurn(state) as TurnState;

    if (action.type === 'attack') {
        if (!canAttackWith(turn)) return rejection(state, action, 'the action is already used');
        const target = state.combatants[action.targetId];
        if (!target || !canTarget(actor, target)) return rejection(state, action, 'invalid target');
        const check = checkAttack(state, actor.id, target.id);
        if (!check.ok) return rejection(state, action, check.reason === 'no_line_of_sight' ? 'no line of sight' : 'out of range');
        const aim: AimResult = {
            ok: true,
            tiles: target.position ? [{ ...target.position }] : [],
            targetIds: [target.id],
            ...(actor.position ? { origin: { ...actor.position } } : {}),
        };
        return runAbility(state, actor.id, builtinAttack(actor), aim, driven);
    }
    if (action.type === 'defend') {
        if (!canAttackWith(turn)) return rejection(state, action, 'the action is already used');
        const aim: AimResult = {
            ok: true,
            tiles: actor.position ? [{ ...actor.position }] : [],
            targetIds: [actor.id],
            ...(actor.position ? { origin: { ...actor.position } } : {}),
        };
        return runAbility(state, actor.id, builtinDefend(), aim, driven);
    }
    if (action.type === 'move') {
        const to = action.to;
        if (!state.grid || !actor.position || !to || typeof to.x !== 'number' || typeof to.y !== 'number') return rejection(state, action, 'cannot move here');
        const route = pathTo(state, actor.id, { x: to.x, y: to.y });
        if (!route || route.cost > turn.moveLeft) return rejection(state, action, 'that square cannot be reached');
        const draft = openDraft(state);
        const self = draft.state.combatants[actor.id];
        const from = { ...actor.position };
        const dest = { x: to.x, y: to.y };
        const rel = moveData(state, actor, from, dest);
        self.position = dest;
        draft.state.turn = { ...turn, moveLeft: turn.moveLeft - route.cost };
        emit(draft, {
            type: 'moved',
            actorId: actor.id,
            data: { from, to: dest, path: route.path, cost: route.cost, squares: route.path.length, ...rel },
            text: moveText(state, actor, route.path.length, rel),
        });
        pickUpItems(draft, self, route.path);
        maybeAutoEnd(draft, actor.id, driven);
        return closeDraft(draft);
    }
    if (action.type === 'use_ability') {
        const aim = action.aim && typeof action.aim.x === 'number' && typeof action.aim.y === 'number' ? { x: action.aim.x, y: action.aim.y } : null;
        const check = checkAbility(state, actor.id, action.abilityId, aim, normalizeThrowPayload(action.payload));
        if (!check.ok || !check.ability || !check.aim) return rejection(state, action, check.reason ?? 'the ability cannot be used');
        return runAbility(state, actor.id, check.ability, check.aim, driven);
    }
    if (action.type === 'flee') {
        const check = checkFlee(state, actor.id, turn);
        if (!check.ok) return rejection(state, action, `cannot flee: ${(check.reason ?? 'unavailable').replace(/_/g, ' ')}`);
        const draft = openDraft(state);
        draft.state.turn = { ...turn, actionUsed: true };
        const escaped = attemptFlee(draft, draft.state.combatants[actor.id]);
        settleOutcome(draft);
        if (escaped) {
            if (!draft.state.outcome) advanceTurn(draft);
        } else {
            maybeAutoEnd(draft, actor.id);
        }
        return closeDraft(draft);
    }
    if (action.type === 'abandon') {
        if (!canAbandon(state, actor.id)) return rejection(state, action, 'cannot abandon the fight now');
        const draft = openDraft(state);
        abandonFight(draft);
        return closeDraft(draft);
    }
    if (action.type === 'parley') {
        const check = checkParley(state, actor.id, turn);
        if (!check.ok) return rejection(state, action, `cannot parley: ${(check.reason ?? 'unavailable').replace(/_/g, ' ')}`);
        if (!PARLEY_INTENT_SET.has(action.intent) || !PARLEY_RATING_SET.has(action.rating)) return rejection(state, action, 'invalid parley');
        const draft = openDraft(state);
        draft.state.turn = { ...turn, actionUsed: true };
        resolveParley(draft, draft.state.combatants[actor.id], action);
        if (!draft.state.outcome) {
            settleOutcome(draft);
            maybeAutoEnd(draft, actor.id);
        }
        return closeDraft(draft);
    }
    if (action.type === 'stunt') {
        const check = checkStunt(state, actor.id, action.spec);
        if (!check.ok) return rejection(state, action, `cannot attempt the stunt: ${check.reason}`);
        const draft = openDraft(state);
        resolveStunt(draft, actor.id, check.plan);
        settleOutcome(draft);
        maybeAutoEnd(draft, actor.id, driven);
        return closeDraft(draft);
    }
    if (action.type === 'end_turn') {
        const draft = openDraft(state);
        const fresh = freshTurn(state, actor.id);
        const acted = turn.actionUsed || !!turn.bonusUsed || turn.moveLeft < fresh.moveLeft || (turn.extraActions ?? 0) < (fresh.extraActions ?? 0);
        emit(draft, { type: 'end_turn', actorId: actor.id, data: { acted }, text: acted ? `${actor.name} ends the turn.` : `${actor.name} holds.` });
        advanceTurn(draft);
        return closeDraft(draft);
    }
    return rejection(state, action, 'unknown action');
}

const BONUS_BUILTINS: ReadonlySet<string> = new Set([BUILTIN_SHOVE_ID, BUILTIN_JUMP_ID]);

export function chooseEngineTurn(state: CombatState, actorId: string): { actions: CombatAction[]; state: CombatState } {
    return { actions: planTurn(state, actorId).steps, state };
}

function bonusFollows(steps: readonly CombatAction[]): boolean {
    return steps.slice(1).some(s => s.type === 'use_ability' && BONUS_BUILTINS.has(s.abilityId));
}

export function stepEngine(state: CombatState): { state: CombatState; events: CombatEvent[] } | null {
    if (state.outcome) return null;
    const id = currentActorId(state);
    const actor = id ? state.combatants[id] : undefined;
    if (!actor) return null;
    if (actor.status !== 'up') {
        const draft = openDraft(state);
        advanceTurn(draft);
        return closeDraft(draft);
    }
    if (actor.controller === 'player') return null;
    const plan = planTurn(state, actor.id);
    const action = plan.steps[0] ?? { type: 'end_turn', actorId: actor.id };
    const result = applyAction(state, action, { driven: bonusFollows(plan.steps) });
    if (result.events.some(e => e.type === 'rejected')) return applyAction(state, { type: 'end_turn', actorId: actor.id });
    return result;
}

export function runEngineTurns(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    let current = state;
    const events: CombatEvent[] = [];
    for (let i = 0; i < MAX_ENGINE_ACTIONS; i++) {
        const step = stepEngine(current);
        if (!step) break;
        current = step.state;
        events.push(...step.events);
    }
    return { state: current, events };
}

export function deriveMapSeed(seed: number): number {
    return (Math.imul((seed >>> 0) ^ MAP_SEED_SALT, 2654435761) >>> 0);
}

function casterKitFields(c: { side: Combatant['side']; tier: Combatant['tier']; archetype?: Combatant['archetype'] }, abilities: Combatant['abilities'], damageType: string): Partial<Combatant> {
    if (c.side === 'neutral') return {};
    const kit = enemyKit(c.tier, c.archetype, damageType);
    if (kit.length === 0) return {};
    const row = TIER_TABLE[c.tier] ?? TIER_TABLE.grunt;
    return {
        kit,
        proficiency: proficiencyForLevel(TIER_LEVEL[c.tier] ?? 3),
        castingAbility: defaultCastingAbility(abilities),
        abilityDamage: { ...row.damage },
    };
}

function specCombatant(c: CombatantSpec, id: string, spec: CombatSpec, jitter: number, rng: Rng): Combatant {
        const block = buildTierBlock(c.tier, c.archetype, jitter, rng, c.look);
        const t = c.template;
        let maxHp = block.maxHp;
        let ac = block.ac;
        let attackBonus = block.attackBonus;
        let damage = block.damage;
        if (t?.mode === 'replace') {
            if (t.maxHp !== undefined) maxHp = t.maxHp;
            if (t.ac !== undefined) ac = t.ac;
            if (t.attackBonus !== undefined) attackBonus = t.attackBonus;
            if (t.damage) damage = { ...t.damage, type: block.damage.type };
        } else if (t?.mode === 'floor') {
            if (t.maxHp !== undefined) maxHp = Math.max(maxHp, t.maxHp);
            if (t.ac !== undefined) ac = Math.max(ac, t.ac);
        }
        const range: AttackRange = c.range ?? (c.archetype === 'caster' ? 'ranged' : 'close');
        return {
            id,
            name: c.name,
            side: c.side,
            controller: c.side === 'ally' && spec.partyControl === 'player' ? 'player' : 'engine',
            tier: c.tier,
            ...(c.archetype ? { archetype: c.archetype } : {}),
            ...(c.npcId ? { npcId: c.npcId } : {}),
            ...(c.species ? { species: c.species } : {}),
            ...(c.look ? { look: c.look } : {}),
            ...(c.manner ? { manner: c.manner } : {}),
            ...(c.speech ? { speech: c.speech } : {}),
            ...(normalizeTactic(c.tactic) ? { tactic: normalizeTactic(c.tactic) } : {}),
            abilities: block.abilities,
            maxHp: Math.max(1, Math.round(maxHp)),
            hp: Math.max(1, Math.round(maxHp)),
            ac,
            attackBonus,
            damage,
            initiative: 0,
            status: 'up',
            conditions: [],
            range,
            ...(t?.weaknesses && t.weaknesses.length > 0 ? { weaknesses: [...t.weaknesses] } : {}),
            ...(t?.resistances && t.resistances.length > 0 ? { resistances: [...t.resistances] } : {}),
            ...casterKitFields(c, block.abilities, damage.type),
        };
}

function markUnits(combatants: Record<string, Combatant>, objective: CombatObjective): void {
    const leaderId = leaderIdOf(objective);
    const wardId = wardIdOf(objective);
    const bystanderId = bystanderIdOf(objective);
    if (leaderId && combatants[leaderId]) combatants[leaderId].mark = 'leader';
    if (wardId && combatants[wardId]) combatants[wardId] = { ...combatants[wardId], mark: 'ward', tactic: 'coward' };
    if (bystanderId && combatants[bystanderId]) combatants[bystanderId].mark = 'bystander';
}

function setUpObjective(
    spec: CombatSpec, combatants: Record<string, Combatant>, grid: Grid, jitter: number, rng: Rng,
): { objective: CombatObjective; book?: ReinforcementBook; report: ObjectiveReport } {
    const setup = {
        grid,
        combatants: Object.values(combatants).map(c => ({
            id: c.id, name: c.name, side: c.side, tier: c.tier, ...(c.position ? { position: c.position } : {}), ...(c.speed !== undefined ? { speed: c.speed } : {}),
        })),
    };
    const checked = validateObjective(spec.objective ?? { win: 'rout' }, setup);
    const planned = planReinforcements(spec.reinforcements, checked.objective, spec.combatants, setup);
    const repairs = [...checked.repairs, ...planned.repairs];
    markUnits(combatants, checked.objective);
    let book: ReinforcementBook | undefined;
    if (planned.plan) {
        let n = 0;
        const waves: ReinforcementWave[] = planned.plan.waves.map(w => ({
            id: w.id,
            trigger: w.trigger,
            edge: w.edge,
            units: w.combatants.map(cs => {
                n += 1;
                let id = `r${n}`;
                while (combatants[id]) id = `${id}_`;
                const unit = specCombatant(cs, id, spec, jitter, rng);
                unit.initiative = rng.roll(20) + abilityMod(unit.abilities.DEX);
                return unit;
            }),
        }));
        book = { budget: planned.plan.budget, waves };
    }
    const report: ObjectiveReport = { objective: checked.objective, ...(book ? { reinforcements: book } : {}), repairs };
    return { objective: checked.objective, ...(book ? { book } : {}), report };
}

export function createCombat(spec: CombatSpec, pc: Combatant, seed: number): { state: CombatState; events: CombatEvent[]; objective?: ObjectiveReport } {
    const rng = createRng(seed, 0);
    const jitter = spec.jitterRange ?? DEFAULT_JITTER_RANGE;
    const combatants: Record<string, Combatant> = {};
    const pcEntry: Combatant = { ...pc, status: 'up', conditions: [], initiative: 0 };
    combatants[pcEntry.id] = pcEntry;
    spec.combatants.forEach((c, index) => {
        let id = c.id && !combatants[c.id] ? c.id : `c${index + 1}`;
        while (combatants[id]) id = `${id}_`;
        combatants[id] = specCombatant(c, id, spec, jitter, rng);
    });

    const tiebreak: Record<string, number> = {};
    for (const c of Object.values(combatants)) {
        c.initiative = rng.roll(20) + abilityMod(c.abilities.DEX);
        tiebreak[c.id] = rng.next();
    }
    const order = Object.values(combatants)
        .sort((a, b) => (b.initiative - a.initiative) || (b.abilities.DEX - a.abilities.DEX) || (tiebreak[b.id] - tiebreak[a.id]))
        .map(c => c.id);

    const mapSeed = Number.isFinite(spec.mapSeed) ? (spec.mapSeed as number) >>> 0 : deriveMapSeed(seed);
    const mapVersion = Number.isFinite(spec.mapVersion) ? (spec.mapVersion as number) : MAP_GENERATOR_VERSION;
    const grid = spec.map ? buildMapFromSeed(resolveMapSpec(spec.map, { combatants: spec.combatants.length }), mapSeed, mapVersion) : openArena('medium');
    const positions = placeCombatants(grid, Object.values(combatants).map(c => ({ id: c.id, side: c.side })));
    for (const [id, pos] of Object.entries(positions)) combatants[id].position = pos;
    for (const c of Object.values(combatants)) c.startHp = c.hp;
    const objective = spec.objective !== undefined || spec.reinforcements !== undefined ? setUpObjective(spec, combatants, grid, jitter, rng) : null;

    const state: CombatState = {
        id: spec.id,
        round: 1,
        order,
        turnIndex: 0,
        combatants,
        rngSeed: seed,
        rngCursor: rng.cursor,
        eventSeq: 0,
        outcome: null,
        grid,
        mapSeed,
        ...(spec.map && mapVersion !== 1 ? { mapVersion } : {}),
        turnCount: 0,
        ...(Number.isFinite(spec.maxSummons) ? { maxSummons: Math.max(0, Math.floor(spec.maxSummons as number)) } : {}),
        ...(spec.partyControl ? { partyControl: spec.partyControl } : {}),
        ...(spec.defeatMode ? { defeatMode: spec.defeatMode } : {}),
        ...(objective ? { objective: objective.objective } : {}),
        ...(objective?.book ? { reinforcements: objective.book } : {}),
    };
    state.morale = buildMoraleBook(state);
    const draft: Draft = { state, rng, events: [] };
    const roster = order.map(id => state.combatants[id]);
    emit(draft, {
        type: 'combat_started',
        data: { combatants: roster.map(c => ({ id: c.id, name: c.name, side: c.side, tier: c.tier })) },
        text: `Combat begins. ${roster.filter(c => isPlayerSide(c.side)).map(c => c.name).join(', ')} against ${roster.filter(c => !isPlayerSide(c.side)).map(c => c.name).join(', ')}.`,
    });
    emit(draft, {
        type: 'initiative',
        data: { order: roster.map(c => ({ id: c.id, initiative: c.initiative })) },
        text: `Initiative: ${roster.map(c => `${c.name} ${c.initiative}`).join(', ')}.`,
    });
    if (state.objective) objectiveRoundStart(draft);
    startTurn(draft);
    const closed = closeDraft(draft);
    return objective ? { ...closed, objective: objective.report } : closed;
}

export function concedeCombat(state: CombatState): { state: CombatState; events: CombatEvent[] } {
    if (state.outcome) return { state, events: [] };
    const draft = openDraft(state);
    concedeFight(draft);
    return closeDraft(draft);
}

export type HpBand = 'unhurt' | 'hurt' | 'badly_hurt' | 'down' | 'fled' | 'yielded';

export function hpBand(c: Pick<Combatant, 'hp' | 'maxHp' | 'status'>): HpBand {
    if (c.status === 'fled' || c.status === 'escaped') return 'fled';
    if (c.status === 'surrendered') return 'yielded';
    if (c.status !== 'up' || c.hp <= 0) return 'down';
    if (c.hp >= c.maxHp) return 'unhurt';
    return c.hp * 2 > c.maxHp ? 'hurt' : 'badly_hurt';
}
