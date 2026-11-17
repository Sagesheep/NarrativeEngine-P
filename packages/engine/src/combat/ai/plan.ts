import {
    canAttackWith, canTarget, currentActorId, currentTurn, DEFEND_CONDITION, FEARED, freshTurn, hasCondition, HASTED, isPlayerSide, playerCharacterOf,
    SLOWED, SNARED, STUNNED, VANISHED,
} from '../core';
import { delayedPayload } from '../glyphs/apply';
import { mantleOf, placedCovers, seenSigils, zonesAgainst } from '../glyphs/placed';
import { dimBonus, expectedMarkHarm, marksOf } from '../glyphs/marks';
import { TILE_MARKS } from '../elements/marks';
import {
    canStep, coverBetween, destinations, distance, distanceField, hasLineOfSight, inBounds, isWalkable, pathFromSearch, rangeOf, sameTeam, searchMoves, speedOf,
    stepCostAt, terrainOf, tileAt, traceLine,
} from '../grid';
import type { MoveSearch } from '../grid';
import { checkFlee, isEdgeTile, isRetreating, teamOfSide } from '../party';
import {
    abilityRoll, BUILTIN_DASH_ID, BUILTIN_JUMP_ID, BUILTIN_SHOVE_ID, BUILTIN_THROW_ID, builtinDash, builtinHelp, builtinJump, builtinShove,
    builtinThrow, checkAttack, leapRange, recoverable, strengthMod, tooLargeToShove,
} from '../glyphs/builtins';
import { abilityReadiness, usesMp } from '../glyphs/apply';
import {
    burstRadius, burstRange, casterStats, decayDice, drainDice, gravitySquares, healDice, isDelayed, mantleRadius, proficiencyOf, projectileRange,
    pushDistance, saveDc, saveModifier, shieldAmount,
} from '../glyphs/numbers';
import { DISPEL_HARMFUL, DISPEL_HELPFUL, EFFECTS, GLYPH_NUMBERS, UNSTUNNABLE_TIERS } from '../glyphs/registry';
import { abilityTargets, tileEffectOf } from '../glyphs/targeting';
import { previewPush } from '../glyphs/push';
import { payloadChoices, previewThrow, throwRangeOf } from '../glyphs/throw';
import { abilityCost } from '../glyphs/validate';
import type {
    CombatAction, CombatState, Combatant, ElementId, GlyphAbility, Grid, OrderKind, PlacedEffect, PlanIntent, Pos, Tactic, ThrowPayload, TurnPlan, TurnState,
} from '../types';
import {
    abilityFactor, atLeast, averageOf, betterSaveModifier, critChance, effectiveHp, hasAreaKit, hitChance, kitDice, riderValue, saveFails,
    shootsFar, shoveDc, threatOf,
} from './estimate';
import { abilityDamageType, abilityElement, blindPenalty, isImmune, revealedCover } from '../elements/rules';
import { ELEMENTS } from '../elements/tables';
import type { Dice } from './estimate';
import { AI_LIMITS, AI_SKIP_EFFECTS, AI_SKIP_FORMS, AI_WEIGHTS, ALL_TERMS, AUTOPILOT_DEPTH, GLYPH_AI_VALUES, TACTIC_PROFILES, TIER_DEPTH } from './tables';
import type { TacticProfile, TermId } from './tables';
import { tacticOf } from './tactic';
import { hasLose, leaderExitsOf, leaderIdOf, mainWin, objectiveClock, wardIdOf } from '../objectives/marks';
import { OBJECTIVE_WEIGHTS } from '../objectives/tables';
import { activeOrder } from '../director/orders';
import { ORDER_LIMITS, ORDER_PROFILES } from '../director/tables';
import type { OrderProfile } from '../director/tables';

type Weights = Record<TermId, number>;

type OrdCtx = {
    kind: OrderKind;
    profile: OrderProfile;
    target?: Combatant;
    sigId?: string;
};

type Ctx = {
    state: CombatState;
    actor: Combatant;
    id: string;
    turn: TurnState;
    tactic: Tactic;
    profile: TacticProfile;
    w: Weights;
    terrain: Grid;
    opponents: Combatant[];
    allies: Combatant[];
    fallen: Combatant[];
    threat: Map<string, number>;
    far: Set<string>;
    ref: Pos;
    weak: boolean;
    winning: boolean;
    fragility: number;
    areaFoes: boolean;
    protectee?: Combatant;
    goal?: Combatant;
    goalField?: number[];
    lane: Set<number>;
    allyFront: number;
    maxOppHp: number;
    nearestFoe: number;
    engage: number;
    pc?: Combatant;
    posCache: Map<number, number>;
    kitReady: GlyphAbility[];
    burstAims: Map<string, BurstAim[]>;
    useCache: Map<string, Option>;
    weaponCache: Map<string, number>;
    allowThrow: boolean;
    obj?: ObjCtx;
    ord?: OrdCtx;
    seen?: Set<number>;
    harm?: Map<number, number>;
    zones?: PlacedEffect[];
    fear?: { id: string; at: Pos };
};

type ObjCtx = {
    pull: number;
    pullField?: number[];
    guardField?: number[];
    runnerField?: number[];
    screen?: Combatant;
    wards: Set<string>;
    wardId?: string;
    focus?: string;
};

type Option = { steps: CombatAction[]; value: number; intent: PlanIntent; hostile: boolean };

type Candidate = {
    tile: Pos;
    cost: number;
    score: number;
    order: number;
    lead: CombatAction[];
    option: Option | null;
    bonus: Option | null;
};

const EMPTY_STEPS: CombatAction[] = [];

const HOSTILE_EFFECTS: ReadonlySet<string> = new Set(['damage', 'drain', 'push', 'pull', 'stun', 'slow', 'swap', 'snare', 'fear', 'decay', 'gravity']);

function moveReach(o: Combatant): number {
    return o.conditions.length > 0 && hasCondition(o, SNARED) ? 0 : speedOf(o);
}

const weightCache = new Map<string, Weights>();

function weightsFor(actor: Combatant, profile: TacticProfile): Weights {
    const depth = actor.controller === 'player' ? AUTOPILOT_DEPTH : actor.tier;
    const key = `${depth}|${TACTICS_KEY.get(profile) ?? ''}`;
    const hit = weightCache.get(key);
    if (hit) return hit;
    const w = buildWeights(depth, profile);
    weightCache.set(key, w);
    return w;
}

const TACTICS_KEY = new Map<TacticProfile, string>(Object.entries(TACTIC_PROFILES).map(([k, v]) => [v, k]));

function buildWeights(depth: Combatant['tier'], profile: TacticProfile): Weights {
    const on = new Set<TermId>([...(TIER_DEPTH[depth] ?? TIER_DEPTH.grunt), ...profile.on]);
    for (const t of profile.off) on.delete(t);
    const w = {} as Weights;
    for (const t of ALL_TERMS) w[t] = on.has(t) ? AI_WEIGHTS[t] * (profile.scale[t] ?? 1) : 0;
    return w;
}

export function termsFor(actor: Combatant): TermId[] {
    const profile = TACTIC_PROFILES[tacticOf(actor)];
    const w = weightsFor(actor, profile);
    return ALL_TERMS.filter(t => w[t] > 0);
}

function indexOf(grid: Grid, p: Pos): number {
    return p.y * grid.width + p.x;
}

const fieldCache = new WeakMap<Grid, Map<number, number[]>>();

function fieldFrom(grid: Grid, from: Pos): number[] {
    let byStart = fieldCache.get(grid);
    if (!byStart) {
        byStart = new Map();
        fieldCache.set(grid, byStart);
    }
    const key = indexOf(grid, from);
    const hit = byStart.get(key);
    if (hit) return hit;
    const total = grid.width * grid.height;
    const dist = new Array<number>(total).fill(Infinity);
    dist[key] = 0;
    const buckets: number[][] = [[key]];
    for (let d = 0; d < buckets.length; d++) {
        const bucket = buckets[d];
        if (!bucket) continue;
        for (const i of bucket) {
            if (dist[i] !== d) continue;
            const here = { x: i % grid.width, y: Math.floor(i / grid.width) };
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const next = { x: here.x + dx, y: here.y + dy };
                    if (!canStep(grid, here, next)) continue;
                    const j = indexOf(grid, next);
                    const nd = d + stepCostAt(grid, next);
                    if (nd < dist[j]) {
                        dist[j] = nd;
                        (buckets[nd] ??= []).push(j);
                    }
                }
            }
        }
    }
    byStart.set(key, dist);
    return dist;
}

function at(c: Combatant): Pos {
    return c.position as Pos;
}

function withPosition(state: CombatState, id: string, p: Pos): CombatState {
    const c = state.combatants[id];
    if (c.position && c.position.x === p.x && c.position.y === p.y) return state;
    return { ...state, combatants: { ...state.combatants, [id]: { ...c, position: { x: p.x, y: p.y } } } };
}

function reachOf(c: Combatant): number {
    const r = rangeOf(c);
    return r === 'reach' ? 2 : 1;
}

function huntScore(ctx: Ctx, t: Combatant): number {
    const frac = ctx.maxOppHp > 0 ? effectiveHp(t) / ctx.maxOppHp : 1;
    const isolated = !ctx.opponents.some(o => o.id !== t.id && distance(at(o), at(t)) <= 2);
    return (1 - frac) + (isolated ? 0.5 : 0);
}

function nearProtectee(ctx: Ctx, t: Combatant): boolean {
    return !!ctx.protectee && distance(at(t), at(ctx.protectee)) <= AI_LIMITS.guardRadius;
}

