import { createRng } from './rng';
import { TILE_KINDS, inBounds, isFullyConnected, isWalkable, isWalkableTile, neighbours, speedOf } from './grid';
import { AREA_DEFINITIONS, AREA_GENERATORS, AREA_TYPES, Canvas, DEFAULT_HAZARD_LABELS, SPAWN_COLUMNS, bandCounts } from './areas/index';
import { clamp, pickOne } from './areas/canvas';
import { defaultLabels, normalizeLabels, resolveMapSpec } from './mapSpec';
import type { AreaType, CombatState, Grid, HazardKind, MapSize, MapSpec, Pos, ResolvedMapSpec, Rng, Side, TerrainLabels, Tile } from './types';

export const MAP_SIZES: Readonly<Record<MapSize, { width: number; height: number }>> = {
    small: { width: 10, height: 8 },
    medium: { width: 14, height: 10 },
    large: { width: 18, height: 14 },
};

export { SPAWN_COLUMNS, isFullyConnected };
export const DEFAULT_HAZARD_TYPE = 'fire';

const MIN_GRID_SIDE = 4;
const MAX_GRID_SIDE = 40;
const MAX_HAZARD_TILES = 15;
const MIN_HAZARD_TILES = 4;

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

export function normalizeMapSize(raw: unknown): MapSize {
    return raw === 'small' || raw === 'medium' || raw === 'large' ? raw : 'medium';
}

export function hasHazardFreeRoute(grid: Grid): boolean {
    const w = grid.width;
    const seen = new Set<number>();
    const stack: Pos[] = [];
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < Math.min(SPAWN_COLUMNS, w); x++) {
            const t = grid.tiles[y * w + x];
            if (!isWalkableTile(t) || t === 'hazard') continue;
            seen.add(y * w + x);
            stack.push({ x, y });
        }
    }
    while (stack.length > 0) {
        const here = stack.pop() as Pos;
        if (here.x >= w - SPAWN_COLUMNS) return true;
        for (const next of neighbours(grid, here)) {
            const idx = next.y * w + next.x;
            if (seen.has(idx) || grid.tiles[idx] === 'hazard') continue;
            seen.add(idx);
            stack.push(next);
        }
    }
    return false;
}

function hazardsClearOfSpawns(grid: Grid): boolean {
    for (let i = 0; i < grid.tiles.length; i++) {
        if (grid.tiles[i] !== 'hazard') continue;
        const x = i % grid.width;
        if (x <= SPAWN_COLUMNS || x >= grid.width - SPAWN_COLUMNS - 1) return false;
    }
    return true;
}

function spawnColumnsClear(grid: Grid): boolean {
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            if (x >= SPAWN_COLUMNS && x < grid.width - SPAWN_COLUMNS) continue;
            if (grid.tiles[y * grid.width + x] !== 'floor') return false;
        }
    }
    return true;
}

export function isPlayableMap(grid: Grid): boolean {
    return spawnColumnsClear(grid) && isFullyConnected(grid) && hasHazardFreeRoute(grid) && hazardsClearOfSpawns(grid);
}

function placeHazards(c: Canvas, area: AreaType, maxCount: number, rng: Rng): void {
    const total = clamp(Math.round(Math.min(maxCount * 0.35, c.innerWidth * c.height * 0.06)), MIN_HAZARD_TILES, MAX_HAZARD_TILES);
    const patches = total >= 9 ? rng.int(2, 3) : 2;
    const sizes: number[] = [];
    let left = total;
    for (let i = 0; i < patches; i++) {
        const share = i === patches - 1 ? left : Math.round(left / (patches - i));
        sizes.push(clamp(share, 2, 5));
        left -= sizes[i];
    }
    const lo = c.x0 + 1;
    const hi = c.x1 - 1;
    const allowed = (p: Pos) => p.x >= lo && p.x <= hi && c.free(p.x, p.y);
    for (const size of sizes) {
        for (let attempt = 0; attempt < 12; attempt++) {
            const seeds = c.floorCells(p => allowed(p) && c.neighbourCount(p.x, p.y, 'hazard', false) === 0);
            const wet = area === 'wetland' ? seeds.filter(p => c.neighbourCount(p.x, p.y, 'difficult', false) >= 2) : [];
            const start = pickOne(wet.length > 0 ? wet : seeds, rng);
            if (!start) return;
            const cells = c.blob(start, size, rng, allowed);
            if (cells.length < 2) continue;
            c.place(cells, 'hazard', 'hazard');
            if (hasHazardFreeRoute(c.grid())) break;
            c.removePiece(c.pieces.length - 1);
        }
    }
}

