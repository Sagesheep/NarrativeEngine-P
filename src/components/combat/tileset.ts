import type { CombatAreaType, CombatGrid, CombatTerrainLabels, CombatTile } from '../../types';
import { TILE_FOLDERS } from './tileAvailability';
import type { TileAvailability, TileFolder } from './tileAvailability';

export type TileRef = { folder: TileFolder; name: string };

export type Tileset = Record<CombatTile, TileRef | null>;

export type TileArt = { path: string; opaque: boolean; mirror: boolean };

export type CellArt = { flat: true } | { flat: false; base: TileArt | null; top: TileArt | null };

export const LIQUIDS: readonly string[] = ['swamp-water', 'shallow-water', 'deep-water', 'lava', 'acid-pool', 'sewage', 'coolant'];

export const RUN_PIECES: ReadonlySet<string> = new Set([
    'bar-counter', 'bookshelf', 'market-stall', 'low-wall', 'fence', 'server-rack', 'shelving', 'pipes', 'chainlink', 'live-conduit',
]);

const ALT_SUFFIX = '-alt';

export const FLOOR_KEYWORDS: readonly { words: readonly string[]; floor: string }[] = [
    { words: ['tavern', 'inn', 'cabin', 'ship deck', 'wooden'], floor: 'wood-planks' },
    { words: ['snow', 'ice', 'frozen', 'tundra'], floor: 'snow' },
    { words: ['desert', 'beach', 'dune'], floor: 'sand' },
    { words: ['cave', 'mine', 'grotto'], floor: 'cave-stone' },
    { words: ['dungeon', 'crypt', 'temple', 'castle', 'keep', 'hall'], floor: 'dungeon-flagstone' },
    { words: ['street', 'alley', 'city', 'town', 'market'], floor: 'city-cobblestone' },
    { words: ['swamp', 'marsh', 'bog'], floor: 'swamp' },
    { words: ['forest', 'wood', 'grove', 'jungle'], floor: 'forest-floor' },
    { words: ['graveyard', 'cemetery'], floor: 'graveyard-soil' },
    { words: ['road', 'camp'], floor: 'dirt-road' },
    { words: ['rooftop'], floor: 'rooftop-gravel' },
    { words: ['warehouse', 'bunker', 'garage'], floor: 'concrete' },
    { words: ['server', 'lab', 'starship', 'station', 'ship'], floor: 'metal-plating' },
    { words: ['nightclub', 'club', 'bar'], floor: 'nightclub-floor' },
    { words: ['sewer'], floor: 'sewer-brick' },
    { words: ['ruin'], floor: 'mossy-stone' },
    { words: ['office'], floor: 'carpet' },
    { words: ['field', 'meadow', 'plain', 'farm', 'garden', 'park'], floor: 'grass' },
    { words: ['quarry', 'mountain', 'cliff'], floor: 'gravel' },
];

type AreaDefaults = { floor: readonly string[]; wall: readonly string[]; cover: readonly string[]; difficult: readonly string[] };

export const AREA_DEFAULTS: Record<CombatAreaType, AreaDefaults> = {
    open: { floor: ['grass', 'sand', 'earth'], wall: ['stone-brick'], cover: ['crates', 'rocks'], difficult: ['rubble'] },
    scattered: { floor: ['forest-floor', 'grass'], wall: ['dense-forest', 'cave-rock'], cover: ['tree', 'boulder', 'crates'], difficult: ['undergrowth', 'rubble'] },
    room: { floor: ['wood-planks', 'dungeon-flagstone'], wall: ['wooden-wall', 'stone-brick'], cover: ['table', 'crates'], difficult: ['debris', 'rubble'] },
    rows: { floor: ['concrete', 'dungeon-flagstone', 'wood-planks'], wall: ['concrete-wall', 'stone-brick'], cover: ['shelving', 'crates'], difficult: ['cables', 'debris', 'rubble'] },
    corridors: { floor: ['dungeon-flagstone', 'metal-plating'], wall: ['stone-brick', 'metal-bulkhead'], cover: ['crates'], difficult: ['debris', 'rubble'] },
    cavern: { floor: ['cave-stone'], wall: ['cave-rock', 'stone-brick'], cover: ['boulder', 'stalagmite', 'crates'], difficult: ['rubble'] },
    street: { floor: ['city-cobblestone', 'dirt-road'], wall: ['building-roof', 'stone-brick'], cover: ['crates', 'cart'], difficult: ['trash', 'debris', 'rubble'] },
    ledge: { floor: ['gravel', 'stone-rampart'], wall: ['sheer-drop', 'cave-rock'], cover: ['rocks', 'boulder', 'crates'], difficult: ['scree', 'rubble'] },
    ruins: { floor: ['mossy-stone', 'dungeon-flagstone'], wall: ['ruined-wall', 'stone-brick'], cover: ['fallen-stones', 'crates'], difficult: ['rubble'] },
    wetland: { floor: ['swamp', 'grass'], wall: ['cave-rock', 'stone-brick'], cover: ['dead-tree', 'reeds', 'crates'], difficult: ['swamp-water', 'shallow-water'] },
};