function stealable(ctx: Ctx, t: Combatant): boolean {
    const pc = ctx.pc;
    if (!pc || ctx.actor.side !== 'ally' || pc.status !== 'up' || !pc.position || !t.position) return false;
    return distance(pc.position, t.position) <= 1 && effectiveHp(t) <= averageOf(pc.damage);
}

function adjacentAllies(ctx: Ctx, t: Combatant): number {
    let n = 0;
    for (const a of ctx.allies) if (distance(at(a), at(t)) <= 1) n++;
    return n;
}

function objectiveBonus(ctx: Ctx, t: Combatant): number {
    const o = ctx.obj;
    if (!o) return 0;
    let b = o.wards.has(t.id) ? OBJECTIVE_WEIGHTS.ward : 0;
    if (o.focus === t.id) b += OBJECTIVE_WEIGHTS.leaderFocus;
    if (o.runnerField && t.position) {
        const d = o.runnerField[indexOf(ctx.terrain, t.position)];
        if (Number.isFinite(d)) b += OBJECTIVE_WEIGHTS.runner * Math.max(0, OBJECTIVE_WEIGHTS.runnerRadius - d);
    }
    return b;
}

function orderBonus(ctx: Ctx, t: Combatant): number {
    const o = ctx.ord;
    return o && o.kind === 'focus' && o.target?.id === t.id ? o.profile.focusBonus ?? 0 : 0;
}

function orderWeights(base: Weights, profile: OrderProfile): Weights {
    const w = { ...base };
    for (const t of profile.on) if (w[t] <= 0) w[t] = AI_WEIGHTS[t];
    for (const t of profile.off) w[t] = 0;
    for (const [t, k] of Object.entries(profile.scale)) w[t as TermId] *= k as number;
    return w;
}

function orderCtx(state: CombatState, actor: Combatant, opponents: Combatant[], allies: Combatant[]): OrdCtx | undefined {
    const order = activeOrder(state, actor);
    if (!order) return undefined;
    const profile = ORDER_PROFILES[order.kind];
    const target = order.targetId ? state.combatants[order.targetId] : undefined;
    if (order.kind === 'focus') {
        if (!target || !opponents.some(o => o.id === target.id)) return undefined;
        return { kind: order.kind, profile, target };
    }
    if (order.kind === 'protect') {
        if (!target || target.status !== 'up' || !target.position || !allies.some(a => a.id === target.id)) return undefined;
        return { kind: order.kind, profile, target };
    }
    if (order.kind === 'signature') {
        if (!actor.signature || actor.signature.usesLeft <= 0) return undefined;
        return { kind: order.kind, profile, sigId: actor.signature.abilityId };
    }
    return { kind: order.kind, profile };
}

function appeal(ctx: Ctx, t: Combatant): number {
    const w = ctx.w;
    const th = ctx.threat.get(t.id) ?? 0;
    return 1 + objectiveBonus(ctx, t) + orderBonus(ctx, t) + w.threat * th / 2 + w.finish * (1 - t.hp / Math.max(1, t.maxHp)) * 2 + w.hunt * huntScore(ctx, t)
        + (nearProtectee(ctx, t) ? w.protect * th : 0) + (t.hp < t.maxHp ? w.focus : 0);
}

function targetValue(ctx: Ctx, t: Combatant, expected: number, kill: number): number {
    const w = ctx.w;
    const th = ctx.threat.get(t.id) ?? 0;
    const capped = Math.min(expected, effectiveHp(t));
    let v = w.damage * capped
        + w.kill * kill * (2 + th)
        + w.threat * capped * th / 10
        + w.finish * capped * (1 - t.hp / Math.max(1, t.maxHp))
        + (w.focus > 0 ? w.focus * capped * ((t.hp < t.maxHp ? 0.5 : 0) + 0.25 * adjacentAllies(ctx, t)) : 0);
    if (hasCondition(t, DEFEND_CONDITION)) v -= w.defended;
    if (w.proximity > 0) v -= w.proximity * (distance(ctx.ref, at(t)) - ctx.nearestFoe);
    if (w.hunt > 0) v += w.hunt * huntScore(ctx, t);
    if (w.protect > 0 && nearProtectee(ctx, t)) v += w.protect * th / 2;
    if (w.steal > 0 && stealable(ctx, t)) v -= w.steal;
    if (ctx.obj) v += objectiveBonus(ctx, t);
    if (ctx.ord) v += orderBonus(ctx, t);
    return v;
}

function weaponOdds(attackBonus: number, dice: Dice, ac: number, disadvantage: boolean, hp: number): { expected: number; kill: number } {
    const p = hitChance(attackBonus, ac, disadvantage);
    const crit = Math.min(p, critChance(disadvantage));
    const double = { ...dice, count: dice.count * 2 };
    return {
        expected: (p - crit) * averageOf(dice) + crit * averageOf(double),
        kill: (p - crit) * atLeast(dice, hp) + crit * atLeast(double, hp),
    };
}

function incoming(ctx: Ctx, p: Pos): number {
    let total = 0;
    for (const o of ctx.opponents) {
        const d = distance(at(o), p);
        const th = ctx.threat.get(o.id) ?? 0;
        if (ctx.far.has(o.id)) {
            if (d <= 12 + moveReach(o)) total += th;
        } else if (d <= moveReach(o) + reachOf(o)) {
            total += th;
        }
    }
    return total;
}

function positionScore(ctx: Ctx, p: Pos): number {
    const idx = indexOf(ctx.terrain, p);
    const cached = ctx.posCache.get(idx);
    if (cached !== undefined) return cached;
    const w = ctx.w;
    const grid = ctx.terrain;
    let s = 0;
    const tile = tileAt(grid, p);
    if (tile === 'hazard') s -= w.hazard * AI_LIMITS.hazardHit;
    let adjacent = 0;
    let shelter = 0;
    let nearestMelee = Infinity;
    let nearestAny = Infinity;
    for (const o of ctx.opponents) {
        const d = distance(at(o), p);
        nearestAny = Math.min(nearestAny, d);
        if (d <= 1) adjacent++;
        const th = ctx.threat.get(o.id) ?? 0;
        if (ctx.far.has(o.id)) {
            if (w.cover > 0 && d <= 12) {
                const open = hitChance(o.attackBonus, ctx.actor.ac, false);
                const shield = hasLineOfSight(grid, at(o), p) ? coverBetween(grid, at(o), p) : 2;
                const shot = hitChance(o.attackBonus, ctx.actor.ac + shield, false);
                shelter += w.cover * th * (1 - shot / open) * ctx.fragility;
            }
        } else {
            nearestMelee = Math.min(nearestMelee, d);
            if (w.exposure > 0 && ctx.weak && d <= moveReach(o) + reachOf(o)) s -= w.exposure * th * ctx.fragility;
        }
    }
    if (ctx.engage > 1 || nearestAny <= ctx.engage) s += shelter;
    if (w.hazardEdge > 0 && tile !== 'hazard' && nearestAny <= 2) {
        let edge = false;
        for (let dy = -1; dy <= 1 && !edge; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                if ((dx || dy) && tileAt(grid, { x: p.x + dx, y: p.y + dy }) === 'hazard' && inBounds(grid, { x: p.x + dx, y: p.y + dy })) {
                    edge = true;
                    break;
                }
            }
        }
        if (edge) s -= w.hazardEdge;
    }
    if (w.swarm > 0 && adjacent > 1) s -= w.swarm * (adjacent - 1) * (effectiveHp(ctx.actor) >= 20 ? 0.5 : 1) * ctx.fragility;
    if (w.kite > 0 && Number.isFinite(nearestMelee)) {
        s += w.kite * Math.min(AI_LIMITS.kiteCap, nearestMelee - 1);
        if (nearestMelee <= 1) s -= w.kite * 2;
    }
    if (w.clump > 0 && ctx.areaFoes) {
        for (const a of ctx.allies) if (distance(at(a), p) <= 2) s -= w.clump;
    }
    if (w.lane > 0 && ctx.lane.has(idx)) s -= w.lane;
    if (w.escape > 0 && ctx.weak) {
        let free = 0;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const q = { x: p.x + dx, y: p.y + dy };
                if ((!dx && !dy) || !isWalkable(grid, q)) continue;
                if (ctx.opponents.some(o => distance(at(o), q) <= 1) || ctx.allies.some(a => a.position?.x === q.x && a.position?.y === q.y)) continue;
                free++;
            }
        }
        s += w.escape * Math.min(2, free);
    }
    if (w.post > 0 && ctx.protectee) s -= w.post * Math.max(0, distance(p, at(ctx.protectee)) - AI_LIMITS.guardRadius);
    if (w.behind > 0 && Number.isFinite(ctx.allyFront) && Number.isFinite(nearestAny)) s -= w.behind * Math.max(0, ctx.allyFront - nearestAny);
    if (w.progress > 0 && ctx.goalField) {
        const d = ctx.goalField[idx];
        s -= w.progress * (Number.isFinite(d) ? Math.max(0, Math.min(d, 60) - ctx.engage) : 60);
    }
    const o = ctx.obj;
    if (o) {
        if (o.pullField) {
            const d = o.pullField[idx];
            s -= o.pull * (Number.isFinite(d) ? Math.min(d, 60) : 60);
        }
        if (o.guardField) {
            const d = o.guardField[idx];
            s -= OBJECTIVE_WEIGHTS.guardTile * Math.max(0, (Number.isFinite(d) ? Math.min(d, 60) : 60) - OBJECTIVE_WEIGHTS.guardRadius);
        }
        if (o.screen?.position) s -= OBJECTIVE_WEIGHTS.screen * Math.max(0, distance(p, o.screen.position) - AI_LIMITS.guardRadius);
    }
    if (ctx.seen && ctx.seen.has(idx)) s -= w.hazard * AI_LIMITS.hazardHit;
    if (ctx.harm) s -= w.hazard * (ctx.harm.get(idx) ?? 0);
    if (ctx.zones) {
        for (const z of ctx.zones) if (placedCovers(ctx.state, z, p)) s -= w.hazard * AI_LIMITS.hazardHit * GLYPH_AI_VALUES.zoneShare;
    }
    if (ctx.fear) s += GLYPH_AI_VALUES.fearPull * distance(p, ctx.fear.at);
    const ord = ctx.ord;
    if (ord) {
        const pr = ord.profile;
        if (pr.holdPenalty) s -= pr.holdPenalty * distance(p, ctx.ref);
        if (pr.awayPull && Number.isFinite(nearestAny)) s += pr.awayPull * Math.min(ORDER_LIMITS.awayCap, nearestAny);
        if (pr.allyPull && ctx.allies.length > 0) {
            let nearestAlly = Infinity;
            for (const a of ctx.allies) nearestAlly = Math.min(nearestAlly, distance(at(a), p));
            s -= pr.allyPull * Math.min(ORDER_LIMITS.allyCap, Math.max(0, nearestAlly - 1));
        }
    }
    ctx.posCache.set(idx, s);
    return s;
}

