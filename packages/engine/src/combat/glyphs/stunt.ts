import { ABILITY_KEYS } from '../abilities';
import { canTarget, currentActorId, currentTurn } from '../core';
import { distance, hasLineOfSight, inBounds, isWalkable, samePos, terrainOf, tileAt } from '../grid';
import type {
    AbilityKey, CombatState, Combatant, EffectId, FormId, GlyphAbility, Grid, Pos, StuntCheckProfile, StuntDifficulty, StuntOutcome, StuntPart,
    StuntSpec,
} from '../types';
import { BUILTIN_STUNT_ID, tooLargeToShove } from './builtins';
import { GLYPH_NUMBERS as N } from './registry';
import { isEmptyTile } from './targeting';
import type { AimResult } from './targeting';

export const STUNT_OUTCOMES: readonly StuntOutcome[] = ['hurt', 'push', 'pull', 'slow', 'stun', 'move', 'cover', 'hurt_area'];

export const STUNT_DIFFICULTIES: readonly StuntDifficulty[] = ['easy', 'moderate', 'hard', 'very_hard', 'impossible'];

export const STUNT_DC: Readonly<Record<Exclude<StuntDifficulty, 'impossible'>, number>> = { easy: 8, moderate: 12, hard: 16, very_hard: 20 };

export const STUNT_FLOORS: Readonly<Partial<Record<StuntOutcome, StuntDifficulty>>> = { stun: 'hard', hurt_area: 'hard' };

export const STUNT_MAX_PARTS = 2;

export const STUNT_DEFAULT_DAMAGE_TYPE = 'bludgeoning';

export const STUNT_DAMAGE_TYPE_MAX = 24;

export const STUNT_NAME = 'Stunt';

const EFFECT_OF: Readonly<Record<StuntOutcome, EffectId>> = {
    hurt: 'weapon',
    push: 'push',
    pull: 'pull',
    slow: 'slow',
    stun: 'stun',
    move: 'blink',
    cover: 'barrier',
    hurt_area: 'weapon',
};

const TARGETED: ReadonlySet<StuntOutcome> = new Set<StuntOutcome>(['hurt', 'push', 'pull', 'slow', 'stun']);

export type StuntStep = { outcome: StuntOutcome; ability: GlyphAbility; aim: AimResult };

export type StuntPlan = { check: StuntCheckProfile; difficulty: Exclude<StuntDifficulty, 'impossible'>; dc: number; steps: StuntStep[] };

export type StuntCheck = { ok: true; plan: StuntPlan } | { ok: false; reason: string; impossible?: boolean };

export function difficultyRank(d: StuntDifficulty): number {
    return STUNT_DIFFICULTIES.indexOf(d);
}

export function stuntDifficulty(parts: readonly Pick<StuntPart, 'difficulty'>[]): StuntDifficulty {
    if (parts.length === 0 || parts.some(p => p.difficulty === 'impossible')) return 'impossible';
    const top = Math.max(...parts.map(p => difficultyRank(p.difficulty)));
    const rank = top + (parts.length > 1 ? 1 : 0);
    return STUNT_DIFFICULTIES[Math.min(rank, STUNT_DIFFICULTIES.length - 1)];
}

export function stuntAvailable(state: CombatState, actorId: string): { ok: boolean; reason?: string } {
    if (state.outcome) return { ok: false, reason: 'the fight is over' };
    const actor = state.combatants[actorId];
    const turn = currentTurn(state);
    if (!actor || currentActorId(state) !== actorId || actor.status !== 'up' || !turn || turn.actorId !== actorId) return { ok: false, reason: 'not this combatant\'s turn' };
    if (actor.controller !== 'player') return { ok: false, reason: 'only a player-controlled combatant can try a stunt' };
    if (turn.actionUsed) return { ok: false, reason: 'the action is already used' };
    if (!terrainOf(state) || !actor.position) return { ok: false, reason: 'a stunt needs a map' };
    return { ok: true };
}

function cleanDamageType(raw: unknown): string {
    if (typeof raw !== 'string') return STUNT_DEFAULT_DAMAGE_TYPE;
    const clean = raw.replace(/[^\p{L}\s-]/gu, ' ').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, STUNT_DAMAGE_TYPE_MAX).trim();
    return clean || STUNT_DEFAULT_DAMAGE_TYPE;
}

function isPos(p: unknown): p is Pos {
    return !!p && typeof p === 'object' && Number.isInteger((p as Pos).x) && Number.isInteger((p as Pos).y);
}

