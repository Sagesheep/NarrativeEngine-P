import type { CombatAreaType, CombatGrid, CombatPos, CombatTerrainLabels, CombatTile, CombatTileStyle } from '../../types';
import { AREA_DEFAULTS, FLOOR_KEYWORDS, GENERIC_FALLBACK, HAZARD_CANDIDATES, phraseIn, tileHash } from './tileset';
import { pixelPath } from './pixelCatalog';
import type { PixelCatalog, PixelProp } from './pixelCatalog';
import { patchValue, pickWeighted, wander } from './pixelNoise';
import type { Weighted } from './pixelNoise';
import {
    HAZARD_PIXEL_EXTRA, PIXEL_COMPANIONS, PIXEL_PLACE_KEYWORDS, PIXEL_SETS, allowedInSet, areaAllowsFloor, canMirror, setIdForFloor,
} from './pixelSets';
import type { PixelPieceKind } from './pixelSets';

export const PIXEL_ALIASES: Readonly<Record<string, readonly string[]>> = {
    earth: ['dirt-path'],
    'earth-alt': ['dirt-path'],
    'forest-floor': ['grass'],
    'graveyard-soil': ['mossy-stone'],
    gravel: ['dirt-path'],
    'rooftop-gravel': ['concrete'],
    'shallow-water': ['swamp-water', 'marsh-water'],
    'deep-water': ['swamp-water'],
    'swamp-water': ['marsh-water'],
    'nightclub-floor': ['tiled-floor'],
    ice: ['snow'],
    'cave-crystal': ['cave-stone'],
    'scorched-earth': ['dirt-path'],
    'cracked-wasteland': ['sand'],
    tree: ['tree-oak', 'tree-pine', 'dead-tree', 'stump'],
    rocks: ['rock', 'fallen-stones'],
    boulder: ['boulder', 'rock'],
    table: ['desk'],
    crates: ['crates', 'barrels', 'pallet', 'oil-drums', 'cargo-pod', 'locker', 'hay-bales'],
    shelving: ['locker', 'server-rack', 'pallet'],
    'dense-forest': ['dense-forest', 'tree-pine', 'tree-oak', 'mangrove-tree'],
    'cave-rock': ['cave-rock', 'rock-large'],
    'sheer-drop': ['sheer-drop', 'cliff'],
    'stone-brick': ['stone-brick', 'stone-wall', 'brick-wall'],
    'building-roof': ['building-roof', 'house-timber', 'cottage-thatched'],
    'concrete-wall': ['concrete-wall', 'brick-wall'],
    'metal-bulkhead': ['metal-bulkhead', 'concrete-wall'],
    'wooden-wall': ['wooden-wall', 'palisade'],
    undergrowth: ['tall-grass'],
    debris: ['debris', 'trash', 'scrap'],
    cables: ['cables', 'scrap'],
    rubble: ['rubble', 'scree'],
};

export const DECAL_FLOORS: Readonly<Record<string, readonly string[]>> = {
    'flowers-yellow': ['grass'],
    'flowers-white': ['grass'],
    straw: ['wood-planks', 'dirt-road', 'dirt-path'],
    'floor-cracks': ['dungeon-flagstone', 'cave-stone', 'sewer-brick', 'stone-rampart', 'concrete', 'pavement', 'mossy-stone'],
    'moss-patch': ['dungeon-flagstone', 'sewer-brick', 'mossy-stone', 'cave-stone'],
    'road-lines': ['asphalt', 'asphalt-wet'],
    manhole: ['asphalt', 'pavement', 'city-cobblestone'],
    'oil-stain': ['asphalt', 'asphalt-wet', 'concrete', 'metal-plating'],
    'neon-glow': ['asphalt-wet', 'concrete'],
    'hazard-stripes': ['metal-plating', 'concrete', 'rusted-deck'],
    'deck-hatch': ['metal-plating', 'rusted-deck'],
    'lily-pads': ['swamp', 'swamp-water'],
    'dry-cracks': ['sand', 'dirt-path'],
    'snow-tracks': ['snow'],
};