function attackStep(ctx: Ctx, t: Combatant): CombatAction {
    return { type: 'attack', actorId: ctx.id, targetId: t.id };
}

function weaponOptions(ctx: Ctx, p: Pos, out: Option[]): boolean {
    const actor = ctx.actor;
    if (!canAttackWith(ctx.turn)) return false;
    let any = false;
    const slowed = hasCondition(actor, SLOWED);
    for (const t of ctx.opponents) {
        const check = checkAttack(ctx.state, ctx.id, t.id, p);
        if (!check.ok) continue;
        any = true;
        const dis = check.disadvantage || hasCondition(t, DEFEND_CONDITION) || slowed;
        const key = `${t.id}|${check.cover}|${dis ? 1 : 0}`;
        let base = ctx.weaponCache.get(key);
        if (base === undefined) {
            const odds = weaponOdds(actor.attackBonus - blindPenalty(actor), actor.damage, t.ac + check.cover, dis, effectiveHp(t));
            base = targetValue(ctx, t, odds.expected, odds.kill);
            ctx.weaponCache.set(key, base);
        }
        let value = base;
        if (ctx.w.surround > 0 && check.range !== 'ranged') {
            const tp = at(t);
            const flank = ctx.allies.some(a => distance(at(a), tp) <= 1 && (p.x - tp.x) * (at(a).x - tp.x) + (p.y - tp.y) * (at(a).y - tp.y) < 0);
            if (flank) value += ctx.w.surround;
        }
        out.push({ steps: [attackStep(ctx, t)], value, intent: { kind: 'attack', targetId: t.id }, hostile: true });
    }
    return any;
}

function isFriendly(ctx: Ctx, c: Combatant): boolean {
    return c.id === ctx.id || sameTeam(ctx.actor.side, c.side) || (c.mark === 'bystander' && isPlayerSide(ctx.actor.side));
}

function abilityUse(ctx: Ctx, p: Pos, cast: GlyphAbility, targets: Combatant[], aim: Pos | null, cacheKey = '', scales?: Record<string, number>): Option | null {
    const actor = ctx.actor;
    const w = ctx.w;
    const delayed = isDelayed(cast);
    const ability = delayed ? delayedPayload(cast) : cast;
    const stats = casterStats(actor);
    const roll = abilityRoll(ability);
    const form = ability.form.id;
    const pierce = ability.form.augments.includes('pierce');
    const helpfulOnly = ability.effects.every(e => EFFECTS[e.id].helpful);
    const type = abilityDamageType(ability, 'force');
    const element = abilityElement(ability);
    const saveAgainst = element ? ELEMENTS[element].saveAgainst : undefined;
    const dcBonus = element ? ELEMENTS[element].dcBonus ?? 0 : 0;
    const armourIgnored = element ? ELEMENTS[element].ignoresArmour ?? 0 : 0;
    const blind = blindPenalty(actor);
    const hostileChain = ability.effects.some(e => HOSTILE_EFFECTS.has(e.id));
    const adjacentShot = form === 'projectile' && ctx.opponents.some(o => distance(at(o), p) <= 1);
    const covers = targets.map(t => {
        if (roll !== 'attack' || helpfulOnly || !t.position || isFriendly(ctx, t)) return 0;
        const terrainCover = form === 'projectile' && !pierce ? revealedCover(t, coverBetween(ctx.terrain, p, t.position)) : 0;
        return terrainCover + dimBonus(ctx.state, p, t.position);
    });
    const movable = ability.effects.some(e => e.id === 'push' || e.id === 'pull');
    const key = movable || !cacheKey ? '' : `${cacheKey}|${adjacentShot ? 1 : 0}|${covers.join(',')}`;
    if (key) {
        const hit = ctx.useCache.get(key);
        if (hit) return hit;
    }
    let value = 0;
    let hostileHit = false;
    let hurtsFriend = false;
    let primary: Combatant | null = null;
    let primaryKind: PlanIntent['kind'] = 'attack';
    let best = -Infinity;
    for (let ti = 0; ti < targets.length; ti++) {
        const t = targets[ti];
        const friendly = isFriendly(ctx, t);
        let pHit = 1;
        if (roll === 'attack' && !friendly) {
            if (saveAgainst) {
                pHit = isImmune(t, element as ElementId) ? 1 : saveFails(saveDc(stats) + dcBonus, saveModifier(t, saveAgainst));
            } else {
                const cover = covers[ti];
                const dis = hasCondition(t, DEFEND_CONDITION) || adjacentShot || hasCondition(actor, SLOWED);
                pHit = hitChance(stats.proficiency + stats.castingMod - blind, t.ac + cover - armourIgnored, dis);
            }
        }
        let mine = 0;
        let kind: PlanIntent['kind'] = 'attack';
        let expectedHere = 0;
        let riderLand = 0;
        for (const effect of ability.effects) {
            const base = roll === 'save' ? EFFECTS[effect.id].save : undefined;
            const key = base && saveAgainst ? saveAgainst : base;
            const pFail = key ? saveFails(saveDc(stats) + dcBonus, saveModifier(t, key)) : 1;
            const land = roll === 'attack' ? pHit : pFail;
            switch (effect.id) {
                case 'damage':
                case 'drain': {
                    const dice = effect.id === 'damage' ? kitDice(actor, ability, effect.augments) : { count: drainDice(stats, effect.augments), sides: 6, bonus: 0 };
                    const factor = abilityFactor(t, ability, type);
                    const avg = averageOf(dice) * factor;
                    const expected = key ? avg * (pFail + (1 - pFail) / 2) : pHit * avg;
                    expectedHere += expected;
                    riderLand = Math.max(riderLand, key ? 1 : pHit);
                    if (friendly) {
                        mine -= w.friendlyFire * expected * (t.side === 'player' ? 2 : 1);
                        hurtsFriend = true;
                    } else {
                        const need = Math.ceil(effectiveHp(t) / factor);
                        const kill = key ? pFail * atLeast(dice, need) + (1 - pFail) * atLeast(dice, need * 2) : pHit * atLeast(dice, need);
                        mine += targetValue(ctx, t, expected, kill);
                        if (effect.id === 'drain') mine += w.support * Math.min(expected / 2, actor.maxHp - actor.hp);
                    }
                    break;
                }
                case 'heal': {
                    const amount = healDice(stats, effect.augments) * 2.5 + stats.castingMod;
                    const missing = t.maxHp - t.hp;
                    const v = Math.min(amount, missing) * (t.hp * 2 <= t.maxHp ? 1.5 : 1);
                    mine += friendly ? w.support * v : -v;
                    if (friendly) kind = 'support';
                    break;
                }
                case 'shield': {
                    const amount = shieldAmount(stats, effect.augments);
                    if (friendly && (t.tempHp ?? 0) < amount && t.position) {
                        mine += w.support * Math.min(amount, 5) * (incoming(ctx, t.position) > 0 ? 1 : 0.4);
                        kind = 'support';
                    }
                    break;
                }
                case 'haste':
                    if (friendly && !hasCondition(t, HASTED)) {
                        mine += w.support * (ctx.threat.get(t.id) ?? 0) * 0.8;
                        kind = 'support';
                    }
                    break;
                case 'stun':
                    if (!friendly && !t.stunGuard && !hasCondition(t, STUNNED)) {
                        mine += land * w.control * (ctx.threat.get(t.id) ?? 0) * (UNSTUNNABLE_TIERS.has(t.tier) ? 0.4 : 1);
                        if (!hostileHit) kind = 'control';
                    }
                    break;
                case 'slow':
                    if (!friendly && !hasCondition(t, SLOWED)) {
                        mine += land * w.control * (ctx.threat.get(t.id) ?? 0) * 0.4;
                        if (!hostileHit) kind = 'control';
                    }
                    break;
                case 'push':
                case 'pull':
                    if (!friendly) {
                        const moved = withPosition(ctx.state, ctx.id, p);
                        const plan = previewPush(moved, ctx.id, t.id, effect.id, pushDistance(effect.augments), aim && form === 'burst' ? { origin: aim } : {});
                        if (plan && plan.hazards.length > 0) mine += land * w.control * AI_LIMITS.hazardHit * 2;
                        else if (plan && plan.squares > 0) mine += land * w.control * expectedMarkHarm(ctx.state, t, plan.landing) * 2;
                    }
                    break;
                case 'gravity':
                    if (!friendly && aim && t.position) {
                        const moved = withPosition(ctx.state, ctx.id, p);
                        const squares = Math.min(gravitySquares(effect.augments), distance(t.position, aim));
                        const plan = squares > 0 ? previewPush(moved, ctx.id, t.id, 'pull', squares, { origin: aim }) : null;
                        if (plan && plan.hazards.length > 0) mine += land * w.control * AI_LIMITS.hazardHit * 2;
                        else if (plan && plan.squares > 0) mine += land * w.control * expectedMarkHarm(ctx.state, t, plan.landing) * 2;
                        if (plan && plan.squares > 0) mine += land * w.control * (ctx.threat.get(t.id) ?? 0) * GLYPH_AI_VALUES.gravity;
                    }
                    break;
                case 'snare':
                    if (!friendly && !hasCondition(t, SNARED)) {
                        mine += land * w.control * (ctx.threat.get(t.id) ?? 0) * (shootsFar(ctx.state, t) ? GLYPH_AI_VALUES.snareShooter : GLYPH_AI_VALUES.snare);
                        if (!hostileHit) kind = 'control';
                    }
                    break;
                case 'fear':
                    if (!friendly && !hasCondition(t, FEARED)) {
                        mine += land * w.control * (ctx.threat.get(t.id) ?? 0) * GLYPH_AI_VALUES.fear;
                        if (!hostileHit) kind = 'control';
                    }
                    break;
                case 'decay':
                    if (!friendly) {
                        const dice = { count: decayDice(stats, effect.augments), sides: GLYPH_NUMBERS.decaySides, bonus: 0 };
                        const room = Math.max(0, t.maxHp - Math.ceil((t.maxHp + (t.decayed ?? 0)) * GLYPH_NUMBERS.decayFloor));
                        const expected = land * Math.min(averageOf(dice), room);
                        mine += targetValue(ctx, t, expected, land * atLeast(dice, Math.max(1, effectiveHp(t))));
                        riderLand = Math.max(riderLand, land);
                    }
                    break;
                case 'dispel': {
                    if (friendly) {
                        let v = 0;
                        for (const c of t.conditions) if (DISPEL_HARMFUL.includes(c.id)) v += c.id === STUNNED ? GLYPH_AI_VALUES.dispelStun : GLYPH_AI_VALUES.dispelOther;
                        if (v > 0) {
                            mine += w.support * v;
                            kind = 'support';
                        }
                    } else {
                        let v = 0;
                        for (const c of t.conditions) {
                            if (!DISPEL_HELPFUL.includes(c.id)) continue;
                            v += c.id === HASTED ? GLYPH_AI_VALUES.dispelHaste : c.id === 'shielded' ? Math.min(5, (t.tempHp ?? 0) / 2) : GLYPH_AI_VALUES.dispelOther;
                        }
                        mine += land * w.control * v;
                    }
                    break;
                }
                case 'vanish':
                    if (friendly && t.id === ctx.id && !hasCondition(t, VANISHED)) {
                        mine += w.support * incoming(ctx, p) * GLYPH_AI_VALUES.vanish * (ctx.weak ? 1.5 : 1);
                        kind = 'support';
                    }
                    break;
                case 'rewind':
                    if (friendly && t.id === ctx.id && t.rewind) {
                        const back = Math.min(t.maxHp, t.rewind.hp) - t.hp;
                        if (back > 0) {
                            mine += w.support * back;
                            kind = 'support';
                        }
                    }
                    break;
                default:
                    break;
            }
        }
        const share = (scales?.[t.id] ?? 1) * (delayed ? (hasCondition(t, SNARED) || hasCondition(t, STUNNED) ? 1 : GLYPH_AI_VALUES.delayStay) : 1);
        if (share !== 1) {
            mine *= share;
            expectedHere *= share;
        }
        if (element && !friendly && hostileChain) {
            const land = riderLand > 0 ? riderLand : roll === 'attack' ? pHit : 0.5;
            const arcTargets = ctx.opponents.filter(o => o.id !== t.id && !!t.position && !!o.position && distance(o.position, t.position) <= 1).length;
            mine += riderValue(t, ability, { land, expected: expectedHere, arcTargets, control: w.control, damage: w.damage });
        }
        if (!friendly && mine > 0) hostileHit = true;
        value += mine;
        if (mine > best) {
            best = mine;
            primary = t;
            primaryKind = kind;
        }
    }
    if (ability.effects.some(e => e.id === 'summon')) value += w.support * AI_LIMITS.summonValue;
    const cost = usesMp(actor) ? abilityCost(cast) : 2;
    value -= w.economy * cost * (ctx.winning ? 2 : 1);
    if (ctx.ord?.sigId === ability.id && !hurtsFriend && (hostileHit || value > 0)) value += ctx.ord.profile.signatureBonus ?? 0;
    const step: CombatAction = { type: 'use_ability', actorId: ctx.id, abilityId: ability.id, aim: aim ? { x: aim.x, y: aim.y } : null };
    const intent: PlanIntent = primary ? { kind: primaryKind, targetId: primary.id } : { kind: 'support' };
    const result = { steps: [step], value, intent, hostile: hostileHit };
    if (key) ctx.useCache.set(key, result);
    return result;
}

