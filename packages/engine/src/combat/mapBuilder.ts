import { createRng } from './rng';
import { TILE_KINDS, inBounds, isWalkable, isWalkableTile, neighbours, speedOf } from './grid';
import type { CombatState, Grid, MapSize, MapSpec, Pos, Rng, Side, Tile } from './types';

export const MAP_SIZES: Readonly<Record<MapSize, { width: number; height: number }>> = {
    small: { width: 10, height: 8 },
    medium: { width: 14, height: 10 },
    large: { width: 18, height: 14 },
};

export const SPAWN_COLUMNS = 2;
export const MAX_MAP_FEATURES = 6;
export const MAX_BLOCKED_SHARE = 0.25;
export const DEFAULT_HAZARD_TYPE = 'fire';

const MIN_GRID_SIDE = 4;
const MAX_GRID_SIDE = 40;

const KIND_PATTERNS: ReadonlyArray<[Exclude<Tile, 'floor'>, RegExp]> = [
    ['hazard', /\b(hazards?|fires?|flames?|lava|magma|acid|poison|toxic|spikes?|traps?|embers?|burning|electri\w*|caustic|brazier)\b/],
    ['wall', /\b(walls?|cliffs?|barricades?|fences?|palisades?|ruins?)\b/],
    ['cover', /\b(cover|crates?|boulders?|rocks?|pillars?|columns?|trees?|carts?|wagons?|barrels?|tables?|statues?|cars?|debris|sandbags?)\b/],
    ['difficult', /\b(difficult|mud|rubble|water|shallows?|bushes|brush|undergrowth|snow|ice|swamp|marsh|sand|scree|thicket|bog)\b/],
];

const HAZARD_TYPES: ReadonlyArray<[string, RegExp]> = [
    ['fire', /\b(fires?|flames?|lava|magma|embers?|burning|brazier)\b/],
    ['acid', /\b(acid|caustic)\b/],
    ['poison', /\b(poison|toxic|venom)\b/],
    ['lightning', /\b(electri\w*|lightning|sparks?)\b/],
    ['piercing', /\b(spikes?|traps?|thorns?)\b/],
    ['cold', /\b(cold|frost|freezing)\b/],
];

type ParsedSpec = { size: MapSize; theme?: string; features: Array<{ tile: Exclude<Tile, 'floor'>; kind: string; where: string }> };

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

export function tileForKind(kind: string): Exclude<Tile, 'floor'> | null {
    const lower = kind.trim().toLowerCase();
    if (lower === 'wall' || lower === 'cover' || lower === 'difficult' || lower === 'hazard') return lower;
    for (const [tile, re] of KIND_PATTERNS) if (re.test(lower)) return tile;
    return null;
}

export function normalizeMapSize(raw: unknown): MapSize {
    return raw === 'small' || raw === 'medium' || raw === 'large' ? raw : 'medium';
}

function parseSpec(raw: unknown): ParsedSpec {
    const rec = asRecord(raw);
    if (!rec) return { size: 'medium', features: [] };
    const theme = typeof rec.theme === 'string' && rec.theme.trim() ? rec.theme.trim().slice(0, 160) : undefined;
    const list = Array.isArray(rec.features) ? rec.features : [];
    const features: ParsedSpec['features'] = [];
    for (const item of list) {
        const f = asRecord(item);
        if (!f || typeof f.kind !== 'string') continue;
        const tile = tileForKind(f.kind);
        if (!tile) continue;
        features.push({ tile, kind: f.kind.toLowerCase(), where: typeof f.where === 'string' ? f.where.toLowerCase() : '' });
        if (features.length >= MAX_MAP_FEATURES) break;
    }
    return { size: normalizeMapSize(rec.size), ...(theme ? { theme } : {}), features };
}

function hazardTypeFrom(text: string): string | null {
    for (const [type, re] of HAZARD_TYPES) if (re.test(text)) return type;
    return null;
}

type Region = (p: Pos) => boolean;

