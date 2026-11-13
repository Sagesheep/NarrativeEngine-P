import { Canvas, chance, pickOne, rectCells } from './canvas';
import type { AreaLayout } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import { difficultPatch, placeIsolated } from './open';
import type { MapDensity, Pos, Rng } from '../types';

type Band = { from: number; to: number; faces: 'up' | 'down'; mustPass: boolean };

function buildBand(c: Canvas, band: Band, rng: Rng): void {
    const depth = band.to - band.from + 1;
    const faceRow = band.faces === 'down' ? band.to : band.from;
    let x = c.x0;
    let passages = 0;
    const blocks: Array<{ x: number; w: number }> = [];
    while (x <= c.x1) {
        const w = Math.min(rng.int(3, 5), c.x1 - x + 1);
        blocks.push({ x, w });
        x += w;
        if (x > c.x1) break;
        if (chance(rng, 0.35)) {
            x += rng.int(1, 2);
            passages++;
        }
    }
    if (band.mustPass && passages === 0 && blocks.length > 0) {
        const widest = blocks.reduce((a, b) => (b.w > a.w ? b : a));
        const gapAt = widest.x + Math.floor(widest.w / 2);
        blocks.splice(blocks.indexOf(widest), 1, { x: widest.x, w: gapAt - widest.x }, { x: gapAt + 1, w: widest.x + widest.w - gapAt - 1 });
    }
    for (const block of blocks) {
        if (block.w <= 0) continue;
        const notch = depth >= 2 && block.w >= 3 && chance(rng, 0.55) ? block.x + rng.int(1, block.w - 2) : -1;
        const cells = rectCells({ x: block.x, y: band.from, w: block.w, h: depth }).filter(p => !(p.x === notch && p.y === faceRow));
        c.place(cells, 'wall', 'structural');
    }
}

function vehicle(c: Canvas, rng: Rng, lane: (p: Pos) => boolean): boolean {
    const len = rng.int(2, 3);
    const options: Pos[][] = [];
    for (const origin of c.floorCells(lane)) {
        const cells: Pos[] = [];
        for (let i = 0; i < len; i++) cells.push({ x: origin.x + i, y: origin.y });
        if (cells.every(p => c.free(p.x, p.y) && lane(p)) && c.clearAround(cells, 1)) options.push(cells);
    }
    const chosen = pickOne(options, rng);
    return !!chosen && c.tryPlace(chosen, 'cover', 'optional');
}

function extra(c: Canvas, rng: Rng): boolean {
    const roll = rng.next();
    if (roll < 0.5 && vehicle(c, rng, () => true)) return true;
    if (roll < 0.8 && placeIsolated(c, rng, chance(rng, 0.5) ? 'single' : 'vbar', 'cover', 1)) return true;
    return difficultPatch(c, rng, rng.int(1, 3));
}

export const STREET_AREA: AreaDefinition = {
    build(c, target, rng) {
        const flip = chance(rng, 0.5);
        const row = (y: number) => (flip ? c.height - 1 - y : y);
        const alley = c.height >= 13 ? 3 : 0;
        const rest = c.height - alley;
        const laneHeight = c.height >= 10 ? 6 : 5;
        const north = chance(rng, 0.5) ? Math.floor((rest - laneHeight) / 2) : Math.ceil((rest - laneHeight) / 2);
        const south = rest - laneHeight - north;
        const bands: Band[] = [];
        if (north > 0) {
            const a = row(alley);
            const b = row(alley + north - 1);
            bands.push({ from: Math.min(a, b), to: Math.max(a, b), faces: flip ? 'up' : 'down', mustPass: alley > 0 });
        }
        if (south > 0) {
            const a = row(c.height - south);
            const b = row(c.height - 1);
            bands.push({ from: Math.min(a, b), to: Math.max(a, b), faces: flip ? 'down' : 'up', mustPass: false });
        }
        for (const band of bands) buildBand(c, band, rng);
        const laneTop = Math.min(row(alley + north), row(alley + north + laneHeight - 1));
        const laneBottom = Math.max(row(alley + north), row(alley + north + laneHeight - 1));
        const inLane = (p: Pos) => p.y >= laneTop && p.y <= laneBottom;
        for (let i = 0; i < 40 && c.count() < target; i++) {
            const roll = rng.next();
            if (roll < 0.55) vehicle(c, rng, inLane);
            else if (roll < 0.85) placeIsolated(c, rng, chance(rng, 0.6) ? 'single' : 'vbar', 'cover', 1, inLane);
            else difficultPatch(c, rng, rng.int(1, 3), inLane);
        }
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateStreet(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('street', STREET_AREA, width, height, density, rng);
}
