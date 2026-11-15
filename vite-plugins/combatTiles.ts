import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Plugin } from 'vite';

export const COMBAT_TILE_FOLDERS = ['floor', 'wall', 'cover', 'difficult', 'hazard'] as const;

export type CombatTileFolder = typeof COMBAT_TILE_FOLDERS[number];

export type CombatTileManifest = Record<CombatTileFolder, string[]>;

const TILE_FILE = /^([a-z0-9]+(?:-[a-z0-9]+)*)\.png$/;

function listFolder(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => TILE_FILE.exec(entry.name)?.[1])
            .filter((name): name is string => typeof name === 'string')
            .sort();
    } catch {
        return [];
    }
}

export function scanCombatTiles(tilesDir: string): CombatTileManifest {
    const out = {} as CombatTileManifest;
    for (const folder of COMBAT_TILE_FOLDERS) out[folder] = listFolder(join(tilesDir, folder));
    return out;
}

export function scanCombatGlyphs(glyphsDir: string): string[] {
    return listFolder(glyphsDir);
}

export const COMBAT_PIXEL_FOLDERS = ['floor', 'decal', 'difficult', 'hazard', 'cover', 'wall'] as const;

export type CombatPixelFolder = typeof COMBAT_PIXEL_FOLDERS[number];

export type CombatPixelManifest = Record<CombatPixelFolder, string[]>;

const PIXEL_FILE = /^(.+)\.png$/;

function listPixelFolder(dir: string): string[] {
    try {
        return readdirSync(dir, { withFileTypes: true })
            .filter(entry => entry.isFile())
            .map(entry => PIXEL_FILE.exec(entry.name)?.[1])
            .filter((name): name is string => typeof name === 'string')
            .sort();
    } catch {
        return [];
    }
}

export function scanCombatPixel(pixelDir: string): CombatPixelManifest {
    const out = {} as CombatPixelManifest;
    for (const folder of COMBAT_PIXEL_FOLDERS) out[folder] = listPixelFolder(join(pixelDir, folder));
    return out;
}

export function combatTilesPlugin(
    tilesDir: string,
    glyphsDir: string = join(tilesDir, '..', 'glyphs'),
    pixelDir: string = join(tilesDir, '..', 'pixel'),
): Plugin {
    return {
        name: 'narrative-combat-tiles',
        config() {
            return {
                define: {
                    __COMBAT_TILES__: JSON.stringify(JSON.stringify(scanCombatTiles(tilesDir))),
                    __COMBAT_GLYPHS__: JSON.stringify(JSON.stringify(scanCombatGlyphs(glyphsDir))),
                    __COMBAT_PIXEL__: JSON.stringify(JSON.stringify(scanCombatPixel(pixelDir))),
                },
            };
        },
    };
}