function regionFor(where: string, width: number, height: number, rng: Rng): Region {
    const north = /\bnorth/.test(where);
    const south = /\bsouth/.test(where);
    const east = /\beast/.test(where);
    const west = /\bwest/.test(where);
    const centre = /\b(centre|center|middle|central)\b/.test(where);
    const corner = /\bcorners?\b/.test(where);
    const edge = /\b(edges?|sides?|perimeter|border|rim)\b/.test(where);
    const minX = SPAWN_COLUMNS;
    const maxX = width - 1 - SPAWN_COLUMNS;
    if (corner) {
        const top = north || (!south && rng.next() < 0.5);
        const left = west || (!east && rng.next() < 0.5);
        return p => (left ? p.x <= minX + 2 : p.x >= maxX - 2) && (top ? p.y <= 2 : p.y >= height - 3);
    }
    if (edge) {
        if (!north && !south && !east && !west) {
            const top = rng.next() < 0.5;
            return p => top ? p.y <= 1 : p.y >= height - 2;
        }
        return p => (!north || p.y <= 1) && (!south || p.y >= height - 2) && (!west || p.x <= minX + 1) && (!east || p.x >= maxX - 1);
    }
    if (north || south || east || west || centre) {
        return p => {
            if (north && p.y >= height / 3) return false;
            if (south && p.y < (2 * height) / 3) return false;
            if (west && p.x >= width / 3) return false;
            if (east && p.x < (2 * width) / 3) return false;
            if (centre && !north && !south && (p.y < height / 3 || p.y >= (2 * height) / 3)) return false;
            if (centre && !east && !west && (p.x < width / 3 || p.x >= (2 * width) / 3)) return false;
            return true;
        };
    }
    return () => true;
}

type Builder = {
    grid: Grid;
    cap: number;
    blocked: number;
};

function placeable(b: Builder, p: Pos): boolean {
    return inBounds(b.grid, p) && p.x >= SPAWN_COLUMNS && p.x < b.grid.width - SPAWN_COLUMNS && b.grid.tiles[p.y * b.grid.width + p.x] === 'floor';
}

function setTile(b: Builder, p: Pos, tile: Tile, placed: number[]): boolean {
    if (!placeable(b, p) || b.blocked >= b.cap) return false;
    const idx = p.y * b.grid.width + p.x;
    b.grid.tiles[idx] = tile;
    b.blocked += 1;
    placed.push(idx);
    return true;
}

function candidates(b: Builder, region: Region): Pos[] {
    const inRegion: Pos[] = [];
    const any: Pos[] = [];
    for (let y = 0; y < b.grid.height; y++) {
        for (let x = 0; x < b.grid.width; x++) {
            const p = { x, y };
            if (!placeable(b, p)) continue;
            any.push(p);
            if (region(p)) inRegion.push(p);
        }
    }
    return inRegion.length > 0 ? inRegion : any;
}

function pick<T>(list: readonly T[], rng: Rng): T | undefined {
    if (list.length === 0) return undefined;
    return list[rng.int(0, list.length - 1)];
}

const ORTHOGONAL: readonly Pos[] = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];

function growBlob(b: Builder, region: Region, tile: Tile, size: number, rng: Rng, placed: number[]): void {
    const start = pick(candidates(b, region), rng);
    if (!start || !setTile(b, start, tile, placed)) return;
    const blob: Pos[] = [start];
    while (blob.length < size) {
        const frontier: Pos[] = [];
        for (const cell of blob) {
            for (const d of ORTHOGONAL) {
                const p = { x: cell.x + d.x, y: cell.y + d.y };
                if (placeable(b, p) && !frontier.some(f => f.x === p.x && f.y === p.y)) frontier.push(p);
            }
        }
        const preferred = frontier.filter(region);
        const next = pick(preferred.length > 0 ? preferred : frontier, rng);
        if (!next || !setTile(b, next, tile, placed)) return;
        blob.push(next);
    }
}