const GENERIC_WORDS: ReadonlySet<string> = new Set(['large', 'small', 'big', 'tall', 'wall']);

export const DECAL_CHANCE = 1 / 8;

const DRIFT_SHARE = 0.4;

const LABEL_SHARE = 0.6;

const VARIANT_SWAP = 0.15;

const COMPANION_SHARE = 0.25;

export const FADED_OPACITY = 0.45;

export type PlacedProp = { id: string; kind: 'cover' | 'wall'; name: string; path: string; x: number; y: number; w: number; h: number; up: number; mirror: boolean };

export type PixelMarker = Exclude<CombatTile, 'floor'>;

export type PixelPlan = {
    width: number;
    height: number;
    floor: string;
    floorPaths: (string | null)[];
    fillPaths: (string | null)[];
    decalPaths: (string | null)[];
    overlayPaths: (string | null)[];
    markers: (PixelMarker | null)[];
    props: PlacedProp[];
    palettes: { cover: Weighted[]; wall: Weighted[]; fill: Weighted[] };
};

function namesFor(name: string): string[] {
    return [...new Set([...(PIXEL_ALIASES[name] ?? []), name])];
}

export function pickNames(pool: readonly string[], label: string | undefined, groups: readonly string[]): string[] {
    if (pool.length === 0) return [];
    if (label && label.trim()) {
        const phrase = pool.filter(n => phraseIn(label, n.replace(/-/g, ' ')));
        if (phrase.length > 0) return phrase;
        const token = pool.filter(n => n.split('-').some(w => w.length >= 3 && !GENERIC_WORDS.has(w) && phraseIn(label, w)));
        if (token.length > 0) return token;
    }
    for (const group of groups) {
        const hit = pool.filter(n => namesFor(group).includes(n));
        if (hit.length > 0) return hit;
    }
    return [];
}

export function floorGroups(place: string | undefined, area: CombatAreaType | undefined): string[] {
    const out: string[] = [];
    if (place && place.trim()) {
        for (const entry of PIXEL_PLACE_KEYWORDS) if (entry.words.some(w => phraseIn(place, w))) out.push(entry.floor);
        for (const entry of FLOOR_KEYWORDS) if (entry.words.some(w => phraseIn(place, w))) out.push(entry.floor);
    }
    if (area && AREA_DEFAULTS[area]) out.push(...AREA_DEFAULTS[area].floor);
    return out;
}

export function choosePixelFloor(catalog: PixelCatalog, place: string | undefined, area: CombatAreaType | undefined): string | null {
    for (const group of floorGroups(place, area)) {
        for (const name of namesFor(group)) if (catalog.floors.has(name) && areaAllowsFloor(area, name)) return name;
    }
    return null;
}

function kindGroups(kind: 'wall' | 'cover' | 'difficult', area: CombatAreaType | undefined): string[] {
    return [...(area && AREA_DEFAULTS[area] ? AREA_DEFAULTS[area][kind] : []), GENERIC_FALLBACK[kind]];
}

function hazardGroups(hazardType: string | undefined): string[] {
    const painted = (hazardType ? HAZARD_CANDIDATES[hazardType] ?? [] : []).map(ref => ref.slice(ref.indexOf('/') + 1));
    return [...painted, ...(hazardType ? HAZARD_PIXEL_EXTRA[hazardType] ?? [] : [])];
}

function inSet(setId: string | null, kind: PixelPieceKind, names: readonly string[]): string[] {
    return names.filter(n => allowedInSet(setId, kind, n));
}

function chooseFrom(
    pool: readonly string[],
    setId: string | null,
    kind: PixelPieceKind,
    label: string | undefined,
    groups: readonly string[],
    generic: readonly string[],
): string[] {
    const own = inSet(setId, kind, pool);
    const picked = pickNames(own, label, groups);
    if (picked.length > 0 || !setId) return picked;
    const common = pickNames(own, undefined, generic);
    return common.length > 0 ? common : own;
}