export const GENERIC_FALLBACK: Record<Exclude<CombatTile, 'hazard'>, string> = {
    floor: 'earth',
    wall: 'stone-brick',
    cover: 'crates',
    difficult: 'rubble',
};

export const HAZARD_CANDIDATES: Record<string, readonly string[]> = {
    fire: ['hazard/flames', 'hazard/burning-debris', 'floor/lava'],
    deep_water: ['floor/deep-water'],
    electric: ['hazard/electric-arc', 'hazard/live-conduit'],
    toxic: ['hazard/toxic-sludge', 'floor/acid-pool', 'floor/sewage', 'hazard/gas-cloud'],
    pit: ['hazard/pit', 'hazard/spikes'],
};

function words(text: string): string[] {
    return text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ').filter(Boolean);
}

function sameWord(token: string, word: string): boolean {
    if (token === word || token === `${word}s` || token === `${word}es`) return true;
    if (word.endsWith('f')) return token === `${word.slice(0, -1)}ves`;
    if (word.endsWith('fe')) return token === `${word.slice(0, -2)}ves`;
    if (word.endsWith('y')) return token === `${word.slice(0, -1)}ies`;
    return false;
}

export function phraseIn(text: string, phrase: string): boolean {
    const tokens = words(text);
    const target = words(phrase);
    if (target.length === 0) return false;
    for (let i = 0; i + target.length <= tokens.length; i++) {
        if (target.every((w, j) => sameWord(tokens[i + j], w))) return true;
    }
    return false;
}

function has(tiles: TileAvailability, ref: TileRef): boolean {
    return tiles[ref.folder].has(ref.name);
}

function parseRef(ref: string): TileRef | null {
    const [folder, name] = ref.split('/');
    return (TILE_FOLDERS as readonly string[]).includes(folder) && name ? { folder: folder as TileFolder, name } : null;
}

function firstExisting(tiles: TileAvailability, refs: readonly TileRef[]): TileRef | null {
    return refs.find(ref => has(tiles, ref)) ?? null;
}

function labelPool(kind: CombatTile, tiles: TileAvailability): TileRef[] {
    const own = (folder: TileFolder): TileRef[] => [...tiles[folder]].map(name => ({ folder, name }));
    const liquids = LIQUIDS.filter(name => tiles.floor.has(name)).map(name => ({ folder: 'floor' as const, name }));
    if (kind === 'wall') return own('wall');
    if (kind === 'cover') return own('cover');
    if (kind === 'difficult') return [...own('difficult'), ...liquids];
    if (kind === 'hazard') return [...own('hazard'), ...liquids];
    return [];
}

export function matchLabel(label: string | undefined, pool: readonly TileRef[]): TileRef | null {
    if (!label || !label.trim()) return null;
    let best: TileRef | null = null;
    for (const ref of pool) {
        if (ref.name.endsWith(ALT_SUFFIX)) continue;
        if (!phraseIn(label, ref.name.replace(/-/g, ' '))) continue;
        if (!best || ref.name.length > best.name.length) best = ref;
    }
    return best;
}

export function floorFromPlace(place: string | undefined, tiles: TileAvailability): TileRef | null {
    if (!place || !place.trim()) return null;
    for (const entry of FLOOR_KEYWORDS) {
        if (!tiles.floor.has(entry.floor)) continue;
        if (entry.words.some(w => phraseIn(place, w))) return { folder: 'floor', name: entry.floor };
    }
    return null;
}

function areaRefs(kind: Exclude<CombatTile, 'hazard'>, area: CombatAreaType | undefined): TileRef[] {
    if (!area || !AREA_DEFAULTS[area]) return [];
    return AREA_DEFAULTS[area][kind].map(name => ({ folder: kind === 'difficult' && LIQUIDS.includes(name) ? 'floor' : kind, name }));
}

