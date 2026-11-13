import { Canvas, chance, clamp, pickOne, rectCells, shuffle } from './canvas';
import type { AreaLayout } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import type { MapDensity, Rng } from '../types';

type Strip = { kind: 'wall' | 'walk' | 'rib'; rows: number };

function profile(height: number): Strip[] {
    if (height >= 13) {
        const main = clamp(height - 9, 3, 5);
        return [{ kind: 'wall', rows: 1 }, { kind: 'walk', rows: 2 }, { kind: 'rib', rows: 1 }, { kind: 'walk', rows: main }, { kind: 'rib', rows: 1 }, { kind: 'walk', rows: 2 }, { kind: 'wall', rows: height - 7 - main }];
    }
    if (height >= 10) {
        const main = clamp(height - 6, 3, 5);
        return [{ kind: 'wall', rows: 1 }, { kind: 'walk', rows: 2 }, { kind: 'rib', rows: 1 }, { kind: 'walk', rows: main }, { kind: 'wall', rows: height - 4 - main }];
    }
    const main = clamp(height - 3, 3, 5);
    return [{ kind: 'wall', rows: 1 }, { kind: 'walk', rows: main }, { kind: 'wall', rows: height - 1 - main }];
}

function runAt(c: Canvas, x: number, y: number): { from: number; to: number } {
    let from = y;
    let to = y;
    while (from - 1 >= 0 && c.get(x, from - 1) !== 'wall' && c.get(x, from - 1) !== 'cover') from--;
    while (to + 1 < c.height && c.get(x, to + 1) !== 'wall' && c.get(x, to + 1) !== 'cover') to++;
    return { from, to };
}

function rock(c: Canvas, rng: Rng): boolean {
    const spots = c.floorCells(p => {
        if (p.x <= c.x0 || p.x >= c.x1) return false;
        const run = runAt(c, p.x, p.y);
        if (run.to - run.from + 1 < 4) return false;
        if (p.y !== run.from && p.y !== run.to) return false;
        return c.neighbourCount(p.x, p.y, 'cover', false) === 0;
    });
    for (const spot of shuffle(spots, rng).slice(0, 6)) if (c.tryPlace([spot], 'cover', 'optional')) return true;
    return false;
}

function scree(c: Canvas, rng: Rng): boolean {
    const seeds = c.floorCells(p => c.neighbourCount(p.x, p.y, 'wall', false) >= 3 && c.neighbourCount(p.x, p.y, 'difficult', false) === 0);
    const start = pickOne(seeds, rng);
    if (!start) return false;
    return c.tryPlace(c.blob(start, rng.int(1, 3), rng, p => c.free(p.x, p.y)), 'difficult', 'optional', false);
}

function extra(c: Canvas, rng: Rng): boolean {
    if (chance(rng, 0.6) && rock(c, rng)) return true;
    return scree(c, rng);
}

export const LEDGE_AREA: AreaDefinition = {
    build(c, target, rng) {
        const strips = profile(c.height);
        const flip = chance(rng, 0.5);
        const row = (y: number) => (flip ? c.height - 1 - y : y);
        const bottom = strips[strips.length - 1].rows;
        const dip = bottom >= 2 ? 1 : 0;
        const span = Math.min(c.innerWidth - 2, rng.int(3, 5));
        const dipFrom = c.x0 + rng.int(1, Math.max(1, c.innerWidth - span - 1));
        const offsets: number[] = [];
        for (let x = c.x0; x <= c.x1; x++) offsets.push(x >= dipFrom && x < dipFrom + span ? dip : 0);
        for (const p of rectCells({ x: c.x0, y: 0, w: c.innerWidth, h: c.height })) c.tiles[c.index(p.x, p.y)] = 'wall';
        const ribs: number[] = [];
        let y = 0;
        const mainIndex = strips.reduce((best, s, i) => (s.kind === 'walk' && s.rows > strips[best].rows ? i : best), 0);
        for (const [i, strip] of strips.entries()) {
            if (strip.kind === 'walk') {
                for (let x = c.x0; x <= c.x1; x++) {
                    const shift = i === mainIndex && i === strips.length - 2 ? offsets[x - c.x0] : 0;
                    for (let k = 0; k < strip.rows; k++) c.tiles[c.index(x, row(y + k + shift))] = 'floor';
                }
            }
            if (strip.kind === 'rib') ribs.push(y);
            y += strip.rows;
        }
        const used = new Set<number>();
        for (const rib of ribs) {
            const gaps = rng.int(1, 2);
            for (let g = 0; g < gaps; g++) {
                const options: number[] = [];
                for (let x = c.x0 + 1; x <= c.x1 - 1; x++) if (!used.has(x) && !used.has(x - 1) && !used.has(x + 1)) options.push(x);
                const gx = pickOne(options, rng);
                if (gx === undefined) break;
                used.add(gx);
                c.tiles[c.index(gx, row(rib))] = 'floor';
            }
        }
        c.claim('structural');
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateLedge(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('ledge', LEDGE_AREA, width, height, density, rng);
}