function lastIndex(c: Canvas, kind: 'optional' | 'structural'): number {
    for (let i = c.pieces.length - 1; i >= 0; i--) if (c.pieces[i].kind === kind) return i;
    return -1;
}

function trimOne(c: Canvas, rows: readonly [number, number]): boolean {
    const inRows = (idx: number) => {
        const y = Math.floor(idx / c.width);
        return y >= rows[0] && y <= rows[1];
    };
    for (let i = c.pieces.length - 1; i >= 0; i--) {
        const piece = c.pieces[i];
        if (piece.kind !== 'optional') continue;
        for (let k = piece.cells.length - 1; k >= 0; k--) {
            if (!inRows(piece.cells[k])) continue;
            c.tiles[piece.cells[k]] = 'floor';
            piece.cells.splice(k, 1);
            if (piece.cells.length === 0) c.pieces.splice(i, 1);
            return true;
        }
    }
    for (let i = c.pieces.length - 1; i >= 0; i--) {
        const piece = c.pieces[i];
        if (piece.kind !== 'structural') continue;
        for (let k = piece.cells.length - 1; k >= 0; k--) {
            const idx = piece.cells[k];
            if (!inRows(idx)) continue;
            const p = c.posOf(idx);
            if (c.neighbourCount(p.x, p.y, 'floor', false) === 0) continue;
            c.tiles[idx] = 'floor';
            piece.cells.splice(k, 1);
            if (piece.cells.length === 0) c.pieces.splice(i, 1);
            return true;
        }
    }
    return false;
}

function topUpDifficult(c: Canvas, rows: readonly [number, number], rng: Rng): boolean {
    const inRows = (p: Pos) => p.y >= rows[0] && p.y <= rows[1];
    const near = c.floorCells(p => inRows(p) && c.neighbourCount(p.x, p.y, 'difficult', false) > 0);
    const spot = pickOne(near.length > 0 ? near : c.floorCells(inRows), rng);
    return !!spot && c.place([spot], 'difficult', 'optional') > 0;
}

function enforceBand(c: Canvas, area: AreaType, spec: ResolvedMapSpec, rng: Rng): void {
    const { min, max, rows } = bandCounts(area, spec.density, c.width, c.height);
    for (let guard = 0; guard < 600 && c.count(rows) > max; guard++) if (!trimOne(c, rows)) break;
    for (let guard = 0; guard < 40 && c.count(rows) < min; guard++) AREA_DEFINITIONS[area].extra(c, rng);
    for (let guard = 0; guard < 600 && c.count(rows) < min; guard++) if (!topUpDifficult(c, rows, rng)) break;
    for (let guard = 0; guard < 600 && c.count(rows) > max; guard++) if (!trimOne(c, rows)) break;
}

function buildArea(area: AreaType, spec: ResolvedMapSpec, rng: Rng): Grid | null {
    const { width, height } = MAP_SIZES[spec.size];
    const c = Canvas.from(AREA_GENERATORS[area](width, height, spec.density, rng));
    while (!c.connected()) {
        let idx = lastIndex(c, 'optional');
        if (idx < 0) idx = lastIndex(c, 'structural');
        if (idx < 0) return null;
        c.removePiece(idx);
    }
    if (spec.hazard !== 'none') placeHazards(c, area, bandCounts(area, spec.density, width, height).max, rng);
    enforceBand(c, area, spec, rng);
    const grid: Grid = {
        width,
        height,
        tiles: [...c.tiles],
        area,
        labels: { ...spec.labels },
        ...(spec.hazard !== 'none' && c.tiles.includes('hazard') ? { hazardType: spec.hazard } : {}),
    };
    return isPlayableMap(grid) ? grid : null;
}

