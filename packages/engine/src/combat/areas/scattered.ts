import { Canvas, chance, pickOne, shapeAt, shuffle } from './canvas';
import type { AreaLayout, ShapeName } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import { difficultPatch, placeIsolated } from './open';
import type { MapDensity, Pos, Rng } from '../types';

const LATTICE = 3;

function clusterShape(rng: Rng): ShapeName {
    const roll = rng.next();
    if (roll < 0.3) return 'single';
    if (roll < 0.55) return 'hbar';
    if (roll < 0.8) return 'vbar';
    return 'ell';
}

function coverNear(c: Canvas, p: Pos, radius: number): number {
    let n = 0;
    for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
            if (c.get(p.x + dx, p.y + dy) === 'cover' && c.inner(p.x + dx, p.y + dy)) n++;
        }
    }
    return n;
}

function latticeCells(c: Canvas, rng: Rng): Pos[] {
    const evens: Pos[] = [];
    const odds: Pos[] = [];
    const cols = Math.max(1, Math.floor(c.innerWidth / LATTICE));
    const rows = Math.max(1, Math.floor(c.height / LATTICE));
    const xPad = Math.floor((c.innerWidth - cols * LATTICE) / 2);
    const yPad = Math.floor((c.height - rows * LATTICE) / 2);
    for (let j = 0; j < rows; j++) {
        for (let i = 0; i < cols; i++) ((i + j) % 2 === 0 ? evens : odds).push({ x: c.x0 + xPad + i * LATTICE, y: yPad + j * LATTICE });
    }
    return [...shuffle(evens, rng), ...shuffle(odds, rng)];
}

function clusterIn(c: Canvas, cell: Pos, rng: Rng): boolean {
    const shape = clusterShape(rng);
    const options: Pos[][] = [];
    for (let y = cell.y; y < cell.y + LATTICE; y++) {
        for (let x = cell.x; x < cell.x + LATTICE; x++) {
            const cells = shapeAt({ x, y }, shape, rng);
            if (cells.every(p => c.free(p.x, p.y)) && c.clearAround(cells, 1)) options.push(cells);
        }
    }
    const chosen = pickOne(options, rng);
    return !!chosen && c.tryPlace(chosen, 'cover', 'optional');
}

function undergrowth(c: Canvas, rng: Rng): boolean {
    const seeds = c.floorCells(p => coverNear(c, p, 2) >= 2 && c.neighbourCount(p.x, p.y, 'difficult', false) === 0);
    const start = pickOne(seeds, rng);
    if (!start) return difficultPatch(c, rng, rng.int(2, 4));
    const cells = c.blob(start, rng.int(2, 4), rng, p => c.free(p.x, p.y));
    return c.tryPlace(cells, 'difficult', 'optional', false);
}

function extra(c: Canvas, rng: Rng): boolean {
    if (chance(rng, 0.6) && placeIsolated(c, rng, clusterShape(rng), 'cover', 1)) return true;
    return undergrowth(c, rng);
}

export const SCATTERED_AREA: AreaDefinition = {
    build(c, target, rng) {
        const coverTarget = Math.round(target * 0.68);
        for (const cell of latticeCells(c, rng)) {
            if (c.count() >= coverTarget) break;
            clusterIn(c, cell, rng);
        }
        fillTo(c, target, [0, c.height - 1], rng, undergrowth, 40);
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateScattered(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('scattered', SCATTERED_AREA, width, height, density, rng);
}