function stuntAbility(form: FormId, outcome: StuntOutcome, check: StuntCheckProfile, damageType?: string): GlyphAbility {
    return {
        id: BUILTIN_STUNT_ID,
        name: STUNT_NAME,
        ...(damageType ? { damageType } : {}),
        form: { id: form, augments: [] },
        effects: [{ id: EFFECT_OF[outcome], augments: [] }],
        source: 'preset',
        builtin: { kind: 'stunt', slot: 'action', check: { ...check } },
    };
}

function word(outcome: StuntOutcome): string {
    return outcome.replace('_', ' ');
}

function targetStep(state: CombatState, terrain: Grid, actor: Combatant, from: Pos, part: StuntPart, check: StuntCheckProfile): StuntStep | string {
    const label = word(part.outcome);
    const target = typeof part.targetId === 'string' ? state.combatants[part.targetId] : undefined;
    if (!target || !target.position) return `${label}: there is no such target`;
    if (target.id === actor.id || !canTarget(actor, target)) return `${label}: ${target.name} is not a legal target (it must be an enemy still standing)`;
    const d = distance(from, target.position);
    const adjacent = d === N.touchRange;
    if (!adjacent) {
        if (part.outcome === 'stun') return `stun: ${target.name} is not adjacent`;
        if (d > N.stuntReach) return `${label}: ${target.name} is ${d} squares away; the limit is ${N.stuntReach}`;
        if (!hasLineOfSight(terrain, from, target.position)) return `${label}: ${target.name} is out of sight`;
    }
    if ((part.outcome === 'push' || part.outcome === 'pull') && tooLargeToShove(target)) return `${label}: ${target.name} is too large to move`;
    const damageType = part.outcome === 'hurt' ? cleanDamageType(part.damageType) : undefined;
    return {
        outcome: part.outcome,
        ability: stuntAbility(adjacent ? 'touch' : 'projectile', part.outcome, check, damageType),
        aim: { ok: true, tiles: [{ ...target.position }], targetIds: [target.id], origin: { ...from } },
    };
}

function moveStep(state: CombatState, terrain: Grid, actor: Combatant, from: Pos, part: StuntPart, check: StuntCheckProfile): StuntStep | string {
    const at = part.at;
    if (!isPos(at) || !inBounds(terrain, at)) return 'move: the square is not on the map';
    const d = distance(from, at);
    if (d < 1) return 'move: choose another square';
    if (d > N.stuntMove) return `move: the square is ${d} squares away; the limit is ${N.stuntMove}`;
    if (!isEmptyTile(state, terrain, at)) return 'move: the square is not empty open ground';
    if (!hasLineOfSight(terrain, from, at)) return 'move: the square is out of sight';
    return {
        outcome: 'move',
        ability: stuntAbility('self', 'move', check),
        aim: { ok: true, tiles: [{ ...at }], targetIds: [actor.id], origin: { ...from }, destination: { x: at.x, y: at.y } },
    };
}

function coverStep(state: CombatState, terrain: Grid, from: Pos, part: StuntPart, check: StuntCheckProfile): StuntStep | string {
    const raw = Array.isArray(part.tiles) ? part.tiles : [];
    if (raw.length < 1 || raw.length > N.stuntCoverTiles) return `cover: choose 1 or ${N.stuntCoverTiles} squares`;
    const tiles: Pos[] = [];
    for (const p of raw) {
        if (!isPos(p) || !inBounds(terrain, p)) return 'cover: a square is not on the map';
        if (tiles.some(t => samePos(t, p))) return 'cover: the same square is listed twice';
        const d = distance(from, p);
        if (d < 1 || d > N.stuntCoverRange) return `cover: a square is ${d} squares away; it must be 1 to ${N.stuntCoverRange}`;
        if (!isEmptyTile(state, terrain, p)) return 'cover: a square is not empty open ground';
        if (!hasLineOfSight(terrain, from, p)) return 'cover: a square is out of sight';
        tiles.push({ x: p.x, y: p.y });
    }
    return {
        outcome: 'cover',
        ability: stuntAbility('projectile', 'cover', check),
        aim: { ok: true, tiles: tiles.map(t => ({ ...t })), targetIds: [], origin: { ...from }, barrierTiles: tiles.map(t => ({ ...t })) },
    };
}

export function stuntArea(terrain: Grid, at: Pos): Pos[] {
    const tiles: Pos[] = [];
    const r = N.burstRadius;
    for (let y = at.y - r; y <= at.y + r; y++) {
        for (let x = at.x - r; x <= at.x + r; x++) {
            const p = { x, y };
            if (!inBounds(terrain, p) || tileAt(terrain, p) === 'wall') continue;
            if (!hasLineOfSight(terrain, at, p)) continue;
            tiles.push(p);
        }
    }
    return tiles;
}