type BurstAim = { aim: Pos; hits: string[]; value: number };

function burstAimsOf(ctx: Ctx, ability: GlyphAbility): BurstAim[] {
    const hit = ctx.burstAims.get(ability.id);
    if (hit) return hit;
    const out: BurstAim[] = [];
    const seen = new Set<number>();
    const r = burstRadius(ability);
    const grid = ctx.terrain;
    for (const o of ctx.opponents) {
        for (let dy = -r; dy <= r; dy++) {
            for (let dx = -r; dx <= r; dx++) {
                const aim = { x: at(o).x + dx, y: at(o).y + dy };
                if (!isWalkable(grid, aim)) continue;
                const key = indexOf(grid, aim);
                if (seen.has(key)) continue;
                seen.add(key);
                const hits: string[] = [];
                for (const id of ctx.state.order) {
                    const c = ctx.state.combatants[id];
                    if (!c || c.status !== 'up' || !c.position || c.id === ctx.id) continue;
                    if (distance(c.position, aim) <= r && hasLineOfSight(grid, aim, c.position)) hits.push(c.id);
                }
                if (!hits.some(id => !isFriendly(ctx, ctx.state.combatants[id]))) continue;
                const base = abilityUse(ctx, aim, ability, hits.map(id => ctx.state.combatants[id]), aim, `${ability.id}|b${aim.x},${aim.y}|0`);
                out.push({ aim, hits, value: base ? base.value : -Infinity });
            }
        }
    }
    out.sort((a, b) => b.value - a.value);
    ctx.burstAims.set(ability.id, out);
    return out;
}

function kitOptions(ctx: Ctx, p: Pos, out: Option[]): void {
    if (ctx.kitReady.length === 0) return;
    const grid = ctx.terrain;
    let moved: CombatState | null = null;
    const movedState = () => (moved ??= withPosition(ctx.state, ctx.id, p));
    for (const ability of ctx.kitReady) {
        const form = ability.form.id;
        const tileEffect = tileEffectOf(ability);
        if (AI_SKIP_FORMS.has(form) || ability.effects.some(e => AI_SKIP_EFFECTS.has(e.id))) continue;
        if (form === 'mantle') {
            if (mantleOf(ctx.state, ctx.id)) continue;
            const r = mantleRadius(ability);
            const hostile = ability.effects.some(e => EFFECTS[e.id].hostile);
            const pool = hostile ? ctx.opponents : [ctx.actor, ...ctx.allies];
            const inside = pool.filter(t => distance(t.id === ctx.id ? p : at(t), p) <= r);
            if (inside.length === 0) continue;
            const use = abilityUse(ctx, p, ability, inside, p);
            if (use) out.push(use);
            continue;
        }
        if (form === 'self') {
            const use = abilityUse(ctx, p, ability, [ctx.actor], null);
            if (use) out.push(use);
            continue;
        }
        if (tileEffect === 'summon') {
            if (form !== 'touch') continue;
            const spot = summonSpot(ctx, p, movedState());
            if (!spot) continue;
            const use = abilityUse(ctx, p, ability, [], spot);
            if (use) out.push(use);
            continue;
        }
        if (form === 'burst') {
            const range = burstRange(ability);
            const r = burstRadius(ability);
            let found = -Infinity;
            for (const { aim, hits, value } of burstAimsOf(ctx, ability)) {
                if (value <= found) break;
                if (distance(p, aim) > range || !hasLineOfSight(grid, p, aim)) continue;
                const targets = hits.map(id => ctx.state.combatants[id]);
                const self = distance(p, aim) <= r && hasLineOfSight(grid, aim, p);
                if (self) targets.push(ctx.actor);
                const use = abilityUse(ctx, p, ability, targets, aim, `${ability.id}|b${aim.x},${aim.y}|${self ? 1 : 0}`);
                if (use) {
                    out.push(use);
                    found = Math.max(found, use.value);
                }
            }
            continue;
        }
        if (form === 'line' || form === 'cone') {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (!dx && !dy) continue;
                    const aim = { x: p.x + dx, y: p.y + dy };
                    const res = abilityTargets(movedState(), ctx.id, ability, aim);
                    if (!res.ok || res.targetIds.length === 0) continue;
                    const use = abilityUse(ctx, p, ability, res.targetIds.map(id => ctx.state.combatants[id]), aim);
                    if (use) out.push(use);
                }
            }
            continue;
        }
        const helpful = ability.effects.every(e => EFFECTS[e.id].helpful);
        const either = !helpful && ability.effects.every(e => EFFECTS[e.id].helpful || EFFECTS[e.id].either);
        const pool = either ? [...ctx.allies, ...ctx.opponents] : helpful ? ctx.allies : ctx.opponents;
        const simple = (form === 'projectile' || form === 'touch') && !ability.form.augments.includes('pierce') && !ability.form.augments.includes('split');
        for (const t of pool) {
            const tp = t.id === ctx.id ? p : at(t);
            if (t.id === ctx.id) continue;
            if (simple) {
                if (form === 'touch' && distance(p, tp) !== 1) continue;
                if (form === 'projectile' && (distance(p, tp) > projectileRange(ability) || distance(p, tp) === 0 || !hasLineOfSight(grid, p, tp))) continue;
                const use = abilityUse(ctx, p, ability, [t], tp, `${ability.id}|t${t.id}`);
                if (use) out.push(use);
                continue;
            }
            const res = abilityTargets(movedState(), ctx.id, ability, tp);
            if (!res.ok) continue;
            const use = abilityUse(ctx, p, ability, res.targetIds.map(id => ctx.state.combatants[id]), tp, '', res.scales);
            if (use) out.push(use);
        }
    }
}

