import { distance, hasLineOfSight, inBounds, isWalkable, samePos, sameTeam, terrainOf, tileAt, traceLine } from '../grid';
import type { CombatState, Combatant, GlyphAbility, Grid, Pos } from '../types';
import { GLYPH_NUMBERS as N } from './registry';
import {
    blinkRange, burstRadius, burstRange, coneLength, dashLength, lineLength, lineWidth, projectileRange, splitCount,
} from './numbers';

export type AimResult = {
    ok: boolean;
    reason?: string;
    tiles: Pos[];
    targetIds: string[];
    origin?: Pos;
    destination?: Pos;
    barrierTiles?: Pos[];
    summonAt?: Pos;
};

const OCTANTS: readonly Pos[] = [
    { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: -1, y: 1 },
    { x: -1, y: 0 }, { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
];

const NEIGHBOURS: readonly Pos[] = OCTANTS;

function fail(reason: string): AimResult {
    return { ok: false, reason, tiles: [], targetIds: [] };
}

export function tileEffectOf(ability: GlyphAbility): 'barrier' | 'summon' | null {
    const first = ability.effects[0]?.id;
    return first === 'barrier' || first === 'summon' ? first : null;
}

export function hasBlink(ability: GlyphAbility): boolean {
    return ability.effects.some(e => e.id === 'blink');
}

export function livingAt(state: CombatState, p: Pos): Combatant | undefined {
    return Object.values(state.combatants).find(c => c.status === 'up' && samePos(c.position, p));
}

export function isEmptyTile(state: CombatState, terrain: Grid, p: Pos): boolean {
    if (!inBounds(terrain, p) || !isWalkable(terrain, p)) return false;
    return !Object.values(state.combatants).some(c => c.status !== 'gone' && samePos(c.position, p));
}

export function directionOf(from: Pos, aim: Pos): Pos | null {
    const dx = aim.x - from.x;
    const dy = aim.y - from.y;
    if (dx === 0 && dy === 0) return null;
    const oct = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    return OCTANTS[((oct % 8) + 8) % 8];
}

function add(a: Pos, b: Pos, k = 1): Pos {
    return { x: a.x + b.x * k, y: a.y + b.y * k };
}

function isWall(grid: Grid, p: Pos): boolean {
    return tileAt(grid, p) === 'wall';
}

function livingOn(state: CombatState, tiles: readonly Pos[], exceptId?: string): string[] {
    const ids: string[] = [];
    for (const id of state.order) {
        const c = state.combatants[id];
        if (!c || c.status !== 'up' || c.id === exceptId || !c.position) continue;
        if (tiles.some(t => samePos(t, c.position))) ids.push(c.id);
    }
    return ids;
}

function splitExtras(state: CombatState, terrain: Grid, user: Combatant, first: Combatant, times: number): string[] {
    if (times <= 0 || !first.position) return [];
    const firstHostile = !sameTeam(user.side, first.side);
    const chosen: string[] = [];
    const candidates = state.order
        .map(id => state.combatants[id])
        .filter((c): c is Combatant => !!c && c.status === 'up' && c.id !== user.id && c.id !== first.id && !!c.position)
        .filter(c => (!sameTeam(user.side, c.side)) === firstHostile)
        .filter(c => distance(first.position as Pos, c.position as Pos) <= N.splitRange && hasLineOfSight(terrain, first.position as Pos, c.position as Pos))
        .sort((a, b) => (distance(first.position as Pos, a.position as Pos) - distance(first.position as Pos, b.position as Pos))
            || (state.order.indexOf(a.id) - state.order.indexOf(b.id)));
    for (const c of candidates) {
        if (chosen.length >= times) break;
        chosen.push(c.id);
    }
    return chosen;
}

function singleTarget(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    const target = livingAt(state, aim);
    if (!target || target.id === user.id) return fail('no target there');
    const extras = splitExtras(state, terrain, user, target, splitCount(ability));
    const ids = [target.id, ...extras];
    return { ok: true, tiles: ids.map(id => ({ ...(state.combatants[id].position as Pos) })), targetIds: ids, origin: { ...(user.position as Pos) } };
}

function tileTarget(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    if (!isEmptyTile(state, terrain, aim)) return fail('the square is not empty');
    const kind = tileEffectOf(ability);
    return {
        ok: true,
        tiles: [{ ...aim }],
        targetIds: [],
        origin: { ...(user.position as Pos) },
        ...(kind === 'barrier' ? { barrierTiles: [{ ...aim }] } : { summonAt: { ...aim } }),
    };
}

function touch(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    if (distance(user.position as Pos, aim) !== N.touchRange) return fail('out of reach');
    return tileEffectOf(ability) ? tileTarget(state, terrain, user, ability, aim) : singleTarget(state, terrain, user, ability, aim);
}

function projectile(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    const from = user.position as Pos;
    if (samePos(from, aim)) return fail('aim at another square');
    if (distance(from, aim) > projectileRange(ability)) return fail('out of range');
    if (!hasLineOfSight(terrain, from, aim)) return fail('no line of sight');
    if (tileEffectOf(ability)) return tileTarget(state, terrain, user, ability, aim);
    if (ability.form.augments.includes('pierce')) {
        const path = traceLine(from, aim).slice(1).flat();
        const ids = livingOn(state, path, user.id);
        if (ids.length === 0) return fail('no target there');
        const extras = splitExtras(state, terrain, user, state.combatants[ids[ids.length - 1]], splitCount(ability)).filter(id => !ids.includes(id));
        const all = [...ids, ...extras];
        return { ok: true, tiles: path.map(p => ({ ...p })), targetIds: all, origin: { ...from } };
    }
    return singleTarget(state, terrain, user, ability, aim);
}

function self(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos | null | undefined): AimResult {
    const from = user.position as Pos;
    if (!hasBlink(ability)) return { ok: true, tiles: [{ ...from }], targetIds: [user.id], origin: { ...from } };
    if (!aim) return fail('choose a square to blink to');
    const blink = ability.effects.find(e => e.id === 'blink');
    if (distance(from, aim) > blinkRange(blink?.augments ?? [])) return fail('out of range');
    if (!isEmptyTile(state, terrain, aim)) return fail('the square is not empty');
    if (!hasLineOfSight(terrain, from, aim)) return fail('no line of sight');
    return { ok: true, tiles: [{ ...aim }], targetIds: [user.id], origin: { ...from }, destination: { ...aim } };
}

function lineTiles(terrain: Grid, from: Pos, dir: Pos, length: number, width: number): { centre: Pos[]; all: Pos[] } {
    const centre: Pos[] = [];
    const all: Pos[] = [];
    const perp = { x: -dir.y, y: dir.x };
    const half = (width - 1) / 2;
    for (let k = 1; k <= length; k++) {
        const c = add(from, dir, k);
        if (!inBounds(terrain, c) || isWall(terrain, c)) break;
        centre.push(c);
        all.push(c);
        for (let j = 1; j <= half; j++) {
            for (const side of [add(c, perp, j), add(c, perp, -j)]) {
                if (inBounds(terrain, side) && !isWall(terrain, side) && hasLineOfSight(terrain, from, side)) all.push(side);
            }
        }
    }
    return { centre, all };
}

function line(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    const from = user.position as Pos;
    const dir = directionOf(from, aim);
    if (!dir) return fail('choose a direction');
    const { centre, all } = lineTiles(terrain, from, dir, lineLength(ability), lineWidth(ability));
    if (tileEffectOf(ability) === 'barrier') {
        const barrierTiles = centre.filter(p => isEmptyTile(state, terrain, p)).slice(0, N.barrierLineTiles);
        if (barrierTiles.length === 0) return fail('no empty square in that direction');
        return { ok: true, tiles: barrierTiles, targetIds: [], origin: { ...from }, barrierTiles };
    }
    if (all.length === 0) return fail('a wall is in the way');
    return { ok: true, tiles: all, targetIds: livingOn(state, all, user.id), origin: { ...from } };
}

function coneTiles(terrain: Grid, from: Pos, dir: Pos, length: number): Pos[] {
    const out: Pos[] = [];
    const dirLen = Math.hypot(dir.x, dir.y);
    const limit = Math.cos(Math.PI / 4) - 1e-9;
    for (let y = from.y - length; y <= from.y + length; y++) {
        for (let x = from.x - length; x <= from.x + length; x++) {
            const p = { x, y };
            if (samePos(p, from) || !inBounds(terrain, p) || isWall(terrain, p)) continue;
            const vx = x - from.x;
            const vy = y - from.y;
            const cos = (vx * dir.x + vy * dir.y) / (Math.hypot(vx, vy) * dirLen);
            if (cos < limit) continue;
            if (!hasLineOfSight(terrain, from, p)) continue;
            out.push(p);
        }
    }
    return out;
}

function cone(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    const from = user.position as Pos;
    const dir = directionOf(from, aim);
    if (!dir) return fail('choose a direction');
    const tiles = coneTiles(terrain, from, dir, coneLength(ability));
    if (tiles.length === 0) return fail('a wall is in the way');
    return { ok: true, tiles, targetIds: livingOn(state, tiles, user.id), origin: { ...from } };
}

function burst(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    const from = user.position as Pos;
    if (distance(from, aim) > burstRange(ability)) return fail('out of range');
    if (!isWalkable(terrain, aim)) return fail('the centre must be open ground');
    if (!hasLineOfSight(terrain, from, aim)) return fail('no line of sight');
    const r = burstRadius(ability);
    const tiles: Pos[] = [];
    for (let y = aim.y - r; y <= aim.y + r; y++) {
        for (let x = aim.x - r; x <= aim.x + r; x++) {
            const p = { x, y };
            if (!inBounds(terrain, p) || isWall(terrain, p)) continue;
            if (!hasLineOfSight(terrain, aim, p)) continue;
            tiles.push(p);
        }
    }
    return { ok: true, tiles, targetIds: livingOn(state, tiles), origin: { ...aim } };
}

function euclid(a: Pos, b: Pos): number {
    return (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
}

function dashPathClear(state: CombatState, terrain: Grid, user: Combatant, to: Pos): boolean {
    const from = user.position as Pos;
    for (const step of traceLine(from, to).slice(1)) {
        for (const p of step) {
            if (!isWalkable(terrain, p)) return false;
            const there = livingAt(state, p);
            if (there && there.id !== user.id && !sameTeam(user.side, there.side)) return false;
        }
    }
    return true;
}

function dash(state: CombatState, terrain: Grid, user: Combatant, ability: GlyphAbility, aim: Pos): AimResult {
    const from = user.position as Pos;
    const target = livingAt(state, aim);
    if (!target || target.id === user.id) return fail('no target there');
    const limit = dashLength(ability);
    let best: Pos | null = distance(from, aim) === 1 ? { ...from } : null;
    if (!best) {
        const options = NEIGHBOURS.map(d => add(aim, d))
            .filter(p => distance(from, p) <= limit && isEmptyTile(state, terrain, p) && dashPathClear(state, terrain, user, p))
            .sort((a, b) => (distance(from, a) - distance(from, b)) || (euclid(from, a) - euclid(from, b)) || (a.y - b.y) || (a.x - b.x));
        best = options[0] ?? null;
    }
    if (!best) return fail('no clear straight path to that target');
    return { ok: true, tiles: [{ ...aim }], targetIds: [target.id], origin: { ...from }, destination: best };
}

export function abilityTargets(state: CombatState, userId: string, ability: GlyphAbility, aim: Pos | null | undefined): AimResult {
    const user = state.combatants[userId];
    const terrain = terrainOf(state);
    if (!user || user.status !== 'up' || !user.position || !terrain) return fail('the user cannot act');
    if (ability.form.id !== 'self' && (!aim || !inBounds(terrain, aim))) return fail('choose a square');
    const at = aim as Pos;
    switch (ability.form.id) {
        case 'self': return self(state, terrain, user, ability, aim);
        case 'touch': return touch(state, terrain, user, ability, at);
        case 'projectile': return projectile(state, terrain, user, ability, at);
        case 'line': return line(state, terrain, user, ability, at);
        case 'cone': return cone(state, terrain, user, ability, at);
        case 'burst': return burst(state, terrain, user, ability, at);
        case 'dash': return dash(state, terrain, user, ability, at);
        default: return fail('unknown form');
    }
}

function tilesWithin(grid: Grid, from: Pos, range: number): Pos[] {
    const out: Pos[] = [];
    for (let y = Math.max(0, from.y - range); y <= Math.min(grid.height - 1, from.y + range); y++) {
        for (let x = Math.max(0, from.x - range); x <= Math.min(grid.width - 1, from.x + range); x++) {
            if (x !== from.x || y !== from.y) out.push({ x, y });
        }
    }
    return out;
}

export function legalAims(state: CombatState, userId: string, ability: GlyphAbility): Pos[] {
    const user = state.combatants[userId];
    const terrain = terrainOf(state);
    if (!user || user.status !== 'up' || !user.position || !terrain) return [];
    const from = user.position;
    const ok = (p: Pos) => abilityTargets(state, userId, ability, p).ok;
    const living = () => state.order
        .map(id => state.combatants[id])
        .filter((c): c is Combatant => !!c && c.status === 'up' && c.id !== userId && !!c.position)
        .map(c => ({ ...(c.position as Pos) }));
    switch (ability.form.id) {
        case 'self':
            if (!hasBlink(ability)) return [{ ...from }];
            return tilesWithin(terrain, from, blinkRange(ability.effects.find(e => e.id === 'blink')?.augments ?? [])).filter(ok);
        case 'touch':
            return tilesWithin(terrain, from, 1).filter(ok);
        case 'projectile':
            if (tileEffectOf(ability) || ability.form.augments.includes('pierce')) return tilesWithin(terrain, from, projectileRange(ability)).filter(ok);
            return living().filter(ok);
        case 'dash':
            return living().filter(ok);
        case 'burst':
            return [{ ...from }, ...tilesWithin(terrain, from, burstRange(ability))].filter(ok);
        case 'line':
        case 'cone': {
            const length = ability.form.id === 'line' ? lineLength(ability) : coneLength(ability);
            const valid = new Map<string, boolean>();
            return tilesWithin(terrain, from, length).filter(p => {
                const dir = directionOf(from, p) as Pos;
                const key = `${dir.x},${dir.y}`;
                if (!valid.has(key)) valid.set(key, ok(p));
                return valid.get(key) as boolean;
            });
        }
        default:
            return [];
    }
}