export function openArena(size: MapSize = 'medium', labels?: TerrainLabels): Grid {
    const { width, height } = MAP_SIZES[normalizeMapSize(size)];
    return { width, height, tiles: new Array<Tile>(width * height).fill('floor'), area: 'open', labels: { ...defaultLabels('open'), ...(labels ?? {}) } };
}

export function generateMap(spec: ResolvedMapSpec, rng: Rng): Grid {
    try {
        const built = buildArea(spec.area, spec, rng);
        if (built) return built;
        const fallback = buildArea('open', { ...spec, area: 'open' }, rng);
        if (fallback) return fallback;
    } catch (e) {
        void e;
    }
    return openArena(spec.size, spec.labels);
}

export function buildTerrain(spec: MapSpec | unknown, rng: Rng): Grid {
    return generateMap(resolveMapSpec(spec), rng);
}

export type SpawnEntry = { id: string; side: Side };

function zoneColumns(grid: Grid, side: Side): number[] {
    const w = grid.width;
    if (side === 'player' || side === 'ally') return [0, 1];
    if (side === 'enemy') return [w - 1, w - 2];
    const lo = Math.floor(w / 3);
    const hi = Math.ceil((2 * w) / 3) - 1;
    const mid = (w - 1) / 2;
    const cols: number[] = [];
    for (let x = lo; x <= hi; x++) cols.push(x);
    return cols.sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid) || a - b);
}

type Candidate = { p: Pos; score: number[] };

function compareScores(a: readonly number[], b: readonly number[]): number {
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
    return 0;
}

function keepsOpen(grid: Grid, occupied: ReadonlySet<number>, candidate: Pos): boolean {
    const blocked = new Set(occupied);
    blocked.add(candidate.y * grid.width + candidate.x);
    let start: Pos | null = null;
    let open = 0;
    for (let i = 0; i < grid.tiles.length; i++) {
        if (blocked.has(i) || !isWalkableTile(grid.tiles[i])) continue;
        open++;
        if (!start) start = { x: i % grid.width, y: Math.floor(i / grid.width) };
    }
    if (!start) return false;
    const seen = new Set<number>([start.y * grid.width + start.x]);
    const stack: Pos[] = [start];
    while (stack.length > 0) {
        const here = stack.pop() as Pos;
        for (const next of neighbours(grid, here)) {
            const idx = next.y * grid.width + next.x;
            if (blocked.has(idx) || seen.has(idx)) continue;
            seen.add(idx);
            stack.push(next);
        }
    }
    if (seen.size !== open) return false;
    for (const idx of blocked) {
        const p = { x: idx % grid.width, y: Math.floor(idx / grid.width) };
        if (!neighbours(grid, p).some(n => seen.has(n.y * grid.width + n.x))) return false;
    }
    return true;
}

export function placeCombatants(grid: Grid, entries: readonly SpawnEntry[], taken: readonly Pos[] = []): Record<string, Pos> {
    const out: Record<string, Pos> = {};
    const occupied = new Set<number>(taken.filter(p => inBounds(grid, p)).map(p => p.y * grid.width + p.x));
    const groups: Array<{ key: string; side: Side; ids: string[] }> = [];
    for (const e of entries) {
        const key = e.side === 'ally' ? 'player' : e.side;
        let group = groups.find(g => g.key === key);
        if (!group) {
            group = { key, side: e.side, ids: [] };
            groups.push(group);
        }
        group.ids.push(e.id);
    }
    for (const group of groups) {
        const cols = zoneColumns(grid, group.side);
        const n = group.ids.length;
        group.ids.forEach((id, k) => {
            const targetRow = Math.min(grid.height - 1, Math.floor(((k + 0.5) * grid.height) / n));
            const zone: Candidate[] = [];
            const wide: Candidate[] = [];
            for (let y = 0; y < grid.height; y++) {
                for (let x = 0; x < grid.width; x++) {
                    const idx = y * grid.width + x;
                    const tile = grid.tiles[idx];
                    if (occupied.has(idx) || !isWalkableTile(tile)) continue;
                    const rank = cols.indexOf(x);
                    if (rank >= 0 && tile === 'floor') zone.push({ p: { x, y }, score: [Math.abs(y - targetRow), rank, y] });
                    else wide.push({ p: { x, y }, score: [tile === 'floor' ? 0 : 1, Math.abs(x - cols[0]), Math.abs(y - targetRow), y, x] });
                }
            }
            zone.sort((a, b) => compareScores(a.score, b.score));
            wide.sort((a, b) => compareScores(a.score, b.score));
            const ordered = [...zone, ...wide];
            const chosen = ordered.find(c => keepsOpen(grid, occupied, c.p))?.p ?? ordered[0]?.p;
            if (chosen) {
                out[id] = chosen;
                occupied.add(chosen.y * grid.width + chosen.x);
            }
        });
    }
    return out;
}