export function paletteOf(
    pool: readonly string[],
    setId: string | null,
    kind: PixelPieceKind,
    label: string | undefined,
    groups: readonly string[],
    generic: readonly string[],
): Weighted[] {
    const unique = [...new Set(pool)];
    const primary = [...new Set(chooseFrom(unique, setId, kind, label, groups, generic))];
    if (primary.length === 0) return [];
    const rest = setId ? unique.filter(n => PIXEL_SETS[setId][kind].includes(n) && !primary.includes(n)) : [];
    if (rest.length === 0) return primary.map(name => ({ name, weight: 1 / primary.length }));
    return [
        ...primary.map(name => ({ name, weight: LABEL_SHARE / primary.length })),
        ...rest.map(name => ({ name, weight: (1 - LABEL_SHARE) / rest.length })),
    ];
}

function eligibleProps(props: readonly PixelProp[], names: readonly string[]): PixelProp[] {
    const allowed = new Set(names);
    return props.filter(p => allowed.has(p.name));
}

function byFile(a: { file: string }, b: { file: string }): number {
    return a.file < b.file ? -1 : a.file > b.file ? 1 : 0;
}

export type PackOptions = { weights?: ReadonlyMap<string, number>; relax?: boolean };

export function packProps(
    grid: CombatGrid,
    kind: 'cover' | 'wall',
    props: readonly PixelProp[],
    seed: number,
    options: PackOptions = {},
): { placed: PlacedProp[]; covered: boolean[] } {
    const { width, height } = grid;
    const { weights, relax = true } = options;
    const covered: boolean[] = new Array<boolean>(width * height).fill(false);
    const placed: PlacedProp[] = [];
    const palette: Weighted[] = weights ? [...weights].map(([name, weight]) => ({ name, weight })) : [];
    const weightOf = (p: PixelProp): number => weights?.get(p.name) ?? 1;
    const fits = (p: PixelProp, x: number, y: number): boolean => {
        if (x + p.w > width || y + p.h > height) return false;
        for (let dy = 0; dy < p.h; dy++) {
            for (let dx = 0; dx < p.w; dx++) {
                const i = (y + dy) * width + x + dx;
                if (grid.tiles[i] !== kind || covered[i]) return false;
            }
        }
        return true;
    };
    const areas = [...new Set(props.map(p => p.w * p.h))].sort((a, b) => b - a);
    const sweep = (strict: boolean): void => {
        for (const area of areas) {
            const group = props.filter(p => p.w * p.h === area).sort(byFile);
            const spots: { x: number; y: number; order: number }[] = [];
            for (let y = 0; y < height; y++) {
                for (let x = 0; x < width; x++) {
                    if (grid.tiles[y * width + x] === kind && !covered[y * width + x]) spots.push({ x, y, order: tileHash(seed, x, y, 100 + area) });
                }
            }
            spots.sort((a, b) => a.order - b.order || a.y - b.y || a.x - b.x);
            for (const spot of spots) {
                if (covered[spot.y * width + spot.x]) continue;
                const noise = patchValue(seed, spot.x, spot.y, 3, 200 + area);
                const preferred = weights ? pickWeighted(palette, patchValue(seed, spot.x, spot.y, 4, 600)) : null;
                const pick = pickWeighted(group.map(p => ({ name: p.file, weight: weightOf(p) })), noise);
                const start = Math.max(0, group.findIndex(p => p.file === pick));
                for (let k = 0; k < group.length; k++) {
                    const prop = group[(start + k) % group.length];
                    if (strict && preferred !== null && prop.name !== preferred) continue;
                    if (!fits(prop, spot.x, spot.y)) continue;
                    for (let dy = 0; dy < prop.h; dy++) for (let dx = 0; dx < prop.w; dx++) covered[(spot.y + dy) * width + spot.x + dx] = true;
                    placed.push({
                        id: `${kind}:${spot.x},${spot.y}`,
                        kind,
                        name: prop.name,
                        path: pixelPath(kind, prop.file),
                        x: spot.x,
                        y: spot.y,
                        w: prop.w,
                        h: prop.h,
                        up: prop.up,
                        mirror: canMirror(prop.name) && tileHash(seed, spot.x, spot.y, 700 + area) < 0.5,
                    });
                    break;
                }
            }
        }
    };
    sweep(true);
    if (relax) sweep(false);
    placed.sort((a, b) => a.y - b.y || a.x - b.x);
    return { placed, covered };
}

