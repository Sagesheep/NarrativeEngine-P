import { describe, it, expect, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { combatTilesPlugin, scanCombatPixel } from '../../../../vite-plugins/combatTiles';
import { availablePixel, buildPixelCatalog, hasAnyPixel, parsePixelManifest, parsePixelName, pixelUrl, withoutPixelPaths } from '../pixelCatalog';

const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ne-combat-pixel-'));
    dirs.push(dir);
    return dir;
}

function put(dir: string, path: string): void {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, '');
}

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

describe('pixel file names', () => {
    it('reads floor variants', () => {
        expect(parsePixelName('floor', 'grass-a')).toEqual({ kind: 'floor', base: 'grass', file: 'grass-a' });
        expect(parsePixelName('floor', 'dirt-path-c')).toEqual({ kind: 'floor', base: 'dirt-path', file: 'dirt-path-c' });
    });

    it('reads a prop footprint and its extra height', () => {
        expect(parsePixelName('wall', 'tree-oak@2x2+1')).toEqual({ kind: 'prop', folder: 'wall', prop: { name: 'tree-oak', file: 'tree-oak@2x2+1', w: 2, h: 2, up: 1 } });
        expect(parsePixelName('cover', 'bush@1x1')).toEqual({ kind: 'prop', folder: 'cover', prop: { name: 'bush', file: 'bush@1x1', w: 1, h: 1, up: 0 } });
        expect(parsePixelName('cover', 'log@2x1+0')).toMatchObject({ prop: { w: 2, h: 1, up: 0 } });
        expect(parsePixelName('wall', 'house@4x3+1')).toMatchObject({ prop: { w: 4, h: 3, up: 1 } });
    });

    it('treats a wall with no footprint as a seamless fill', () => {
        expect(parsePixelName('wall', 'cliff')).toEqual({ kind: 'fill', name: 'cliff', file: 'cliff' });
    });

    it('reads overlays in the decal, difficult and hazard folders', () => {
        expect(parsePixelName('decal', 'flowers-white')).toEqual({ kind: 'overlay', folder: 'decal', name: 'flowers-white', file: 'flowers-white' });
        expect(parsePixelName('hazard', 'campfire')).toMatchObject({ kind: 'overlay', folder: 'hazard' });
        expect(parsePixelName('difficult', 'mud')).toMatchObject({ kind: 'overlay', folder: 'difficult' });
    });

    it('rejects names that do not parse', () => {
        expect(parsePixelName('floor', 'Grass-A')).toBeNull();
        expect(parsePixelName('floor', 'grass_a')).toBeNull();
        expect(parsePixelName('cover', 'bush@0x1')).toBeNull();
        expect(parsePixelName('cover', 'bush@2x')).toBeNull();
        expect(parsePixelName('cover', 'bush@99x1')).toBeNull();
        expect(parsePixelName('wall', 'tree@1x1+')).toBeNull();
        expect(parsePixelName('decal', 'flowers@1x1')).toBeNull();
        expect(parsePixelName('hazard', 'fire pit')).toBeNull();
    });
});