export function buildGrid(spec: MapSpec | unknown, sides: readonly SpawnEntry[], rng: Rng): { grid: Grid; positions: Record<string, Pos> } {
    const grid = buildTerrain(spec, rng);
    return { grid, positions: placeCombatants(grid, sides) };
}

export function buildMapFromSeed(spec: MapSpec | unknown, mapSeed: number): Grid {
    return buildTerrain(spec, createRng(mapSeed, 0));
}

export function isValidGrid(raw: unknown): raw is Grid {
    const g = asRecord(raw);
    if (!g) return false;
    const { width, height, tiles } = g;
    if (typeof width !== 'number' || typeof height !== 'number' || !Number.isInteger(width) || !Number.isInteger(height)) return false;
    if (width < MIN_GRID_SIDE || height < MIN_GRID_SIDE || width > MAX_GRID_SIDE || height > MAX_GRID_SIDE) return false;
    if (!Array.isArray(tiles) || tiles.length !== width * height) return false;
    return tiles.every(t => (TILE_KINDS as readonly unknown[]).includes(t));
}

function hazardLabelFor(hazardType: unknown): string {
    if (typeof hazardType !== 'string' || !hazardType.trim()) return DEFAULT_HAZARD_LABELS.none;
    const known = DEFAULT_HAZARD_LABELS[hazardType as HazardKind] as string | undefined;
    return known ?? (normalizeLabels({ hazard: hazardType })?.hazard || DEFAULT_HAZARD_LABELS.none);
}

export function withMapLabels(grid: Grid): Grid {
    const area: AreaType = (AREA_TYPES as readonly unknown[]).includes(grid.area) ? grid.area as AreaType : 'open';
    const labels = { ...defaultLabels(area), hazard: hazardLabelFor(grid.hazardType), ...(normalizeLabels(grid.labels) ?? {}) };
    const complete = grid.area === area && (['wall', 'cover', 'difficult', 'hazard'] as const).every(k => grid.labels?.[k] === labels[k]);
    return complete ? grid : { ...grid, area, labels };
}

export function ensureGrid(state: CombatState): CombatState {
    const validGrid = isValidGrid(state.grid);
    const grid = validGrid ? withMapLabels(state.grid as Grid) : openArena('medium');
    let changed = !validGrid || grid !== state.grid;
    const ids = [...state.order, ...Object.keys(state.combatants).filter(id => !state.order.includes(id))];
    const kept: Pos[] = [];
    const missing: SpawnEntry[] = [];
    for (const id of ids) {
        const c = state.combatants[id];
        if (!c) continue;
        const p = c.position;
        const valid = !!p && inBounds(grid, p) && isWalkable(grid, p) && !kept.some(k => k.x === p.x && k.y === p.y);
        if (valid && validGrid) kept.push(p as Pos);
        else missing.push({ id, side: c.side });
    }
    let combatants = state.combatants;
    if (missing.length > 0) {
        changed = true;
        const placed = placeCombatants(grid, missing, kept);
        combatants = { ...state.combatants };
        for (const entry of missing) {
            const pos = placed[entry.id];
            if (pos) combatants[entry.id] = { ...combatants[entry.id], position: pos };
        }
    }
    const currentId = state.order[state.turnIndex];
    let turn = state.turn;
    if (!turn && currentId && combatants[currentId]) {
        changed = true;
        turn = { actorId: currentId, moveLeft: speedOf(combatants[currentId]), actionUsed: false };
    }
    const turnCount = typeof state.turnCount === 'number' && Number.isFinite(state.turnCount) ? state.turnCount : 1;
    if (turnCount !== state.turnCount) changed = true;
    if (!changed) return state;
    return { ...state, grid, combatants, ...(turn ? { turn } : {}), turnCount };
}