function summonSpot(ctx: Ctx, p: Pos, moved: CombatState): Pos | null {
    const grid = ctx.terrain;
    let best: Pos | null = null;
    let bestD = Infinity;
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const q = { x: p.x + dx, y: p.y + dy };
            if (!isWalkable(grid, q)) continue;
            if (Object.values(moved.combatants).some(c => c.status !== 'gone' && c.status !== 'fled' && c.position?.x === q.x && c.position?.y === q.y)) continue;
            const d = ctx.goal ? distance(q, at(ctx.goal)) : 0;
            if (d < bestD) {
                bestD = d;
                best = q;
            }
        }
    }
    return best;
}

function throwOptions(ctx: Ctx, p: Pos, out: Option[]): void {
    const w = ctx.w;
    if (w.throw <= 0 || abilityReadiness(ctx.state, ctx.actor, builtinThrow(), ctx.turn)) return;
    if (hasCondition(ctx.actor, STUNNED)) return;
    let source = false;
    for (let dy = -1; dy <= 1 && !source; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            if ((dx || dy) && tileAt(ctx.terrain, { x: p.x + dx, y: p.y + dy }) === 'cover') {
                source = true;
                break;
            }
        }
    }
    if (!source) source = ctx.state.order.some(id => {
        const c = ctx.state.combatants[id];
        return !!c && c.id !== ctx.id && !!c.position && distance(c.position, p) === 1 && (c.status === 'down' || (ctx.profile.throwsAllies === true && c.status === 'up'));
    });
    if (!source) return;
    const moved = withPosition(ctx.state, ctx.id, p);
    const actor = moved.combatants[ctx.id];
    for (const choice of payloadChoices(moved, ctx.id)) {
        const payload: ThrowPayload = choice.payload;
        if (payload.kind === 'hand' || payload.kind === 'item') continue;
        if (payload.kind === 'creature') {
            const c = moved.combatants[payload.id];
            if (!c) continue;
            const body = c.status === 'down';
            const ally = c.status === 'up' && sameTeam(actor.side, c.side) && c.tier === 'minion';
            if (!body && !(ally && ctx.profile.throwsAllies)) continue;
        }
        const range = throwRangeOf(actor, choice.weight);
        for (const t of ctx.opponents) {
            if (distance(p, at(t)) > range) continue;
            const preview = previewThrow(moved, ctx.id, payload, at(t));
            if (!preview.ok || preview.plan.struckId !== t.id) continue;
            const plan = preview.plan;
            const besides = ctx.opponents.some(o => o.id !== plan.creatureId && distance(at(o), p) <= 1);
            const dis = hasCondition(t, DEFEND_CONDITION) || besides || hasCondition(actor, SLOWED);
            const bonus = proficiencyOf(actor) + strengthMod(actor);
            const odds = weaponOdds(bonus, plan.damage, t.ac + plan.cover, dis, effectiveHp(t));
            const value = w.throw * targetValue(ctx, t, odds.expected, odds.kill);
            out.push({
                steps: [{ type: 'use_ability', actorId: ctx.id, abilityId: BUILTIN_THROW_ID, aim: { ...at(t) }, payload }],
                value,
                intent: { kind: 'attack', targetId: t.id },
                hostile: true,
            });
        }
    }
}

function helpOptions(ctx: Ctx, p: Pos, out: Option[]): void {
    const w = ctx.w;
    if (w.help <= 0 || abilityReadiness(ctx.state, ctx.actor, builtinHelp(), ctx.turn)) return;
    const candidates = [...ctx.fallen, ...ctx.allies.filter(a => hasCondition(a, STUNNED) || hasCondition(a, SLOWED))];
    if (candidates.length === 0) return;
    let moved: CombatState | null = null;
    for (const a of candidates) {
        if (!a.position || distance(p, a.position) !== 1) continue;
        moved ??= withPosition(ctx.state, ctx.id, p);
        if (!abilityTargets(moved, ctx.id, builtinHelp(), a.position).ok) continue;
        const th = ctx.threat.get(a.id) ?? 0;
        const value = a.status === 'down' ? w.help * (2 * th + 3) : w.help * th * (hasCondition(a, STUNNED) ? 1.5 : 0.5);
        out.push({
            steps: [{ type: 'use_ability', actorId: ctx.id, abilityId: builtinHelp().id, aim: { ...a.position } }],
            value,
            intent: { kind: 'support', targetId: a.id },
            hostile: false,
        });
    }
}

function defendOption(ctx: Ctx, p: Pos, out: Option[]): void {
    const w = ctx.w;
    if (w.defend <= 0 || !canAttackWith(ctx.turn)) return;
    const guarding = (ctx.tactic === 'guard' || ctx.ord?.profile.guarding === true) && !!ctx.protectee;
    if (!ctx.weak && !guarding) return;
    const value = w.defend * incoming(ctx, p) * 0.5 + (guarding ? w.defend : 0);
    if (value <= 0) return;
    out.push({ steps: [{ type: 'defend', actorId: ctx.id }], value, intent: { kind: 'guard', ...(ctx.protectee ? { targetId: ctx.protectee.id } : {}) }, hostile: false });
}

function bestOption(ctx: Ctx, p: Pos): Option | null {
    if (!canAttackWith(ctx.turn)) return null;
    const out: Option[] = [];
    const weapon = weaponOptions(ctx, p, out);
    if (!ctx.turn.actionUsed) kitOptions(ctx, p, out);
    if (!weapon && ctx.allowThrow) throwOptions(ctx, p, out);
    helpOptions(ctx, p, out);
    defendOption(ctx, p, out);
    let best: Option | null = null;
    for (const o of out) if (o.value > 0 && (!best || o.value > best.value)) best = o;
    return best;
}

function shoveOption(ctx: Ctx, p: Pos, bonusFree: boolean): Option | null {
    const w = ctx.w;
    if (w.shove <= 0 || !bonusFree || abilityReadiness(ctx.state, ctx.actor, builtinShove(), ctx.turn)) return null;
    const near = ctx.opponents.filter(o => distance(at(o), p) === 1 && !tooLargeToShove(o));
    if (near.length === 0) return null;
    const moved = withPosition(ctx.state, ctx.id, p);
    const dc = shoveDc(ctx.actor);
    let best: Option | null = null;
    for (const o of near) {
        const plan = previewPush(moved, ctx.id, o.id, 'push', pushDistance([]), { origin: p, strike: true });
        if (!plan || plan.squares === 0) continue;
        const th = ctx.threat.get(o.id) ?? 0;
        let v = 0;
        if (plan.hazards.length > 0) {
            const landed = tileAt(ctx.terrain, plan.landing) === 'hazard';
            v += plan.hazards.length * AI_LIMITS.hazardHit * (landed ? 2 : 1);
            v += w.kill * atLeast({ count: plan.hazards.length, sides: 6, bonus: 0 }, effectiveHp(o)) * (2 + th);
        } else {
            v += expectedMarkHarm(ctx.state, o, plan.landing) * 2;
        }
        if (ctx.protectee && distance(at(o), at(ctx.protectee)) <= 1 && distance(plan.landing, at(ctx.protectee)) > 1) v += th * 0.8;
        for (const a of ctx.allies) {
            if (!a.position) continue;
            if (shootsFar(ctx.state, a)) {
                const before = hasLineOfSight(ctx.terrain, a.position, at(o)) ? coverBetween(ctx.terrain, a.position, at(o)) : 0;
                const after = hasLineOfSight(ctx.terrain, a.position, plan.landing) ? coverBetween(ctx.terrain, a.position, plan.landing) : 0;
                if (before > after) v += (before - after) / 5 * (ctx.threat.get(a.id) ?? 0);
            }
            if (distance(a.position, at(o)) <= 1 && distance(a.position, plan.landing) > 1 && (a.hp * 2 <= a.maxHp || shootsFar(ctx.state, a))) v += th * 0.5;
        }
        if (shootsFar(ctx.state, ctx.actor)) v += th * 0.3;
        const value = w.shove * saveFails(dc, betterSaveModifier(o)) * v;
        if (value < AI_LIMITS.shoveMin) continue;
        if (!best || value > best.value) {
            best = {
                steps: [{ type: 'use_ability', actorId: ctx.id, abilityId: BUILTIN_SHOVE_ID, aim: { ...at(o) } }],
                value,
                intent: { kind: 'control', targetId: o.id },
                hostile: true,
            };
        }
    }
    return best;
}

