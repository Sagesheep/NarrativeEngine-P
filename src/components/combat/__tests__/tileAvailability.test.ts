import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combatTilesPlugin, scanCombatTiles } from '../../../../vite-plugins/combatTiles';
import { availableTiles, hasAnyTile, parseTileManifest, tileUrl } from '../tileAvailability';
import { resolveTileset } from '../tileset';

const dirs: string[] = [];

function tempTiles(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ne-combat-tiles-'));
    dirs.push(dir);
    return dir;
}

function put(dir: string, path: string): void {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
}

function defineFrom(dir: string): string {
    const hook = combatTilesPlugin(dir).config as unknown as () => { define: Record<string, string> };
    return JSON.parse(hook().define.__COMBAT_TILES__) as string;
}

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('combat tile manifest', () => {
    it('is empty for a missing folder', () => {
        const manifest = scanCombatTiles(join(tmpdir(), 'ne-combat-tiles-missing-folder'));
        expect(manifest).toEqual({ floor: [], wall: [], cover: [], difficult: [], hazard: [] });
        expect(hasAnyTile(parseTileManifest(manifest))).toBe(false);
    });

    it('is empty for an empty folder and for empty kind folders', () => {
        const dir = tempTiles();
        expect(hasAnyTile(parseTileManifest(scanCombatTiles(dir)))).toBe(false);
        mkdirSync(join(dir, 'floor'));
        mkdirSync(join(dir, 'hazard'));
        expect(hasAnyTile(parseTileManifest(scanCombatTiles(dir)))).toBe(false);
    });

    it('lists only correctly named PNG files in the five kind folders', () => {
        const dir = tempTiles();
        put(dir, 'floor/grass.png');
        put(dir, 'floor/earth-alt.png');
        put(dir, 'floor/Grass2.PNG');
        put(dir, 'floor/notes.txt');
        put(dir, 'floor/nested.png/inner.png');
        put(dir, 'cover/server-rack.png');
        put(dir, 'terrain/sand.png');
        expect(scanCombatTiles(dir)).toEqual({ floor: ['earth-alt', 'grass'], wall: [], cover: ['server-rack'], difficult: [], hazard: [] });
    });

    it('a file added to the folder changes the availability and the chosen tile on the next start', () => {
        const dir = tempTiles();
        put(dir, 'floor/earth.png');
        const before = parseTileManifest(defineFrom(dir));
        const grid = { width: 2, height: 1, tiles: ['floor', 'floor'] as const, area: 'open' as const };
        expect(resolveTileset({ grid: { ...grid, tiles: [...grid.tiles] }, tiles: before }).floor).toEqual({ folder: 'floor', name: 'earth' });
        put(dir, 'floor/grass.png');
        put(dir, 'hazard/flames.png');
        const after = parseTileManifest(defineFrom(dir));
        expect([...after.hazard]).toEqual(['flames']);
        const set = resolveTileset({ grid: { ...grid, tiles: [...grid.tiles], hazardType: 'fire' }, tiles: after });
        expect(set.floor).toEqual({ folder: 'floor', name: 'grass' });
        expect(set.hazard).toEqual({ folder: 'hazard', name: 'flames' });
    });
});

describe('availability in the app', () => {
    it('is empty when the build defines no manifest, as under vitest', () => {
        expect(hasAnyTile(availableTiles())).toBe(false);
    });

    it('survives a malformed manifest and drops bad names', () => {
        expect(hasAnyTile(parseTileManifest('not json'))).toBe(false);
        expect(hasAnyTile(parseTileManifest(null))).toBe(false);
        const parsed = parseTileManifest(JSON.stringify({ floor: ['grass', '../x', 7], wall: 'stone-brick' }));
        expect([...parsed.floor]).toEqual(['grass']);
        expect(parsed.wall.size).toBe(0);
    });

    it('builds the URL from the app base', () => {
        expect(tileUrl('floor/grass')).toBe(`${import.meta.env.BASE_URL}assets/combat/tiles/floor/grass.png`);
    });
});
