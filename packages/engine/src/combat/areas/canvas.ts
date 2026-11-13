import { isFullyConnected } from '../grid';
import type { Grid, Pos, Rng, Tile } from '../types';

export const SPAWN_COLUMNS = 2;

export type PieceKind = 'structural' | 'optional' | 'hazard';

export type Piece = { kind: PieceKind; tile: Tile; cells: number[] };

export type AreaLayout = { width: number; height: number; tiles: Tile[]; pieces: Piece[] };

export type Rect = { x: number; y: number; w: number; h: number };

const AROUND: readonly Pos[] = [
    { x: -1, y: -1 }, { x: 0, y: -1 }, { x: 1, y: -1 },
    { x: -1, y: 0 }, { x: 1, y: 0 },
    { x: -1, y: 1 }, { x: 0, y: 1 }, { x: 1, y: 1 },
];

const ORTHO: readonly Pos[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

export function shuffle<T>(list: T[], rng: Rng): T[] {
    for (let i = list.length - 1; i > 0; i--) {
        const j = rng.int(0, i);
        [list[i], list[j]] = [list[j], list[i]];
    }
    return list;
}

export function pickOne<T>(list: readonly T[], rng: Rng): T | undefined {
    return list.length === 0 ? undefined : list[rng.int(0, list.length - 1)];
}

export function chance(rng: Rng, p: number): boolean {
    return rng.next() < p;
}

export function clamp(n: number, lo: number, hi: number): number {
    return Math.max(lo, Math.min(hi, n));
}

export function rectCells(r: Rect): Pos[] {
    const out: Pos[] = [];
    for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) out.push({ x, y });
    return out;
}

export class Canvas {
    readonly width: number;
    readonly height: number;
    readonly tiles: Tile[];
    readonly pieces: Piece[];
    readonly x0: number;
    readonly x1: number;

    constructor(width: number, height: number, tiles?: Tile[], pieces?: Piece[]) {
        this.width = width;
        this.height = height;
        this.tiles = tiles ? [...tiles] : new Array<Tile>(width * height).fill('floor');
        this.pieces = pieces ? pieces.map(p => ({ ...p, cells: [...p.cells] })) : [];
        this.x0 = SPAWN_COLUMNS;
        this.x1 = width - SPAWN_COLUMNS - 1;
    }

    static from(layout: AreaLayout): Canvas {
        return new Canvas(layout.width, layout.height, layout.tiles, layout.pieces);
    }

    get innerWidth(): number {
        return this.x1 - this.x0 + 1;
    }

    index(x: number, y: number): number {
        return y * this.width + x;
    }

    posOf(index: number): Pos {
        return { x: index % this.width, y: Math.floor(index / this.width) };
    }

    inside(x: number, y: number): boolean {
        return x >= 0 && y >= 0 && x < this.width && y < this.height;
    }

    inner(x: number, y: number): boolean {
        return y >= 0 && y < this.height && x >= this.x0 && x <= this.x1;
    }

    get(x: number, y: number): Tile {
        if (!this.inside(x, y)) return 'wall';
        return this.tiles[this.index(x, y)];
    }

    free(x: number, y: number): boolean {
        return this.inner(x, y) && this.tiles[this.index(x, y)] === 'floor';
    }

    set(x: number, y: number, tile: Tile): void {
        if (this.inner(x, y)) this.tiles[this.index(x, y)] = tile;
    }

    place(cells: readonly Pos[], tile: Tile, kind: PieceKind): number {
        const placed: number[] = [];
        for (const c of cells) {
            if (!this.free(c.x, c.y)) continue;
            const idx = this.index(c.x, c.y);
            if (placed.includes(idx)) continue;
            this.tiles[idx] = tile;
            placed.push(idx);
        }
        if (placed.length > 0) this.pieces.push({ kind, tile, cells: placed });
        return placed.length;
    }

    tryPlace(cells: readonly Pos[], tile: Tile, kind: PieceKind, whole = true): boolean {
        if (cells.length === 0) return false;
        if (whole && !cells.every(c => this.free(c.x, c.y))) return false;
        if (this.place(cells, tile, kind) === 0) return false;
        if (tile !== 'wall' && tile !== 'cover') return true;
        if (this.connected()) return true;
        this.removePiece(this.pieces.length - 1);
        return false;
    }

    removePiece(i: number): void {
        const piece = this.pieces[i];
        if (!piece) return;
        for (const idx of piece.cells) this.tiles[idx] = 'floor';
        this.pieces.splice(i, 1);
    }

    claim(kind: PieceKind): void {
        const owned = new Set<number>();
        for (const p of this.pieces) for (const idx of p.cells) owned.add(idx);
        const seen = new Set<number>();
        for (let y = 0; y < this.height; y++) {
            for (let x = this.x0; x <= this.x1; x++) {
                const idx = this.index(x, y);
                const tile = this.tiles[idx];
                if (tile === 'floor' || owned.has(idx) || seen.has(idx)) continue;
                const cells: number[] = [idx];
                seen.add(idx);
                for (let k = 0; k < cells.length; k++) {
                    const here = this.posOf(cells[k]);
                    for (const d of ORTHO) {
                        const nx = here.x + d.x;
                        const ny = here.y + d.y;
                        if (!this.inner(nx, ny)) continue;
                        const ni = this.index(nx, ny);
                        if (seen.has(ni) || owned.has(ni) || this.tiles[ni] !== tile) continue;
                        seen.add(ni);
                        cells.push(ni);
                    }
                }
                this.pieces.push({ kind, tile, cells });
            }
        }
    }