function better(a: Candidate, b: Candidate | null): boolean {
    if (!b) return true;
    if (a.score !== b.score) return a.score > b.score;
    if (a.cost !== b.cost) return a.cost < b.cost;
    if (a.tile.y !== b.tile.y) return a.tile.y < b.tile.y;
    if (a.tile.x !== b.tile.x) return a.tile.x < b.tile.x;
    return a.order < b.order;
}

function tilesFrom(ctx: Ctx, state: CombatState, budget: number): Array<Pos & { cost: number }> {
    const actor = state.combatants[ctx.id];
    const here = { x: at(actor).x, y: at(actor).y, cost: 0 };
    if (budget <= 0) return [here];
    const search = searchMoves(state, ctx.id, { budget, avoidHazards: ctx.actor.controller === 'engine' });
    const all = [here, ...(search ? destinations(search).map(d => ({ x: d.x, y: d.y, cost: d.cost })) : [])];
    const fear = ctx.fear;
    if (!fear) return all;
    const start = distance(here, fear.at);
    return all.filter(t => distance(t, fear.at) >= start);
}

function moveStep(ctx: Ctx, from: Pos, to: Pos): CombatAction[] {
    return from.x === to.x && from.y === to.y ? EMPTY_STEPS : [{ type: 'move', actorId: ctx.id, to: { x: to.x, y: to.y } }];
}

function evaluateTiles(ctx: Ctx, state: CombatState, budget: number, opts: { act: boolean; bonus: boolean; lead: CombatAction[]; order: number }): Candidate | null {
    let best: Candidate | null = null;
    let order = opts.order;
    for (const tile of tilesFrom(ctx, state, budget)) {
        const option = opts.act ? bestOption(ctx, tile) : null;
        const bonus = shoveOption(ctx, tile, opts.bonus);
        const score = positionScore(ctx, tile) + (option?.value ?? 0) + (bonus?.value ?? 0);
        const cand: Candidate = { tile, cost: tile.cost, score, order: order++, lead: opts.lead, option, bonus };        if (better(cand, best)) best = cand;
    }
    return best;
}

function postMove(ctx: Ctx, state: CombatState, from: Pos, budget: number): Pos | null {
    const gate = ctx.w.reposition > 0 ? ctx.w.reposition : ctx.obj?.pullField ? OBJECTIVE_WEIGHTS.goal / 2 : 0;
    if (gate <= 0 || budget <= 0) return null;
    const base = positionScore(ctx, from);
    let best: { tile: Pos; score: number; cost: number } | null = null;
    for (const tile of tilesFrom(ctx, state, budget)) {
        const score = positionScore(ctx, tile);
        if (!best || score > best.score || (score === best.score && (tile.cost < best.cost || (tile.cost === best.cost && (tile.y < best.tile.y || (tile.y === best.tile.y && tile.x < best.tile.x)))))) {
            best = { tile, score, cost: tile.cost };
        }
    }
    if (!best || best.score - base < gate) return null;
    return best.tile.x === from.x && best.tile.y === from.y ? null : best.tile;
}

function finish(ctx: Ctx, steps: CombatAction[], intent: PlanIntent): TurnPlan {
    return { actorId: ctx.id, tactic: ctx.tactic, steps: [...steps, { type: 'end_turn', actorId: ctx.id }], intent };
}

function reposition(ctx: Ctx, tile: Pos): PlanIntent {
    return { kind: 'reposition', ...(ctx.goal ? { targetId: ctx.goal.id } : {}), destination: { x: tile.x, y: tile.y } };
}

function fullTurn(ctx: Ctx): TurnPlan {
    const here = at(ctx.actor);
    const bonusFree = !ctx.turn.bonusUsed;
    let best = evaluateTiles(ctx, ctx.state, ctx.turn.moveLeft, { act: true, bonus: bonusFree, lead: EMPTY_STEPS, order: 0 });
    if (!best?.option?.hostile && ctx.w.throw > 0) {
        ctx.allowThrow = true;
        best = evaluateTiles(ctx, ctx.state, ctx.turn.moveLeft, { act: true, bonus: bonusFree, lead: EMPTY_STEPS, order: 0 });
    }
    const engaged = !!best?.option?.hostile;
    if (!engaged && ctx.w.jump > 0 && bonusFree && !ctx.fear) {
        const jump = jumpCandidate(ctx);
        if (jump && better(jump, best)) best = jump;
    }
    if (!engaged && ctx.w.dash > 0 && ctx.goal && ctx.goalField && !abilityReadiness(ctx.state, ctx.actor, builtinDash(), ctx.turn)) {
        const gap = ctx.goalField[indexOf(ctx.terrain, here)] - ctx.engage;
        const speed = freshTurn(ctx.state, ctx.id).moveLeft;
        if (Number.isFinite(gap) && gap > 2 * speed) {
            const dash: CombatAction = { type: 'use_ability', actorId: ctx.id, abilityId: BUILTIN_DASH_ID, aim: null };
            const dashed = evaluateTiles(ctx, ctx.state, ctx.turn.moveLeft + speed, { act: false, bonus: bonusFree, lead: [dash], order: 100000 });
            if (dashed && better(dashed, best)) best = dashed;
        }
    }
    if (!best) return finish(ctx, EMPTY_STEPS, { kind: 'guard' });
    const from = best.lead.some(s => s.type === 'use_ability' && s.abilityId === BUILTIN_JUMP_ID)
        ? (best.lead.find(s => s.type === 'use_ability' && s.abilityId === BUILTIN_JUMP_ID) as { aim: Pos }).aim
        : here;
    const steps: CombatAction[] = [...best.lead, ...moveStep(ctx, from, best.tile)];
    if (best.option) steps.push(...best.option.steps);
    if (best.bonus) steps.push(...best.bonus.steps);
    if (best.option) {
        const moved = withPosition(ctx.state, ctx.id, best.tile);
        const usedJump = best.lead.length > 0 ? distance(here, from) : 0;
        const left = ctx.turn.moveLeft - usedJump - best.cost;
        const after = postMove(ctx, moved, best.tile, left);
        if (after) steps.push(...moveStep(ctx, best.tile, after));
    }
    const intent = best.option?.intent ?? best.bonus?.intent ?? reposition(ctx, best.tile);
    return finish(ctx, steps, intent);
}

function jumpCandidate(ctx: Ctx): Candidate | null {
    const here = at(ctx.actor);
    if (abilityReadiness(ctx.state, ctx.actor, builtinJump(), ctx.turn)) return null;
    const range = Math.min(leapRange(ctx.actor), ctx.turn.moveLeft);
    if (range < 1) return null;
    const walk: MoveSearch | null = searchMoves(ctx.state, ctx.id, { budget: ctx.turn.moveLeft, avoidHazards: ctx.actor.controller === 'engine' });
    let top: { tile: Pos; score: number } | null = null;
    for (let dy = -range; dy <= range; dy++) {
        for (let dx = -range; dx <= range; dx++) {
            const tile = { x: here.x + dx, y: here.y + dy };
            if ((!dx && !dy) || !inBounds(ctx.terrain, tile)) continue;
            const walked = walk ? walk.cost[indexOf(ctx.terrain, tile)] : Infinity;
            if (walked <= distance(here, tile)) continue;
            if (!abilityTargets(ctx.state, ctx.id, builtinJump(), tile).ok) continue;
            const option = bestOption(ctx, tile);
            if (!option?.hostile) continue;
            const score = positionScore(ctx, tile) + option.value;
            if (!top || score > top.score || (score === top.score && (tile.y < top.tile.y || (tile.y === top.tile.y && tile.x < top.tile.x)))) top = { tile, score };
        }
    }
    if (!top) return null;
    const jump: CombatAction = { type: 'use_ability', actorId: ctx.id, abilityId: BUILTIN_JUMP_ID, aim: { ...top.tile } };
    const landed = withPosition(ctx.state, ctx.id, top.tile);
    return evaluateTiles(ctx, landed, ctx.turn.moveLeft - distance(here, top.tile), { act: true, bonus: false, lead: [jump], order: 200000 });
}

function afterAction(ctx: Ctx): TurnPlan {
    const here = at(ctx.actor);
    if (ctx.turn.dashed) {
        const best = evaluateTiles(ctx, ctx.state, ctx.turn.moveLeft, { act: false, bonus: !ctx.turn.bonusUsed, lead: EMPTY_STEPS, order: 0 });
        if (!best) return finish(ctx, EMPTY_STEPS, { kind: 'reposition' });
        const steps = [...moveStep(ctx, here, best.tile), ...(best.bonus?.steps ?? [])];
        return finish(ctx, steps, best.bonus?.intent ?? reposition(ctx, best.tile));
    }
    const bonus = shoveOption(ctx, here, !ctx.turn.bonusUsed);
    const after = postMove(ctx, ctx.state, here, ctx.turn.moveLeft);
    const steps = [...(bonus?.steps ?? []), ...(after ? moveStep(ctx, here, after) : [])];
    return finish(ctx, steps, bonus?.intent ?? (after ? reposition(ctx, after) : { kind: 'guard' }));
}

