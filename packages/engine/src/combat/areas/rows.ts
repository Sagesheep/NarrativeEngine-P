import { Canvas, chance, clamp, pickOne } from './canvas';
import type { AreaLayout } from './canvas';
import { fillTo, runArea } from './bands';
import type { AreaDefinition } from './bands';
import { difficultPatch } from './open';
import type { MapDensity, Pos, Rng } from '../types';

const MIN_SEGMENT = 4;
const MAX_SEGMENT = 7;
const CROSS_GAP = 2;
const PITCH = 3;

type Segment = { from: number; len: number };

function lineSegments(length: number, coverage: number, rng: Rng, parity: number): Segment[] {
    const cover = clamp(coverage, MIN_SEGMENT, length - CROSS_GAP);
    if (cover >= 2 * MIN_SEGMENT && length - cover >= CROSS_GAP) {
        const free = length - cover - CROSS_GAP;
        const lead = rng.int(0, free);
        const first = clamp(Math.round(cover / 2) + (parity % 2 === 0 ? 1 : -1) * rng.int(0, 1), MIN_SEGMENT, Math.min(MAX_SEGMENT, cover - MIN_SEGMENT));
        const second = Math.min(MAX_SEGMENT, cover - first);
        return [{ from: lead, len: first }, { from: lead + first + CROSS_GAP, len: second }];
    }
    const len = Math.min(cover, MAX_SEGMENT);
    const free = length - len;
    const lead = free < 2 * CROSS_GAP ? (chance(rng, 0.5) ? 0 : free) : clamp(Math.round(free / 2) + rng.int(-1, 1), 0, free);
    return [{ from: lead, len }];
}

function extendRow(c: Canvas, rng: Rng): boolean {
    const ends: Pos[] = [];
    for (const piece of c.pieces) {
        if (piece.tile !== 'cover' || piece.cells.length < MIN_SEGMENT) continue;
        const a = c.posOf(piece.cells[0]);
        const b = c.posOf(piece.cells[piece.cells.length - 1]);
        const dx = Math.sign(b.x - a.x);
        const dy = Math.sign(b.y - a.y);
        ends.push({ x: a.x - dx, y: a.y - dy }, { x: b.x + dx, y: b.y + dy });
    }
    const spot = pickOne(ends.filter(p => c.free(p.x, p.y)), rng);
    return !!spot && c.tryPlace([spot], 'cover', 'optional');
}

function extra(c: Canvas, rng: Rng): boolean {
    if (chance(rng, 0.5) && extendRow(c, rng)) return true;
    return difficultPatch(c, rng, rng.int(2, 3));
}

export const ROWS_AREA: AreaDefinition = {
    build(c, target, rng) {
        const vertical = chance(rng, 0.6);
        const lines: number[] = [];
        if (vertical) {
            for (let x = c.x0 + rng.int(1, 2); x <= c.x1 - 1; x += PITCH) lines.push(x);
        } else {
            for (let y = rng.int(1, 2); y <= c.height - 2; y += PITCH) lines.push(y);
        }
        const length = vertical ? c.height : c.innerWidth;
        const perLine = Math.min(length - CROSS_GAP, Math.max(MIN_SEGMENT, Math.round(target / Math.max(1, lines.length))));
        let count = clamp(Math.round(target / perLine), 1, lines.length);
        const kept = [...lines];
        while (kept.length > count) kept.splice(kept.length % 2 === 0 ? 0 : kept.length - 1, 1);
        count = kept.length;
        kept.forEach((line, i) => {
            const share = Math.floor(target / count) + (i < target % count ? 1 : 0);
            for (const seg of lineSegments(length, share, rng, i)) {
                const cells: Pos[] = [];
                for (let k = 0; k < seg.len; k++) {
                    const along = seg.from + k;
                    cells.push(vertical ? { x: line, y: along } : { x: c.x0 + along, y: line });
                }
                c.tryPlace(cells, 'cover', 'optional');
            }
        });
        fillTo(c, target, [0, c.height - 1], rng, extra);
    },
    extra,
};

export function generateRows(width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    return runArea('rows', ROWS_AREA, width, height, density, rng);
}