    connected(): boolean {
        return isFullyConnected(this.grid());
    }

    grid(): Grid {
        return { width: this.width, height: this.height, tiles: this.tiles };
    }

    count(rows: readonly [number, number] = [0, this.height - 1], tile?: Tile): number {
        let n = 0;
        for (let y = rows[0]; y <= rows[1]; y++) {
            for (let x = this.x0; x <= this.x1; x++) {
                const t = this.tiles[this.index(x, y)];
                if (tile ? t === tile : t !== 'floor') n++;
            }
        }
        return n;
    }

    clearAround(cells: readonly Pos[], radius = 1): boolean {
        const own = new Set(cells.map(c => this.index(c.x, c.y)));
        for (const c of cells) {
            for (let dy = -radius; dy <= radius; dy++) {
                for (let dx = -radius; dx <= radius; dx++) {
                    const x = c.x + dx;
                    const y = c.y + dy;
                    if (!this.inside(x, y) || own.has(this.index(x, y))) continue;
                    if (this.inner(x, y) && this.tiles[this.index(x, y)] !== 'floor') return false;
                }
            }
        }
        return true;
    }

    neighbourCount(x: number, y: number, tile: Tile, outside: boolean): number {
        let n = 0;
        for (const d of AROUND) {
            const nx = x + d.x;
            const ny = y + d.y;
            if (!this.inside(nx, ny)) {
                if (outside) n++;
                continue;
            }
            if (this.tiles[this.index(nx, ny)] === tile) n++;
        }
        return n;
    }

    distanceField(): number[] {
        const dist = new Array<number>(this.width * this.height).fill(Infinity);
        const queue: number[] = [];
        for (let y = 0; y < this.height; y++) {
            for (let x = this.x0; x <= this.x1; x++) {
                const idx = this.index(x, y);
                if (this.tiles[idx] !== 'floor') {
                    dist[idx] = 0;
                    queue.push(idx);
                }
            }
        }
        for (let k = 0; k < queue.length; k++) {
            const here = this.posOf(queue[k]);
            for (const d of AROUND) {
                const nx = here.x + d.x;
                const ny = here.y + d.y;
                if (!this.inside(nx, ny)) continue;
                const ni = this.index(nx, ny);
                if (dist[ni] <= dist[queue[k]] + 1) continue;
                dist[ni] = dist[queue[k]] + 1;
                queue.push(ni);
            }
        }
        return dist;
    }

    floorCells(filter?: (p: Pos) => boolean): Pos[] {
        const out: Pos[] = [];
        for (let y = 0; y < this.height; y++) {
            for (let x = this.x0; x <= this.x1; x++) {
                if (this.tiles[this.index(x, y)] !== 'floor') continue;
                const p = { x, y };
                if (!filter || filter(p)) out.push(p);
            }
        }
        return out;
    }

    spreadSpots(candidates: readonly Pos[], rng: Rng, take = 4): Pos[] {
        const dist = this.distanceField();
        const scored = shuffle([...candidates], rng).map(p => ({ p, d: Math.min(dist[this.index(p.x, p.y)], 6) }));
        scored.sort((a, b) => b.d - a.d);
        return scored.slice(0, Math.max(1, take)).map(s => s.p);
    }

    blob(start: Pos, size: number, rng: Rng, allow: (p: Pos) => boolean): Pos[] {
        if (!allow(start)) return [];
        const cells: Pos[] = [start];
        const key = (p: Pos) => p.y * this.width + p.x;
        const have = new Set<number>([key(start)]);
        while (cells.length < size) {
            const frontier: Pos[] = [];
            for (const c of cells) {
                for (const d of ORTHO) {
                    const p = { x: c.x + d.x, y: c.y + d.y };
                    if (have.has(key(p)) || !allow(p)) continue;
                    if (!frontier.some(f => f.x === p.x && f.y === p.y)) frontier.push(p);
                }
            }
            const next = pickOne(frontier, rng);
            if (!next) break;
            cells.push(next);
            have.add(key(next));
        }
        return cells;
    }

    layout(): AreaLayout {
        return { width: this.width, height: this.height, tiles: [...this.tiles], pieces: this.pieces.map(p => ({ ...p, cells: [...p.cells] })) };
    }
}

export type ShapeName = 'single' | 'hbar' | 'vbar' | 'square' | 'ell';

export function shapeAt(origin: Pos, shape: ShapeName, rng: Rng): Pos[] {
    const { x, y } = origin;
    switch (shape) {
        case 'single': return [{ x, y }];
        case 'hbar': return [{ x, y }, { x: x + 1, y }];
        case 'vbar': return [{ x, y }, { x, y: y + 1 }];
        case 'square': return [{ x, y }, { x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
        case 'ell': {
            const flip = rng.int(0, 3);
            const base = [{ x, y }, { x: x + 1, y }, { x, y: y + 1 }];
            if (flip === 0) return base;
            if (flip === 1) return [{ x, y }, { x: x + 1, y }, { x: x + 1, y: y + 1 }];
            if (flip === 2) return [{ x, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
            return [{ x: x + 1, y }, { x, y: y + 1 }, { x: x + 1, y: y + 1 }];
        }
    }
}