function placeWall(b: Builder, region: Region, rng: Rng, placed: number[]): void {
    const runs = rng.int(1, 2);
    for (let r = 0; r < runs; r++) {
        const start = pick(candidates(b, region), rng);
        if (!start) return;
        const length = rng.int(3, 5);
        const horizontal = rng.next() < 0.5;
        const dir = horizontal ? { x: rng.next() < 0.5 ? 1 : -1, y: 0 } : { x: 0, y: rng.next() < 0.5 ? 1 : -1 };
        for (let i = 0; i < length; i++) {
            if (!setTile(b, { x: start.x + dir.x * i, y: start.y + dir.y * i }, 'wall', placed)) break;
        }
    }
}

function placeCover(b: Builder, region: Region, rng: Rng, placed: number[]): void {
    const clusters = rng.int(2, 3);
    for (let c = 0; c < clusters; c++) {
        const start = pick(candidates(b, region), rng);
        if (!start || !setTile(b, start, 'cover', placed)) return;
        if (rng.int(1, 2) === 2) {
            const options = ORTHOGONAL.map(d => ({ x: start.x + d.x, y: start.y + d.y })).filter(p => placeable(b, p));
            const second = pick(options, rng);
            if (second) setTile(b, second, 'cover', placed);
        }
    }
}

function placeFeature(b: Builder, tile: Exclude<Tile, 'floor'>, where: string, rng: Rng): number[] {
    const placed: number[] = [];
    const region = regionFor(where, b.grid.width, b.grid.height, rng);
    if (tile === 'wall') placeWall(b, region, rng, placed);
    else if (tile === 'cover') placeCover(b, region, rng, placed);
    else if (tile === 'difficult') growBlob(b, region, 'difficult', rng.int(4, 8), rng, placed);
    else growBlob(b, region, 'hazard', rng.int(2, 4), rng, placed);
    return placed;
}

export function isFullyConnected(grid: Grid): boolean {
    let start: Pos | null = null;
    let walkable = 0;
    for (let y = 0; y < grid.height; y++) {
        for (let x = 0; x < grid.width; x++) {
            if (isWalkableTile(grid.tiles[y * grid.width + x])) {
                walkable++;
                if (!start) start = { x, y };
            }
        }
    }
    if (!start) return false;
    const seen = new Set<number>([start.y * grid.width + start.x]);
    const stack: Pos[] = [start];
    while (stack.length > 0) {
        const here = stack.pop() as Pos;
        for (const next of neighbours(grid, here)) {
            const idx = next.y * grid.width + next.x;
            if (seen.has(idx)) continue;
            seen.add(idx);
            stack.push(next);
        }
    }
    return seen.size === walkable;
}

export function openArena(size: MapSize = 'medium'): Grid {
    const { width, height } = MAP_SIZES[size];
    return { width, height, tiles: new Array<Tile>(width * height).fill('floor') };
}

export function buildTerrain(spec: MapSpec | unknown, rng: Rng): Grid {
    const parsed = parseSpec(spec);
    const grid = openArena(parsed.size);
    if (parsed.theme) grid.theme = parsed.theme;
    const builder: Builder = { grid, cap: Math.floor(grid.width * grid.height * MAX_BLOCKED_SHARE), blocked: 0 };
    const placed: Array<{ tile: Tile; kind: string; cells: number[] }> = [];
    for (const feature of parsed.features) {
        const cells = placeFeature(builder, feature.tile, feature.where, rng);
        if (cells.length > 0) placed.push({ tile: feature.tile, kind: feature.kind, cells });
    }
    while (!isFullyConnected(grid) && placed.length > 0) {
        const last = placed.pop() as { cells: number[] };
        for (const idx of last.cells) grid.tiles[idx] = 'floor';
    }
    if (grid.tiles.includes('hazard')) {
        const fromKinds = placed.filter(p => p.tile === 'hazard').map(p => hazardTypeFrom(p.kind)).find(Boolean);
        grid.hazardType = fromKinds ?? hazardTypeFrom((parsed.theme ?? '').toLowerCase()) ?? DEFAULT_HAZARD_TYPE;
    }
    return grid;
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

export function ensureGrid(state: CombatState): CombatState {
    const validGrid = isValidGrid(state.grid);
    const grid = validGrid ? state.grid as Grid : openArena('medium');
    let changed = !validGrid;
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