function areaStep(state: CombatState, terrain: Grid, actor: Combatant, from: Pos, part: StuntPart, check: StuntCheckProfile): StuntStep | string {
    const at = part.at;
    if (!isPos(at) || !inBounds(terrain, at)) return 'hurt area: the centre is not on the map';
    const d = distance(from, at);
    if (d > N.stuntAreaRange) return `hurt area: the centre is ${d} squares away; the limit is ${N.stuntAreaRange}`;
    if (!isWalkable(terrain, at)) return 'hurt area: the centre must be open ground';
    if (!hasLineOfSight(terrain, from, at)) return 'hurt area: the centre is out of sight';
    const tiles = stuntArea(terrain, at);
    if (tiles.some(t => samePos(t, from))) return 'hurt area: the area would catch the actor';
    const targetIds = state.order.filter(id => {
        const c = state.combatants[id];
        return !!c && c.id !== actor.id && c.status === 'up' && !!c.position && tiles.some(t => samePos(t, c.position));
    });
    if (targetIds.length === 0) return 'hurt area: nobody is in that area';
    return {
        outcome: 'hurt_area',
        ability: stuntAbility('burst', 'hurt_area', check, cleanDamageType(part.damageType)),
        aim: { ok: true, tiles, targetIds, origin: { x: at.x, y: at.y } },
    };
}

function shapeReason(spec: unknown): string | null {
    if (!spec || typeof spec !== 'object') return 'the stunt is missing';
    const s = spec as Partial<StuntSpec>;
    if (typeof s.ability !== 'string' || !(ABILITY_KEYS as readonly string[]).includes(s.ability)) return 'the ability must be one of STR, DEX, CON, INT, WIS, CHA';
    if (!Array.isArray(s.parts) || s.parts.length < 1) return 'the stunt needs at least one outcome';
    if (s.parts.length > STUNT_MAX_PARTS) return `a stunt may combine at most ${STUNT_MAX_PARTS} outcomes`;
    const seen = new Set<string>();
    for (const p of s.parts) {
        if (!p || typeof p !== 'object' || !(STUNT_OUTCOMES as readonly unknown[]).includes(p.outcome)) return 'an outcome is not on the menu';
        if (!(STUNT_DIFFICULTIES as readonly unknown[]).includes(p.difficulty)) return `the ${word(p.outcome)} outcome needs a difficulty of easy, moderate, hard, very_hard or impossible`;
        if (seen.has(p.outcome)) return `the ${word(p.outcome)} outcome is listed twice`;
        seen.add(p.outcome);
    }
    return null;
}

export function checkStunt(state: CombatState, actorId: string, spec: StuntSpec): StuntCheck {
    const available = stuntAvailable(state, actorId);
    if (!available.ok) return { ok: false, reason: available.reason ?? 'unavailable' };
    const shape = shapeReason(spec);
    if (shape) return { ok: false, reason: shape };
    for (const p of spec.parts) {
        const floor = STUNT_FLOORS[p.outcome];
        if (p.difficulty !== 'impossible' && floor && difficultyRank(p.difficulty) < difficultyRank(floor)) {
            return { ok: false, reason: `the ${word(p.outcome)} outcome is never easier than ${floor.replace('_', ' ')}` };
        }
    }
    const difficulty = stuntDifficulty(spec.parts);
    if (difficulty === 'impossible') return { ok: false, reason: 'the stunt is impossible', impossible: true };
    const actor = state.combatants[actorId];
    const terrain = terrainOf(state) as Grid;
    const dc = STUNT_DC[difficulty];
    const check: StuntCheckProfile = { ability: spec.ability as AbilityKey, dc };
    let from: Pos = { ...(actor.position as Pos) };
    const steps: StuntStep[] = [];
    for (const part of spec.parts) {
        const step = TARGETED.has(part.outcome)
            ? targetStep(state, terrain, actor, from, part, check)
            : part.outcome === 'move'
                ? moveStep(state, terrain, actor, from, part, check)
                : part.outcome === 'cover'
                    ? coverStep(state, terrain, from, part, check)
                    : areaStep(state, terrain, actor, from, part, check);
        if (typeof step === 'string') return { ok: false, reason: step };
        if (step.aim.destination) from = { ...step.aim.destination };
        steps.push(step);
    }
    return { ok: true, plan: { check, difficulty, dc, steps } };
}