function standAndStrike(ctx: Ctx): TurnPlan {
    if (!canAttackWith(ctx.turn)) return finish(ctx, EMPTY_STEPS, { kind: 'retreat' });
    const out: Option[] = [];
    weaponOptions(ctx, at(ctx.actor), out);
    let best: Option | null = null;
    for (const o of out) if (!best || o.value > best.value) best = o;
    return finish(ctx, best ? best.steps : EMPTY_STEPS, { kind: 'retreat', ...(best?.intent.targetId ? { targetId: best.intent.targetId } : {}) });
}

function retreatTurn(ctx: Ctx): TurnPlan | null {
    const here = at(ctx.actor);
    const grid = ctx.terrain;
    if (checkFlee(ctx.state, ctx.id, ctx.turn).ok) return finish(ctx, [{ type: 'flee', actorId: ctx.id }], { kind: 'retreat' });
    if (isEdgeTile(grid, here)) return standAndStrike(ctx);
    const open = searchMoves(ctx.state, ctx.id, { budget: Infinity, avoidHazards: true });
    if (!open) return null;
    let goal: (Pos & { cost: number; weight: number }) | null = null;
    for (const d of destinations(open)) {
        if (!isEdgeTile(grid, d)) continue;
        if (!goal || d.weight < goal.weight || (d.weight === goal.weight && (d.cost < goal.cost || (d.cost === goal.cost && (d.y < goal.y || (d.y === goal.y && d.x < goal.x)))))) goal = d;
    }
    if (!goal) return null;
    if (ctx.turn.moveLeft <= 0) return standAndStrike(ctx);
    const path = pathFromSearch(open, goal) ?? [];
    const stopWithin = (budget: number): Pos | null => {
        let stop: Pos | null = null;
        for (const p of path) {
            if (open.cost[indexOf(grid, p)] > budget) break;
            if (!ctx.state.order.some(id => {
                const c = ctx.state.combatants[id];
                return c && c.id !== ctx.id && c.status === 'up' && c.position?.x === p.x && c.position?.y === p.y;
            })) stop = p;
        }
        return stop;
    };
    const stop = stopWithin(ctx.turn.moveLeft);
    const speed = freshTurn(ctx.state, ctx.id).moveLeft;
    if (ctx.w.dash > 0 && goal.cost > ctx.turn.moveLeft && !ctx.turn.dashed && !abilityReadiness(ctx.state, ctx.actor, builtinDash(), ctx.turn)) {
        const far = stopWithin(ctx.turn.moveLeft + speed);
        if (far) {
            return finish(ctx, [{ type: 'use_ability', actorId: ctx.id, abilityId: BUILTIN_DASH_ID, aim: null }, ...moveStep(ctx, here, far)], { kind: 'retreat', destination: { ...far } });
        }
    }
    if (stop) {
        const steps = moveStep(ctx, here, stop);
        if (isEdgeTile(grid, stop) && canAttackWith(ctx.turn)) {
            const out: Option[] = [];
            weaponOptions(ctx, stop, out);
            let best: Option | null = null;
            for (const o of out) if (!best || o.value > best.value) best = o;
            if (best) return finish(ctx, [...steps, ...best.steps], { kind: 'retreat', destination: { ...stop }, ...(best.intent.targetId ? { targetId: best.intent.targetId } : {}) });
        }
        return finish(ctx, steps, { kind: 'retreat', destination: { ...stop } });
    }
    return standAndStrike(ctx);
}

function gridless(ctx: Ctx): TurnPlan {
    if (!canAttackWith(ctx.turn) || ctx.opponents.length === 0) return finish(ctx, EMPTY_STEPS, { kind: 'guard' });
    let best: { t: Combatant; v: number } | null = null;
    for (const t of ctx.opponents) {
        const odds = weaponOdds(ctx.actor.attackBonus, ctx.actor.damage, t.ac, hasCondition(t, DEFEND_CONDITION), effectiveHp(t));
        const v = targetValue(ctx, t, odds.expected, odds.kill);
        if (!best || v > best.v) best = { t, v };
    }
    return best ? finish(ctx, [attackStep(ctx, best.t)], { kind: 'attack', targetId: best.t.id }) : finish(ctx, EMPTY_STEPS, { kind: 'guard' });
}

function protecteeOf(state: CombatState, actor: Combatant, wardId?: string): Combatant | undefined {
    const ward = wardId ? state.combatants[wardId] : undefined;
    if (ward && actor.side === 'ally' && ward.id !== actor.id && ward.status === 'up' && ward.position) return ward;
    const team = teamOfSide(actor.side);
    const leaderId = team ? state.morale?.leaders[team] : undefined;
    const leader = leaderId ? state.combatants[leaderId] : undefined;
    if (leader && leader.id !== actor.id && leader.status === 'up' && leader.position) return leader;
    if (actor.side === 'ally') {
        const pc = playerCharacterOf(state);
        if (pc && pc.status === 'up' && pc.position) return pc;
    }
    return undefined;
}

function sideHealth(list: Combatant[]): number {
    let hp = 0;
    let max = 0;
    for (const c of list) {
        hp += Math.max(0, c.hp);
        max += c.maxHp;
    }
    return max > 0 ? hp / max : 0;
}

const objFieldCache = new WeakMap<Grid, Map<string, number[]>>();

function tilesField(grid: Grid, tiles: readonly Pos[]): number[] {
    let byKey = objFieldCache.get(grid);
    if (!byKey) {
        byKey = new Map();
        objFieldCache.set(grid, byKey);
    }
    const key = tiles.map(t => `${t.x},${t.y}`).join(';');
    const hit = byKey.get(key);
    if (hit) return hit;
    const field = distanceField(grid, tiles);
    byKey.set(key, field);
    return field;
}

const PRESSED_TERMS: readonly TermId[] = ['exposure', 'swarm', 'cover', 'hazardEdge', 'escape', 'kite', 'behind'];

function objectiveCtx(state: CombatState, actor: Combatant, base: Weights, grid: Grid | undefined): { w: Weights; obj: ObjCtx } | null {
    const o = state.objective;
    if (!o) return null;
    const w = { ...base };
    const obj: ObjCtx = { pull: 0, wards: new Set<string>() };
    const main = mainWin(o);
    const leaderId = leaderIdOf(o);
    const wardId = wardIdOf(o);
    const leader = leaderId ? state.combatants[leaderId] : undefined;
    if (isPlayerSide(actor.side)) {
        if (grid && main?.kind === 'escape' && (main.everyone || actor.side === 'player')) {
            obj.pullField = tilesField(grid, main.exits);
            obj.pull = OBJECTIVE_WEIGHTS.goal;
        }
        if (grid && main?.kind === 'seize' && actor.mark !== 'ward') {
            obj.pullField = tilesField(grid, [main.tile]);
            obj.pull = OBJECTIVE_WEIGHTS.goal;
        }
        if (leader && leader.status === 'up' && (main?.kind === 'defeat_leader' || hasLose(o, 'leader_escapes'))) obj.focus = leader.id;
        if (grid && leader && hasLose(o, 'leader_escapes') && !obj.pullField) obj.guardField = tilesField(grid, leaderExitsOf(o));
        if (o.win.kind === 'protect' && actor.side === 'ally' && actor.mark !== 'ward') {
            obj.wardId = o.win.wardId;
            w.post = Math.max(w.post, OBJECTIVE_WEIGHTS.wardGuard);
            w.protect = Math.max(w.protect, AI_WEIGHTS.protect);
        }
    } else if (actor.side === 'enemy') {
        if (grid && main?.kind === 'escape') obj.guardField = obj.runnerField = tilesField(grid, main.exits);
        if (grid && main?.kind === 'seize') obj.guardField = obj.runnerField = tilesField(grid, [main.tile]);
        const running = hasLose(o, 'leader_escapes');
        if (leader && actor.id === leaderId) {
            if (running && grid) {
                obj.pullField = tilesField(grid, leaderExitsOf(o));
                obj.pull = OBJECTIVE_WEIGHTS.leaderRun;
                obj.guardField = undefined;
            }
            if (main?.kind === 'defeat_leader') w.behind = Math.max(w.behind, AI_WEIGHTS.behind);
        } else if (leader && leader.status === 'up' && leader.position && (running || main?.kind === 'defeat_leader')) {
            obj.screen = leader;
        }
        if (wardId) obj.wards.add(wardId);
        const bystanderId = o.side?.kind === 'save_bystander' ? o.side.bystanderId : undefined;
        if (bystanderId) obj.wards.add(bystanderId);
        const clock = objectiveClock(state);
        const total = main?.kind === 'survive' ? main.rounds : o.win.kind === 'protect' && !o.win.with ? o.win.rounds : undefined;
        if (clock && total && clock.kind !== 'round_limit') {
            const f = Math.max(OBJECTIVE_WEIGHTS.pressFloor, Math.min(1, clock.left / total));
            for (const t of PRESSED_TERMS) w[t] *= f;
            w.damage *= 1 + OBJECTIVE_WEIGHTS.pressDamage * (1 - f);
            w.progress *= 1 + OBJECTIVE_WEIGHTS.pressProgress * (1 - f);
        }
    }
    return { w, obj };
}

