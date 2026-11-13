import { neighbours } from '../grid';
import { Canvas, chance, clamp, pickOne, shapeAt, shuffle } from './canvas';
import type { AreaLayout } from './canvas';
import { fillTo, runArea, structuralTarget } from './bands';
import type { AreaDefinition } from './bands';
import type { MapDensity, Pos, Rng } from '../types';

export function reachedFromWest(c: Canvas): Set<number> {
    const grid = c.grid();
    const seen = new Set<number>([0]);
    const stack: Pos[] = [{ x: 0, y: 0 }];
    while (stack.length > 0) {
        const here = stack.pop() as Pos;
        for (const next of neighbours(grid, here)) {
            const idx = c.index(next.x, next.y);
            if (seen.has(idx)) continue;
            seen.add(idx);
            stack.push(next);
        }
    }
    return seen;
}

export function fillPockets(c: Canvas): void {
    const seen = reachedFromWest(c);
    for (let y = 0; y < c.height; y++) {
        for (let x = c.x0; x <= c.x1; x++) {
            const idx = c.index(x, y);
            if (c.tiles[idx] !== 'wall' && c.tiles[idx] !== 'cover' && !seen.has(idx)) c.tiles[idx] = 'wall';
        }
    }
}

export function eastReached(c: Canvas): boolean {
    return reachedFromWest(c).has(c.index(c.width - 1, 0));
}

export function tunnel(c: Canvas, rng: Rng, rows: readonly [number, number], height = 2): void {
    let y = rng.int(rows[0], rows[1]);
    for (let x = c.x0; x <= c.x1; x++) {
        for (let k = 0; k < height; k++) if (c.inner(x, y + k)) c.tiles[c.index(x, y + k)] = 'floor';
        y = clamp(y + rng.int(-1, 1), rows[0], rows[1]);
        for (let k = 0; k < height; k++) if (c.inner(x, y + k)) c.tiles[c.index(x, y + k)] = 'floor';
    }
}

export function erodeTo(c: Canvas, goal: number, rng: Rng, prefer: (p: Pos) => number): void {
    for (let guard = 0; guard < 400 && c.count() > goal; guard++) {
        const options: Array<{ p: Pos; score: number }> = [];
        for (let y = 0; y < c.height; y++) {
            for (let x = c.x0; x <= c.x1; x++) {
                if (c.get(x, y) !== 'wall') continue;
                if (c.neighbourCount(x, y, 'floor', false) === 0) continue;
                options.push({ p: { x, y }, score: c.neighbourCount(x, y, 'wall', true) + prefer({ x, y }) + rng.next() });
            }
        }
        if (options.length === 0) return;
        options.sort((a, b) => a.score - b.score);
        const { p } = options[0];
        c.tiles[c.index(p.x, p.y)] = 'floor';
    }
}

export function growTo(c: Canvas, goal: number, rng: Rng, prefer: (p: Pos) => number): void {
    for (let guard = 0; guard < 200 && c.count() < goal; guard++) {
        const options: Array<{ p: Pos; score: number }> = [];
        for (const p of c.floorCells()) {
            const walls = c.neighbourCount(p.x, p.y, 'wall', true);
            if (walls < 3) continue;
            options.push({ p, score: -walls + prefer(p) + rng.next() });
        }
        options.sort((a, b) => a.score - b.score);
        let grown = false;
        for (const { p } of options.slice(0, 8)) {
            c.tiles[c.index(p.x, p.y)] = 'wall';
            if (c.connected()) {
                grown = true;
                break;
            }
            c.tiles[c.index(p.x, p.y)] = 'floor';
        }
        if (!grown) return;
    }
}

function rubble(c: Canvas, rng: Rng): boolean {
    const seeds = c.floorCells(p => c.neighbourCount(p.x, p.y, 'wall', false) >= 2 && c.neighbourCount(p.x, p.y, 'difficult', false) === 0);
    const start = pickOne(seeds, rng);
    if (!start) return false;
    return c.tryPlace(c.blob(start, rng.int(2, 4), rng, p => c.free(p.x, p.y)), 'difficult', 'optional', false);
}

function boulder(c: Canvas, rng: Rng): boolean {
    const spots = shuffle(c.floorCells(p => c.clearAround([p], 1)), rng);
    for (const spot of spots.slice(0, 6)) if (c.tryPlace([spot], 'cover', 'optional')) return true;
    return false;
}

function extra(c: Canvas, rng: Rng): boolean {
    if (chance(rng, 0.7) && rubble(c, rng)) return true;
    return boulder(c, rng);
}

export const CAVERN_AREA: AreaDefinition = {
    build(c, target, rng) {
        const mid = (c.height - 1) / 2;
        const edgeDistance = (p: Pos) => Math.abs(p.y - mid) / mid;
        for (let y = 0; y < c.height; y++) {
            for (let x = c.x0; x <= c.x1; x++) {
                const d = edgeDistance({ x, y });
                c.tiles[c.index(x, y)] = rng.next() < 0.14 + 0.8 * Math.pow(d, 1.4) ? 'wall' : 'floor';
            }
        }
        for (let pass = 0; pass < 4; pass++) {
            const next = [...c.tiles];
            for (let y = 0; y < c.height; y++) {
                for (let x = c.x0; x <= c.x1; x++) {
                    const n = c.neighbourCount(x, y, 'wall', true);
                    if (n >= 5) next[c.index(x, y)] = 'wall';
                    else if (n <= 3) next[c.index(x, y)] = 'floor';
                }
            }
            c.tiles.splice(0, c.tiles.length, ...next);
        }
        if (!eastReached(c)) tunnel(c, rng, [Math.max(1, Math.floor(mid) - 1), Math.min(c.height - 3, Math.ceil(mid))]);
        fillPockets(c);
        const goal = structuralTarget(c.innerWidth * c.height, rng);
        if (c.count() > goal) erodeTo(c, goal, rng, p => -1.5 * edgeDistance(p));
        else growTo(c, goal, rng, p => -2 * edgeDistance(p));
        const pillars = c.innerWidth >= 10 ? rng.int(2, 3) : 1;
        for (let i = 0; i < pillars; i++) {
            const spots = c.floorCells(p => Math.abs(p.y - mid) <= mid * 0.6 && p.x > c.x0 && p.x < c.x1 - 1);
            const spot = pickOne(spots, rng);
            if (!spot) break;
            const cells = shapeAt(spot, pickOne(['single', 'vbar', 'square'] as const, rng) ?? 'single', rng);
            if (cells.every(p => c.free(p.x, p.y)) && c.clearAround(cells, 1)) c.tryPlace(cells, 'wall', 'structural');
        }
        c.claim('structural');
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateCavern(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('cavern', CAVERN_AREA, width, height, density, rng);
}
