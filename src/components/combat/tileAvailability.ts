import { createContext } from 'react';

declare const __COMBAT_TILES__: string | undefined;

export const TILE_FOLDERS = ['floor', 'wall', 'cover', 'difficult', 'hazard'] as const;

export type TileFolder = typeof TILE_FOLDERS[number];

export type TileAvailability = Record<TileFolder, ReadonlySet<string>>;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function emptyTiles(): TileAvailability {
    return { floor: new Set(), wall: new Set(), cover: new Set(), difficult: new Set(), hazard: new Set() };
}

export function parseTileManifest(raw: unknown): TileAvailability {
    let data: unknown = raw;
    if (typeof raw === 'string') {
        try {
            data = JSON.parse(raw);
        } catch {
            return emptyTiles();
        }
    }
    const out = emptyTiles();
    if (!data || typeof data !== 'object' || Array.isArray(data)) return out;
    const record = data as Record<string, unknown>;
    for (const folder of TILE_FOLDERS) {
        const list = record[folder];
        if (!Array.isArray(list)) continue;
        out[folder] = new Set(list.filter((n): n is string => typeof n === 'string' && NAME.test(n)));
    }
    return out;
}

export function tilesFrom(lists: Partial<Record<TileFolder, readonly string[]>>): TileAvailability {
    return parseTileManifest(lists);
}

let cached: TileAvailability | null = null;

export function availableTiles(): TileAvailability {
    if (!cached) cached = parseTileManifest(typeof __COMBAT_TILES__ === 'undefined' ? undefined : __COMBAT_TILES__);
    return cached;
}

export function hasAnyTile(tiles: TileAvailability): boolean {
    return TILE_FOLDERS.some(folder => tiles[folder].size > 0);
}

export function tileUrl(path: string): string {
    return `${import.meta.env.BASE_URL}assets/combat/tiles/${path}.png`;
}

export const TileAvailabilityContext = createContext<TileAvailability>(availableTiles());

const ART_STORAGE_KEY = 'nn_combat_tile_art';

export function initialTileArt(): boolean {
    try {
        return window.localStorage.getItem(ART_STORAGE_KEY) !== 'off';
    } catch {
        return true;
    }
}

export function rememberTileArt(on: boolean): void {
    try {
        window.localStorage.setItem(ART_STORAGE_KEY, on ? 'on' : 'off');
    } catch {
        return;
    }
}