export type PixelPlanInput = {
    grid: CombatGrid;
    catalog: PixelCatalog;
    seed: number;
    style: CombatTileStyle;
    place?: string;
    labels?: CombatTerrainLabels;
    occupied?: ReadonlySet<string>;
};

function nearHazard(grid: CombatGrid, x: number, y: number): boolean {
    for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
            if (grid.tiles[ny * grid.width + nx] === 'hazard') return true;
        }
    }
    return false;
}

function variantAt(variants: readonly string[], seed: number, x: number, y: number, salt: number): string {
    const count = variants.length;
    let index = Math.min(count - 1, Math.floor(patchValue(seed, x, y, 3, salt) * count));
    if (count > 1 && tileHash(seed, x, y, salt + 1) < VARIANT_SWAP) index = (index + 1 + Math.floor(tileHash(seed, x, y, salt + 2) * (count - 1))) % count;
    return variants[index];
}

function weights(palette: readonly Weighted[]): ReadonlyMap<string, number> {
    return new Map(palette.map(e => [e.name, e.weight]));
}

export function buildPixelPlan({ grid, catalog, seed, style, place, labels = grid.labels, occupied }: PixelPlanInput): PixelPlan | null {
    if (style === 'painted') return null;
    const floor = choosePixelFloor(catalog, place, grid.area);
    const variants = floor ? catalog.floors.get(floor) : undefined;
    if (!floor || !variants || variants.length === 0) return null;
    const { width, height } = grid;
    const count = width * height;
    const setId = setIdForFloor(floor);
    const generic = setId ? PIXEL_SETS[setId].generic : { cover: [], wall: [], difficult: [] };
    const coverPalette = paletteOf([...new Set(catalog.covers.map(p => p.name))], setId, 'cover', labels?.cover, kindGroups('cover', grid.area), generic.cover);
    const wallPool = [...new Set([...catalog.walls.map(p => p.name), ...catalog.fills])];
    const wallPalette = paletteOf(wallPool, setId, 'wall', labels?.wall, kindGroups('wall', grid.area), generic.wall);
    const fillPalette = paletteOf(catalog.fills, setId, 'wall', labels?.wall, kindGroups('wall', grid.area), generic.wall);
    const covers = packProps(grid, 'cover', eligibleProps(catalog.covers, coverPalette.map(e => e.name)), seed, { weights: weights(coverPalette) });
    const walls = packProps(grid, 'wall', eligibleProps(catalog.walls, wallPalette.map(e => e.name)), seed, {
        weights: weights(wallPalette),
        relax: fillPalette.length === 0,
    });
    const difficult = chooseFrom(catalog.difficult, setId, 'difficult', labels?.difficult, kindGroups('difficult', grid.area), generic.difficult);
    const hazard = pickNames(inSet(setId, 'hazard', catalog.hazard), labels?.hazard, hazardGroups(grid.hazardType));
    const decals = inSet(setId, 'decal', catalog.decals).filter(d => !DECAL_FLOORS[d] || DECAL_FLOORS[d].includes(floor));
    const companion = PIXEL_COMPANIONS[floor];
    const companionVariants = companion && setIdForFloor(companion) === setId ? catalog.floors.get(companion) : undefined;
    const pathMode = tileHash(seed, 91, 92, 93) < 0.5;
    const inCompanion = (x: number, y: number): boolean => {
        if (!companionVariants || companionVariants.length === 0) return false;
        if (pathMode) return Math.abs(y - wander(seed, x, 24) * (height - 1)) < 0.85;
        return patchValue(seed, x, y, 5, 21) < COMPANION_SHARE;
    };
    const plan: PixelPlan = {
        width,
        height,
        floor,
        floorPaths: new Array<string | null>(count).fill(null),
        fillPaths: new Array<string | null>(count).fill(null),
        decalPaths: new Array<string | null>(count).fill(null),
        overlayPaths: new Array<string | null>(count).fill(null),
        markers: new Array<PixelMarker | null>(count).fill(null),
        props: [...covers.placed, ...walls.placed],
        palettes: { cover: coverPalette, wall: wallPalette, fill: fillPalette },
    };
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const i = y * width + x;
            const tile = grid.tiles[i];
            if (tile === 'wall' && !walls.covered[i] && fillPalette.length > 0) {
                plan.fillPaths[i] = pixelPath('wall', pickWeighted(fillPalette, patchValue(seed, x, y, 3, 8)) as string);
                continue;
            }
            const painted = tile === 'floor' && inCompanion(x, y);
            plan.floorPaths[i] = pixelPath('floor', painted ? variantAt(companionVariants as readonly string[], seed, x, y, 15) : variantAt(variants, seed, x, y, 10));
            if (tile === 'wall') {
                if (!walls.covered[i]) plan.markers[i] = 'wall';
            } else if (tile === 'cover') {
                if (!covers.covered[i]) plan.markers[i] = 'cover';
            } else if (tile === 'difficult' || tile === 'hazard') {
                const pool = tile === 'difficult' ? difficult : hazard;
                if (pool.length === 0) plan.markers[i] = tile;
                else plan.overlayPaths[i] = pixelPath(tile, pool[Math.min(pool.length - 1, Math.floor(patchValue(seed, x, y, 3, 6) * pool.length))]);
            } else if (
                decals.length > 0 && !painted && !occupied?.has(`${x},${y}`) && !nearHazard(grid, x, y)
                && patchValue(seed, x, y, 3, 30) < DRIFT_SHARE && tileHash(seed, x, y, 3) < DECAL_CHANCE / DRIFT_SHARE
            ) {
                const own = decals[Math.min(decals.length - 1, Math.floor(patchValue(seed, x, y, 4, 31) * decals.length))];
                const other = decals[Math.floor(tileHash(seed, x, y, 4) * decals.length)];
                plan.decalPaths[i] = pixelPath('decal', tileHash(seed, x, y, 32) < 0.85 ? own : other);
            }
        }
    }
    return plan;
}