function bystanderTurn(state: CombatState, actor: Combatant, turn: TurnState): TurnPlan {
    const end: CombatAction = { type: 'end_turn', actorId: actor.id };
    const grid = terrainOf(state);
    const plan = (steps: CombatAction[], destination?: Pos): TurnPlan => ({
        actorId: actor.id, tactic: 'coward', steps: [...steps, end], intent: { kind: 'retreat', ...(destination ? { destination } : {}) },
    });
    if (!grid || !actor.position) return plan([]);
    const danger = state.order.map(id => state.combatants[id])
        .filter((c): c is Combatant => !!c && c.side === 'enemy' && c.status === 'up' && !!c.position);
    if (danger.length === 0) return plan([]);
    const cap = OBJECTIVE_WEIGHTS.bystanderRadius * 2;
    const pc = actor.mark === 'ward' ? playerCharacterOf(state) : undefined;
    const anchor = pc && pc.status === 'up' && pc.position ? pc.position : undefined;
    const score = (p: Pos) => Math.min(cap, ...danger.map(d => distance(p, d.position as Pos))) * OBJECTIVE_WEIGHTS.bystanderDanger
        - (tileAt(grid, p) === 'hazard' ? AI_LIMITS.hazardHit * 2 : 0)
        - (anchor ? OBJECTIVE_WEIGHTS.wardStay * Math.max(0, distance(p, anchor) - AI_LIMITS.guardRadius) : 0);
    const here = actor.position;
    let best = { p: here, s: score(here), cost: 0 };
    const search = turn.moveLeft > 0 ? searchMoves(state, actor.id, { budget: turn.moveLeft, avoidHazards: true }) : null;
    for (const d of search ? destinations(search) : []) {
        const s = score(d);
        if (s > best.s || (s === best.s && (d.cost < best.cost || (d.cost === best.cost && (d.y < best.p.y || (d.y === best.p.y && d.x < best.p.x)))))) {
            best = { p: { x: d.x, y: d.y }, s, cost: d.cost };
        }
    }
    const moved = best.p.x !== here.x || best.p.y !== here.y;
    const steps: CombatAction[] = moved ? [{ type: 'move', actorId: actor.id, to: { ...best.p } }] : [];
    if (actor.mark === 'ward' && canAttackWith(turn)) {
        const foe = danger.find(d => checkAttack(state, actor.id, d.id, best.p).ok);
        if (foe) steps.push({ type: 'attack', actorId: actor.id, targetId: foe.id });
    }
    return plan(steps, moved ? { ...best.p } : undefined);
}

function buildCtx(state: CombatState, actor: Combatant, turn: TurnState): Ctx | { gridless: true; ctx: Ctx } {
    const tactic = tacticOf(actor);
    const profile = TACTIC_PROFILES[tactic];
    const terrain = terrainOf(state) as Grid;
    const objective = objectiveCtx(state, actor, weightsFor(actor, profile), terrain);
    let w = objective?.w ?? weightsFor(actor, profile);
    const living = state.order.map(id => state.combatants[id]).filter((c): c is Combatant => !!c);
    const placed = !!terrain && !!actor.position;
    const opponents = living.filter(c => (!placed || !!c.position) && canTarget(actor, c) && !(c.mark === 'bystander' && isPlayerSide(actor.side)));
    const allies = living.filter(c => c.id !== actor.id && c.status === 'up' && !!c.position && sameTeam(actor.side, c.side));
    const ord = orderCtx(state, actor, opponents, allies);
    if (ord) w = orderWeights(w, ord.profile);
    const fallen = living.filter(c => c.status === 'down' && !!c.position && sameTeam(actor.side, c.side) && recoverable(state, c));
    const pcBonus = w.threat > 0 ? 2 : 0;
    const threat = new Map<string, number>();
    for (const c of living) threat.set(c.id, threatOf(state, c, pcBonus));
    const far = new Set(opponents.filter(c => shootsFar(state, c)).map(c => c.id));
    const ref = state.turnStart && state.turnStart.actorId === actor.id ? state.turnStart.pos : (actor.position ?? { x: 0, y: 0 });
    const weak = actor.hp * 2 <= actor.maxHp;
    const team = living.filter(c => !c.summonerId && sameTeam(actor.side, c.side) && c.status !== 'gone');
    const foes = living.filter(c => !c.summonerId && c.status !== 'gone' && opponents.some(o => sameTeam(o.side, c.side)));
    const winning = sideHealth(team) - sideHealth(foes) >= AI_LIMITS.winningMargin;
    const ctx: Ctx = {
        state, actor, id: actor.id, turn, tactic, profile, w, terrain, opponents, allies, fallen, threat, far, ref, weak, winning,
        fragility: 1 + (1 - Math.max(0, actor.hp) / Math.max(1, actor.maxHp)),
        areaFoes: opponents.some(hasAreaKit),
        lane: new Set<number>(),
        allyFront: Infinity,
        maxOppHp: Math.max(0, ...opponents.map(effectiveHp)),
        nearestFoe: placed ? Math.min(Infinity, ...opponents.map(o => distance(ref, at(o)))) : 0,
        engage: shootsFar(state, actor) ? AI_LIMITS.shootingRange : reachOf(actor),
        pc: isPlayerSide(actor.side) ? playerCharacterOf(state) : undefined,
        posCache: new Map(),
        kitReady: (actor.kit ?? []).filter(a => abilityReadiness(state, actor, a, turn) === null),
        burstAims: new Map(),
        useCache: new Map(),
        weaponCache: new Map(),
        allowThrow: false,
        ...(objective ? { obj: objective.obj } : {}),
        ...(ord ? { ord } : {}),
    };
    if (terrain && state.placed && state.placed.length > 0) {
        const seen = seenSigils(state, actor).map(s => indexOf(terrain, s.tiles[0]));
        if (seen.length > 0) ctx.seen = new Set(seen);
        const zones = zonesAgainst(state, actor);
        if (zones.length > 0) ctx.zones = zones;
        const harm = new Map<number, number>();
        for (const m of marksOf(state)) {
            if (!m.mark || !TILE_MARKS[m.mark].harm) continue;
            for (const t of m.tiles) {
                const amount = expectedMarkHarm(state, actor, t);
                if (amount > 0) harm.set(indexOf(terrain, t), amount);
            }
        }
        if (harm.size > 0) ctx.harm = harm;
    }
    const scare = actor.conditions.length > 0 ? actor.conditions.find(c => c.id === FEARED) : undefined;
    const source = scare?.sourceId ? state.combatants[scare.sourceId] : undefined;
    if (source && source.status === 'up' && source.position) ctx.fear = { id: source.id, at: { ...source.position } };
    if (w.post > 0 || w.protect > 0) ctx.protectee = protecteeOf(state, actor, objective?.obj.wardId);
    if (ord?.kind === 'protect' && ord.target) ctx.protectee = ord.target;
    if (!placed) {
        const flat = { ...w };
        for (const t of ['proximity', 'hunt', 'protect', 'focus', 'steal'] as const) flat[t] = 0;
        return { gridless: true, ctx: { ...ctx, w: flat } };
    }
    if (w.lane > 0) {
        for (const a of allies) {
            if (!shootsFar(state, a)) continue;
            let near: Combatant | null = null;
            for (const o of opponents) if (!near || distance(at(o), at(a)) < distance(at(near), at(a))) near = o;
            if (!near) continue;
            for (const step of traceLine(at(a), at(near)).slice(1, -1)) for (const p of step) if (inBounds(terrain, p)) ctx.lane.add(indexOf(terrain, p));
        }
    }
    if (w.behind > 0) {
        for (const a of allies) for (const o of opponents) ctx.allyFront = Math.min(ctx.allyFront, distance(at(a), at(o)));
    }
    let goal: { c: Combatant; v: number } | null = null;
    for (const o of opponents) {
        const v = appeal(ctx, o) - 0.5 * distance(ctx.ref, at(o));
        if (!goal || v > goal.v) goal = { c: o, v };
    }
    if (ord?.kind === 'focus' && ord.target) {
        ctx.goal = ord.target;
        ctx.goalField = fieldFrom(terrain, at(ord.target));
    } else if (goal) {
        ctx.goal = goal.c;
        ctx.goalField = fieldFrom(terrain, at(goal.c));
    }
    return ctx;
}

export function planTurn(state: CombatState, actorId: string): TurnPlan {
    const actor = state.combatants[actorId];
    const end: CombatAction = { type: 'end_turn', actorId };
    if (!actor || actor.status !== 'up' || state.outcome) {
        return { actorId, tactic: actor ? tacticOf(actor) : 'aggressive', steps: [end], intent: { kind: 'guard' } };
    }
    const turn = currentActorId(state) === actorId ? currentTurn(state) as TurnState : freshTurn(state, actorId);
    if ((actor.mark === 'bystander' || (actor.mark === 'ward' && actor.controller === 'engine' && !isRetreating(state, actor))) && state.objective) {
        return bystanderTurn(state, actor, turn);
    }
    const built = buildCtx(state, actor, turn);
    if ('gridless' in built) return gridless(built.ctx);
    const ctx = built;
    const coward = ctx.profile.retreatBelow !== undefined && actor.hp <= actor.maxHp * ctx.profile.retreatBelow && actor.mark !== 'ward' && ctx.ord?.profile.overridesRetreat !== true;
    if (isRetreating(state, actor) || (coward && ctx.opponents.length > 0)) {
        const plan = retreatTurn(ctx);
        if (plan) return plan;
    }
    if (ctx.opponents.length === 0) return finish(ctx, EMPTY_STEPS, { kind: 'guard' });
    if (canAttackWith(turn)) return fullTurn(ctx);
    return afterAction(ctx);
}

export function planIntents(state: CombatState): Record<string, PlanIntent> {
    const out: Record<string, PlanIntent> = {};
    for (const id of state.order) {
        const c = state.combatants[id];
        if (!c || c.status !== 'up' || c.controller !== 'engine') continue;
        out[id] = planTurn(state, id).intent;
    }
    return out;
}