function chooseKind(kind: Exclude<CombatTile, 'hazard'>, grid: CombatGrid, place: string | undefined, labels: CombatTerrainLabels | undefined, tiles: TileAvailability): TileRef | null {
    if (kind !== 'floor') {
        const labelled = matchLabel(labels?.[kind], labelPool(kind, tiles));
        if (labelled) return labelled;
    } else {
        const fromPlace = floorFromPlace(place, tiles);
        if (fromPlace) return fromPlace;
    }
    return firstExisting(tiles, [...areaRefs(kind, grid.area), { folder: kind, name: GENERIC_FALLBACK[kind] }]);
}

function chooseHazard(grid: CombatGrid, labels: CombatTerrainLabels | undefined, tiles: TileAvailability): TileRef | null {
    const labelled = matchLabel(labels?.hazard, labelPool('hazard', tiles));
    if (labelled) return labelled;
    const refs = (grid.hazardType ? HAZARD_CANDIDATES[grid.hazardType] ?? [] : []).map(parseRef).filter((r): r is TileRef => r !== null);
    return firstExisting(tiles, refs);
}

export type TilesetInput = {
    grid: CombatGrid;
    tiles: TileAvailability;
    place?: string;
    labels?: CombatTerrainLabels;
};

export function resolveTileset({ grid, tiles, place, labels = grid.labels }: TilesetInput): Tileset {
    return {
        floor: chooseKind('floor', grid, place, labels, tiles),
        wall: chooseKind('wall', grid, place, labels, tiles),
        cover: chooseKind('cover', grid, place, labels, tiles),
        difficult: chooseKind('difficult', grid, place, labels, tiles),
        hazard: chooseHazard(grid, labels, tiles),
    };
}

export function hasArt(tileset: Tileset): boolean {
    return Object.values(tileset).some(ref => ref !== null);
}

export function tileHash(seed: number, x: number, y: number, salt: number): number {
    let h = (Math.imul(seed | 0, 0x9e3779b1) ^ Math.imul(x + 1, 0x85ebca6b) ^ Math.imul(y + 1, 0xc2b2ae35) ^ Math.imul(salt + 1, 0x27d4eb2f)) >>> 0;
    h = Math.imul(h ^ (h >>> 16), 0x7feb352d) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 0x846ca68b) >>> 0;
    h = (h ^ (h >>> 16)) >>> 0;
    return h / 0x100000000;
}

function isOpaque(ref: TileRef): boolean {
    return (ref.folder === 'floor' || ref.folder === 'wall') && !RUN_PIECES.has(ref.name);
}

export function artFor(ref: TileRef, tiles: TileAvailability, x: number, y: number, seed: number): TileArt {
    const opaque = isOpaque(ref);
    if (opaque) {
        const alt = `${ref.name}${ALT_SUFFIX}`;
        const useAlt = tiles[ref.folder].has(alt) && tileHash(seed, x, y, 1) < 1 / 3;
        return { path: `${ref.folder}/${useAlt ? alt : ref.name}`, opaque, mirror: false };
    }
    const mirror = !RUN_PIECES.has(ref.name) && tileHash(seed, x, y, 2) < 0.5;
    return { path: `${ref.folder}/${ref.name}`, opaque, mirror };
}

export function cellArt(tileset: Tileset, tiles: TileAvailability, grid: CombatGrid, x: number, y: number, seed: number): CellArt {
    const tile = grid.tiles[y * grid.width + x];
    const own = tileset[tile];
    if (!own) return { flat: true };
    const floor = tileset.floor ? artFor(tileset.floor, tiles, x, y, seed) : null;
    if (tile === 'floor') return { flat: false, base: floor, top: null };
    const top = artFor(own, tiles, x, y, seed);
    if (tile === 'wall' && top.opaque) return { flat: false, base: top, top: null };
    return { flat: false, base: floor, top };
}

export function withoutPaths(tiles: TileAvailability, paths: ReadonlySet<string>): TileAvailability {
    if (paths.size === 0) return tiles;
    const out = {} as Record<TileFolder, ReadonlySet<string>>;
    for (const folder of TILE_FOLDERS) out[folder] = new Set([...tiles[folder]].filter(name => !paths.has(`${folder}/${name}`)));
    return out;
}