export type DepthItem = { type: 'prop'; prop: PlacedProp; row: number } | { type: 'token'; id: string; row: number };

export function propRow(prop: Pick<PlacedProp, 'y' | 'h'>): number {
    return prop.y + prop.h - 1;
}

export function depthOrder(props: readonly PlacedProp[], tokens: readonly { id: string; y: number }[]): DepthItem[] {
    const items: { item: DepthItem; rank: number; index: number }[] = [];
    props.forEach((prop, index) => items.push({ item: { type: 'prop', prop, row: propRow(prop) }, rank: 0, index }));
    tokens.forEach((t, index) => items.push({ item: { type: 'token', id: t.id, row: t.y }, rank: 1, index }));
    items.sort((a, b) => a.item.row - b.item.row || a.rank - b.rank || a.index - b.index);
    return items.map(e => e.item);
}

export function fadedProps(props: readonly PlacedProp[], watched: readonly CombatPos[]): Set<string> {
    const out = new Set<string>();
    for (const prop of props) {
        const bottom = propRow(prop);
        if (watched.some(p => p.x >= prop.x && p.x < prop.x + prop.w && p.y >= prop.y - prop.up && p.y < bottom)) out.add(prop.id);
    }
    return out;
}

const SNAP = 32;

export function snapTileSize(available: number): number {
    if (!Number.isFinite(available) || available <= 0) return available;
    if (available >= SNAP) return Math.floor(available / SNAP) * SNAP;
    if (available >= SNAP / 2) return SNAP / 2;
    return available;
}

export function pixelBoardSize(cols: number, rows: number, width: number, height: number): { tile: number; width: number; height: number } | null {
    if (cols <= 0 || rows <= 0 || width <= 0 || height <= 0) return null;
    const tile = snapTileSize(Math.min(width / cols, height / rows));
    return { tile, width: tile * cols, height: tile * rows };
}
