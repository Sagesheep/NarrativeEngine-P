import { Canvas, chance, clamp } from './canvas';
import type { AreaLayout } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import { placeIsolated } from './open';
import type { MapDensity, Pos, Rng } from '../types';

function setWater(c: Canvas, p: Pos, wet: boolean): void {
    if (c.inner(p.x, p.y)) c.tiles[c.index(p.x, p.y)] = wet ? 'difficult' : 'floor';
}

function adjustWater(c: Canvas, goal: number, rng: Rng, keepDry: ReadonlySet<number> = new Set()): void {
    for (let guard = 0; guard < 300; guard++) {
        const water = c.count(undefined, 'difficult');
        if (water === goal) return;
        const growing = water < goal;
        const options: Array<{ p: Pos; score: number }> = [];
        for (let y = 0; y < c.height; y++) {
            for (let x = c.x0; x <= c.x1; x++) {
                const tile = c.get(x, y);
                const wetNear = c.neighbourCount(x, y, 'difficult', false);
                if (growing && tile === 'floor' && wetNear >= 2 && !keepDry.has(c.index(x, y))) options.push({ p: { x, y }, score: -wetNear - rng.next() * 2 });
                if (!growing && tile === 'difficult') options.push({ p: { x, y }, score: wetNear + rng.next() * 2 });
            }
        }
        if (options.length === 0) return;
        options.sort((a, b) => a.score - b.score);
        setWater(c, options[0].p, growing);
    }
}

function tree(c: Canvas, rng: Rng): boolean {
    const dry = (p: Pos) => c.neighbourCount(p.x, p.y, 'floor', false) >= 3;
    return placeIsolated(c, rng, chance(rng, 0.7) ? 'single' : 'vbar', 'cover', 1, dry);
}

function extra(c: Canvas, rng: Rng): boolean {
    if (tree(c, rng)) return true;
    return placeIsolated(c, rng, 'single', 'cover', 1);
}

export const WETLAND_AREA: AreaDefinition = {
    build(c, target, rng) {
        const cells = c.innerWidth * c.height;
        const goal = Math.min(target, Math.round(cells * (0.34 + 0.04 * rng.next())));
        const pools = clamp(Math.round(cells / 25), 3, 7);
        const centres: Array<{ x: number; y: number; r: number }> = [];
        for (let i = 0; i < pools; i++) {
            centres.push({ x: c.x0 + rng.next() * (c.innerWidth - 1), y: rng.next() * (c.height - 1), r: 1.5 + rng.next() * (c.height / 4) });
        }
        const field = c.floorCells().map(p => {
            let v = 0;
            for (const k of centres) v = Math.max(v, 1 - Math.hypot((p.x - k.x) * 0.8, p.y - k.y) / k.r);
            return { p, v: v + 0.35 * rng.next() };
        });
        field.sort((a, b) => b.v - a.v);
        for (const { p } of field.slice(0, goal)) setWater(c, p, true);
        for (let pass = 0; pass < 2; pass++) {
            const next = [...c.tiles];
            for (let y = 0; y < c.height; y++) {
                for (let x = c.x0; x <= c.x1; x++) {
                    const n = c.neighbourCount(x, y, 'difficult', false);
                    const idx = c.index(x, y);
                    if (c.tiles[idx] === 'floor' && n >= 5) next[idx] = 'difficult';
                    else if (c.tiles[idx] === 'difficult' && n <= 1) next[idx] = 'floor';
                }
            }
            c.tiles.splice(0, c.tiles.length, ...next);
        }
        adjustWater(c, goal, rng);
        if (chance(rng, 0.6)) {
            const causeway = new Set<number>();
            let y = rng.int(1, c.height - 2);
            for (let x = c.x0; x <= c.x1; x++) {
                setWater(c, { x, y }, false);
                causeway.add(c.index(x, y));
                const ny = clamp(y + rng.int(-1, 1), 1, c.height - 2);
                if (ny !== y) {
                    setWater(c, { x, y: ny }, false);
                    causeway.add(c.index(x, ny));
                }
                y = ny;
            }
            adjustWater(c, goal, rng, causeway);
        }
        c.claim('structural');
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateWetland(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('wetland', WETLAND_AREA, width, height, density, rng);
}
