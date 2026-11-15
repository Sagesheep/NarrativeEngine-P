import { chance, pickOne, shuffle } from './canvas';
import type { Canvas } from './canvas';
import type { AreaType, Pos, Rng } from '../types';

const BLOCK_AREAS: ReadonlySet<AreaType> = new Set<AreaType>(['open', 'scattered', 'wetland', 'ruins', 'ledge']);

const BLOCK_SIZES: readonly (readonly [number, number])[] = [[2, 2], [3, 2], [2, 3], [3, 3], [4, 3], [2, 2], [3, 2]];

const ORTHO: readonly Pos[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

const FIELD_STEP = 4;

type Field = (x: number, y: number) => number;

function makeField(c: Canvas, rng: Rng): Field {
    const cols = Math.ceil(c.width / FIELD_STEP) + 2;
    const rows = Math.ceil(c.height / FIELD_STEP) + 2;
    const lattice: number[] = [];
    for (let i = 0; i < cols * rows; i++) lattice.push(rng.next());
    const smooth = (t: number) => t * t * (3 - 2 * t);
    return (x, y) => {
        const fx = x / FIELD_STEP;
        const fy = y / FIELD_STEP;
        const ix = Math.floor(fx);
        const iy = Math.floor(fy);
        const tx = smooth(fx - ix);
        const ty = smooth(fy - iy);
        const at = (i: number, j: number) => lattice[j * cols + i];
        const top = at(ix, iy) * (1 - tx) + at(ix + 1, iy) * tx;
        const bottom = at(ix, iy + 1) * (1 - tx) + at(ix + 1, iy + 1) * tx;
        return top * (1 - ty) + bottom * ty;
    };
}

function attempt(c: Canvas, change: () => boolean): boolean {
    const snap = c.snapshot();
    if (change() && c.connected()) return true;
    c.restore(snap);
    return false;
}

function shiftPiece(c: Canvas, index: number, dx: number, dy: number): boolean {
    const piece = c.pieces[index];
    const own = new Set(piece.cells);
    const next = piece.cells.map(i => {
        const p = c.posOf(i);
        return { x: p.x + dx, y: p.y + dy };
    });
    if (!next.every(p => c.inner(p.x, p.y) && (c.tiles[c.index(p.x, p.y)] === 'floor' || own.has(c.index(p.x, p.y))))) return false;
    for (const i of piece.cells) c.tiles[i] = 'floor';
    piece.cells = next.map(p => c.index(p.x, p.y));
    for (const i of piece.cells) c.tiles[i] = piece.tile;
    return true;
}

function dropCell(c: Canvas, index: number, cell: number): boolean {
    const piece = c.pieces[index];
    const at = piece.cells.indexOf(cell);
    if (at < 0) return false;
    c.tiles[cell] = 'floor';
    piece.cells.splice(at, 1);
    if (piece.cells.length === 0) c.pieces.splice(index, 1);
    return true;
}

function growPiece(c: Canvas, index: number, field: Field, rng: Rng): boolean {
    const piece = c.pieces[index];
    const options: { cell: number; score: number }[] = [];
    for (const i of piece.cells) {
        const p = c.posOf(i);
        for (const d of ORTHO) {
            const x = p.x + d.x;
            const y = p.y + d.y;
            if (c.free(x, y)) options.push({ cell: c.index(x, y), score: field(x, y) + rng.next() * 0.5 });
        }
    }
    if (options.length === 0) return false;
    options.sort((a, b) => b.score - a.score);
    const chosen = options[0].cell;
    c.tiles[chosen] = piece.tile;
    piece.cells.push(chosen);
    return true;
}

function isEdge(c: Canvas, cell: number): boolean {
    const p = c.posOf(cell);
    return ORTHO.some(d => c.inner(p.x + d.x, p.y + d.y) && c.tiles[c.index(p.x + d.x, p.y + d.y)] === 'floor');
}

function erodePiece(c: Canvas, index: number, rng: Rng): boolean {
    const piece = c.pieces[index];
    if (piece.cells.length < 2) return false;
    const edge = piece.cells.filter(i => isEdge(c, i));
    const cell = pickOne(edge, rng);
    return cell !== undefined && dropCell(c, index, cell);
}

function gapPiece(c: Canvas, index: number, rng: Rng): boolean {
    const piece = c.pieces[index];
    if (piece.cells.length < 3) return false;
    const cell = piece.cells[rng.int(1, piece.cells.length - 2)];
    return dropCell(c, index, cell);
}

function strayTile(area: AreaType, rng: Rng): 'cover' | 'wall' {
    return area === 'ruins' && chance(rng, 0.4) ? 'wall' : 'cover';
}

function coverNear(c: Canvas, p: Pos): number {
    let n = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (c.get(p.x + dx, p.y + dy) === 'cover') n++;
    return n;
}

function addStray(c: Canvas, area: AreaType, rows: readonly [number, number], field: Field, rng: Rng): boolean {
    const spots = c.floorCells(p => p.y >= rows[0] && p.y <= rows[1]);
    if (spots.length === 0) return false;
    const picks = shuffle([...spots], rng).slice(0, 8);
    const scored = picks.map(p => ({ p, score: field(p.x, p.y) + 0.12 * coverNear(c, p) + rng.next() * 0.3 }));
    scored.sort((a, b) => b.score - a.score);
    for (const s of scored) {
        if (c.tryPlace([s.p], strayTile(area, rng), 'optional')) return true;
    }
    return false;
}

function placeBlock(c: Canvas, rows: readonly [number, number], room: number, rng: Rng): boolean {
    const sizes = BLOCK_SIZES.filter(([w, h]) => w * h <= room);
    const [w, h] = pickOne(sizes, rng) ?? [0, 0];
    if (w === 0) return false;
    for (let attempts = 0; attempts < 14; attempts++) {
        const x = rng.int(c.x0, c.x1 - w + 1);
        const y = rng.int(rows[0], rows[1] - h + 1);
        const cells: Pos[] = [];
        for (let dy = 0; dy < h; dy++) for (let dx = 0; dx < w; dx++) cells.push({ x: x + dx, y: y + dy });
        if (c.tryPlace(cells, 'wall', 'structural')) return true;
    }
    return false;
}

function removableCells(c: Canvas, field: Field): { index: number; cell: number; score: number }[] {
    const out: { index: number; cell: number; score: number }[] = [];
    c.pieces.forEach((piece, index) => {
        if (piece.kind !== 'optional' || piece.tile === 'difficult') return;
        for (const cell of piece.cells) {
            const p = c.posOf(cell);
            out.push({ index, cell, score: field(p.x, p.y) });
        }
    });
    return out.sort((a, b) => a.score - b.score);
}

export function roughen(c: Canvas, area: AreaType, rows: readonly [number, number], max: number, rng: Rng): void {
    const before = c.count(rows);
    const field = makeField(c, rng);
    for (let i = c.pieces.length - 1; i >= 0; i--) {
        const piece = c.pieces[i];
        if (!piece || piece.kind === 'hazard') continue;
        const movable = piece.tile === 'cover' || (piece.tile === 'wall' && piece.kind === 'optional');
        const first = c.posOf(piece.cells[0]);
        if (piece.kind === 'optional' && piece.tile === 'cover' && field(first.x, first.y) < 0.28 && chance(rng, 0.5)) {
            attempt(c, () => {
                c.removePiece(i);
                return true;
            });
            continue;
        }
        if (movable && chance(rng, 0.6)) {
            const reach = piece.cells.length === 1 ? 2 : 1;
            for (let k = 0; k < 3; k++) {
                const dx = rng.int(-reach, reach);
                const dy = rng.int(-reach, reach);
                if ((dx !== 0 || dy !== 0) && attempt(c, () => shiftPiece(c, i, dx, dy))) break;
            }
        }
        if (c.pieces[i] && c.pieces[i].cells.length >= 3 && chance(rng, piece.kind === 'structural' ? 0.2 : 0.3)) attempt(c, () => gapPiece(c, i, rng));
        if (c.pieces[i] && (piece.tile === 'cover' || piece.tile === 'wall') && chance(rng, 0.4)) {
            const grow = piece.kind === 'optional' ? chance(rng, 0.65) : chance(rng, 0.5);
            attempt(c, () => (grow ? growPiece(c, i, field, rng) : erodePiece(c, i, rng)));
        }
        if (c.pieces[i] && piece.tile === 'difficult' && chance(rng, 0.3)) attempt(c, () => growPiece(c, i, field, rng));
    }
    for (let n = rng.int(1, 3); n > 0; n--) addStray(c, area, rows, field, rng);
    if (BLOCK_AREAS.has(area) && chance(rng, 0.55)) {
        const room = Math.min(12, max - c.count(rows));
        if (room >= 4) attempt(c, () => placeBlock(c, rows, room, rng));
    }
    for (let guard = 0; guard < 80 && c.count(rows) > before; guard++) {
        const victim = removableCells(c, field)[0];
        if (!victim) break;
        attempt(c, () => dropCell(c, victim.index, victim.cell));
    }
    for (let guard = 0; guard < 80 && c.count(rows) < before; guard++) addStray(c, area, rows, field, rng);
}
