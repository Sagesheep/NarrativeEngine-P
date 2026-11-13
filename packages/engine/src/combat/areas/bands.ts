import type { AreaType, MapDensity, Rng } from '../types';
import { Canvas, SPAWN_COLUMNS } from './canvas';
import type { AreaLayout } from './canvas';

export const AREA_TYPES: readonly AreaType[] = ['open', 'scattered', 'room', 'rows', 'corridors', 'cavern', 'street', 'ledge', 'ruins', 'wetland'];

export const MAP_DENSITIES: readonly MapDensity[] = ['sparse', 'normal', 'dense'];

export const STRUCTURAL_AREAS: ReadonlySet<AreaType> = new Set<AreaType>(['corridors', 'cavern', 'street', 'ledge', 'wetland']);

const OPEN_BANDS: Readonly<Record<MapDensity, readonly [number, number]>> = {
    sparse: [0.08, 0.14],
    normal: [0.14, 0.22],
    dense: [0.22, 0.30],
};

const STRUCTURAL_BANDS: Readonly<Record<MapDensity, readonly [number, number]>> = {
    sparse: [0.30, 0.45],
    normal: [0.35, 0.50],
    dense: [0.40, 0.55],
};

const EPSILON = 1e-9;

export function shareBand(area: AreaType, density: MapDensity): readonly [number, number] {
    return STRUCTURAL_AREAS.has(area) ? STRUCTURAL_BANDS[density] : OPEN_BANDS[density];
}

export function measuredRows(area: AreaType, height: number): [number, number] {
    return area === 'room' ? [1, height - 2] : [0, height - 1];
}

export type BandCounts = { min: number; max: number; cells: number; rows: [number, number] };

export function bandCounts(area: AreaType, density: MapDensity, width: number, height: number): BandCounts {
    const rows = measuredRows(area, height);
    const cells = Math.max(0, width - 2 * SPAWN_COLUMNS) * (rows[1] - rows[0] + 1);
    const [lo, hi] = shareBand(area, density);
    return { min: Math.ceil(lo * cells - EPSILON), max: Math.floor(hi * cells + EPSILON), cells, rows };
}

export function terrainShare(area: AreaType, grid: { width: number; height: number; tiles: readonly string[] }): number {
    const rows = measuredRows(area, grid.height);
    let total = 0;
    let blocked = 0;
    for (let y = rows[0]; y <= rows[1]; y++) {
        for (let x = SPAWN_COLUMNS; x < grid.width - SPAWN_COLUMNS; x++) {
            total++;
            if (grid.tiles[y * grid.width + x] !== 'floor') blocked++;
        }
    }
    return total > 0 ? blocked / total : 0;
}

export function pickTarget(min: number, max: number, rng: Rng): number {
    return min + Math.round((max - min) * (0.3 + 0.4 * rng.next()));
}

export function structuralTarget(cells: number, rng: Rng): number {
    return Math.round(cells * (0.32 + 0.05 * rng.next()));
}

export type AreaDefinition = {
    build(c: Canvas, target: number, rng: Rng): void;
    extra(c: Canvas, rng: Rng): boolean;
};

export function fillTo(c: Canvas, target: number, rows: readonly [number, number], rng: Rng, add: (c: Canvas, rng: Rng) => boolean, attempts = 80): void {
    for (let i = 0; i < attempts && c.count(rows) < target; i++) add(c, rng);
}

export function runArea(area: AreaType, def: AreaDefinition, width: number, height: number, density: MapDensity, rng: Rng): AreaLayout {
    const c = new Canvas(width, height);
    const { min, max } = bandCounts(area, density, width, height);
    def.build(c, pickTarget(min, max, rng), rng);
    return c.layout();
}