describe('pixel catalog', () => {
    it('groups floors by base and sorts variants', () => {
        const catalog = buildPixelCatalog({ floor: ['grass-c', 'grass-a', 'grass-b', 'sand-a'] });
        expect(catalog.floors.get('grass')).toEqual(['grass-a', 'grass-b', 'grass-c']);
        expect([...catalog.floors.keys()].sort()).toEqual(['grass', 'sand']);
    });

    it('sorts every kind and lists what it ignored', () => {
        const catalog = buildPixelCatalog({
            floor: ['grass-a', 'bad name'],
            decal: ['pebbles'],
            difficult: ['mud'],
            hazard: ['thorns'],
            cover: ['bush@1x1', 'log@2x1', 'x@y'],
            wall: ['cliff', 'house@4x3+1'],
        });
        expect(catalog.decals).toEqual(['pebbles']);
        expect(catalog.difficult).toEqual(['mud']);
        expect(catalog.hazard).toEqual(['thorns']);
        expect(catalog.covers.map(p => p.file)).toEqual(['bush@1x1', 'log@2x1']);
        expect(catalog.walls.map(p => p.file)).toEqual(['house@4x3+1']);
        expect(catalog.fills).toEqual(['cliff']);
        expect(catalog.rejected).toEqual(['floor/bad name', 'cover/x@y']);
    });

    it('survives a malformed manifest', () => {
        expect(hasAnyPixel(parsePixelManifest('not json'))).toBe(false);
        expect(hasAnyPixel(parsePixelManifest(null))).toBe(false);
        expect(hasAnyPixel(parsePixelManifest([]))).toBe(false);
        const parsed = parsePixelManifest(JSON.stringify({ floor: ['grass-a', 7], wall: 'cliff' }));
        expect([...parsed.floors.keys()]).toEqual(['grass']);
        expect(parsed.fills).toEqual([]);
    });

    it('is empty in the app when the build defines no manifest, as under vitest', () => {
        expect(hasAnyPixel(availablePixel())).toBe(false);
    });

    it('drops a file whose image failed to load, and a floor with no variant left', () => {
        const catalog = buildPixelCatalog({ floor: ['grass-a', 'grass-b', 'sand-a'], cover: ['bush@1x1'], wall: ['cliff'] });
        const left = withoutPixelPaths(catalog, new Set(['floor/grass-a', 'floor/sand-a', 'cover/bush@1x1', 'wall/cliff']));
        expect(left.floors.get('grass')).toEqual(['grass-b']);
        expect(left.floors.has('sand')).toBe(false);
        expect(left.covers).toEqual([]);
        expect(left.fills).toEqual([]);
    });

    it('builds an escaped URL from the app base', () => {
        expect(pixelUrl('wall/tree-pine@1x1+1')).toBe(`${import.meta.env.BASE_URL}assets/combat/pixel/wall/tree-pine@1x1+1.png`);
        expect(pixelUrl('floor/grass-a')).toBe(`${import.meta.env.BASE_URL}assets/combat/pixel/floor/grass-a.png`);
    });
});

describe('pixel discovery on disk', () => {
    it('is empty for a missing folder', () => {
        const manifest = scanCombatPixel(join(tmpdir(), 'ne-combat-pixel-missing-folder'));
        expect(manifest).toEqual({ floor: [], decal: [], difficult: [], hazard: [], cover: [], wall: [] });
        expect(hasAnyPixel(parsePixelManifest(manifest))).toBe(false);
    });

    it('lists png files in the six folders and leaves parsing to the app', () => {
        const dir = tempDir();
        put(dir, 'floor/grass-a.png');
        put(dir, 'cover/bush@1x1.png');
        put(dir, 'wall/tree-pine@1x1+1.png');
        put(dir, 'wall/cliff.png');
        put(dir, 'decal/notes.txt');
        put(dir, 'misc/other.png');
        put(dir, 'floor/Bad Name.png');
        const manifest = scanCombatPixel(dir);
        expect(manifest.floor).toEqual(['Bad Name', 'grass-a']);
        expect(manifest.cover).toEqual(['bush@1x1']);
        expect(manifest.wall).toEqual(['cliff', 'tree-pine@1x1+1']);
        expect(manifest.decal).toEqual([]);
        const catalog = parsePixelManifest(manifest);
        expect(catalog.rejected).toEqual(['floor/Bad Name']);
        expect(catalog.walls[0]).toMatchObject({ name: 'tree-pine', w: 1, h: 1, up: 1 });
    });

    it('a file added to the folder appears on the next start, with no code change', () => {
        const dir = tempDir();
        const tiles = join(dir, 'tiles');
        const defineFrom = () => {
            const hook = combatTilesPlugin(tiles).config as unknown as () => { define: Record<string, string> };
            return parsePixelManifest(JSON.parse(hook().define.__COMBAT_PIXEL__) as string);
        };
        expect(hasAnyPixel(defineFrom())).toBe(false);
        put(dir, 'pixel/floor/grass-a.png');
        expect([...defineFrom().floors.keys()]).toEqual(['grass']);
        put(dir, 'pixel/cover/rock@1x1.png');
        expect(defineFrom().covers.map(p => p.name)).toEqual(['rock']);
    });
});
