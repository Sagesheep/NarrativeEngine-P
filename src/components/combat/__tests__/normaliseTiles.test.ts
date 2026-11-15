import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    buildPalette, colourCounts, countOffPalette, decodePng, encodePng, extractPalette, footprintFill, main, normaliseFolder, parseTileName,
    reduceToGrid, scaleUp, seamReport, snapToPalette,
} from '../../../../scripts/normalise-tiles.mjs';

type Rgba = [number, number, number, number];
type Image = { width: number; height: number; rgba: Uint8Array };

const dirs: string[] = [];

function tempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'ne-normalise-'));
    dirs.push(dir);
    return dir;
}

afterEach(() => {
    while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

function image(width: number, height: number, at: (x: number, y: number) => Rgba): Image {
    const rgba = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rgba.set(at(x, y), (y * width + x) * 4);
    return { width, height, rgba };
}

function blocks(cols: number, rows: number, scale: number, at: (cx: number, cy: number) => Rgba): Image {
    return image(cols * scale, rows * scale, (x, y) => at(Math.floor(x / scale), Math.floor(y / scale)));
}

function save(dir: string, path: string, img: Image): void {
    const full = join(dir, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, encodePng(img));
}

const RED: Rgba = [200, 30, 30, 255];
const GREEN: Rgba = [40, 160, 60, 255];
const CLEAR: Rgba = [0, 0, 0, 0];

function pixelAt(img: Image, x: number, y: number): Rgba {
    const i = (y * img.width + x) * 4;
    return [img.rgba[i], img.rgba[i + 1], img.rgba[i + 2], img.rgba[i + 3]];
}

describe('png codec and names', () => {
    it('round trips an image through encode and decode', () => {
        const img = image(5, 3, (x, y) => [x * 40, y * 80, 7, x === 2 ? 0 : 255]);
        const back = decodePng(encodePng(img));
        expect(back.width).toBe(5);
        expect(back.height).toBe(3);
        expect([...back.rgba]).toEqual([...img.rgba]);
    });

    it('refuses something that is not a PNG', () => {
        expect(() => decodePng(Buffer.from('nope'))).toThrow();
    });

    it('reads the expected size from the file name', () => {
        expect(parseTileName('grass-a.png')).toMatchObject({ tilesWide: 1, tilesHigh: 1, prop: false });
        expect(parseTileName('tree-oak@2x2+1.png')).toMatchObject({ tilesWide: 2, tilesHigh: 3, w: 2, h: 2, up: 1, prop: true });
        expect(parseTileName('house@4x3.png')).toMatchObject({ tilesWide: 4, tilesHigh: 3, up: 0 });
        expect(parseTileName('Bad Name.png')).toBeNull();
        expect(parseTileName('x@0x1.png')).toBeNull();
    });
});

describe('reduction to the art grid', () => {
    it('takes the dominant colour of each cell, ignoring noise', () => {
        const noisy = blocks(32, 32, 8, () => RED);
        noisy.rgba.set([10, 10, 250, 255], (3 * noisy.width + 3) * 4);
        const grid = reduceToGrid(noisy, 32, 32);
        expect(grid.width).toBe(32);
        expect(pixelAt(grid, 0, 0)).toEqual(RED);
        expect(pixelAt(grid, 31, 31)).toEqual(RED);
    });

    it('makes alpha fully on or off by majority', () => {
        const img = image(128, 128, (x, y) => {
            const cx = Math.floor(x / 4);
            const cy = Math.floor(y / 4);
            if (cx === 0 && cy === 0) return (x % 4) + (y % 4) * 4 < 3 ? [0, 255, 0, 255] : [0, 255, 0, 200];
            if (cx === 1 && cy === 0) return (x % 4) < 3 ? [0, 255, 0, 255] : CLEAR;
            if (cx === 2 && cy === 0) return (x % 4) < 1 ? [0, 255, 0, 255] : CLEAR;
            return CLEAR;
        });
        const grid = reduceToGrid(img, 32, 32);
        expect(pixelAt(grid, 0, 0)[3]).toBe(255);
        expect(pixelAt(grid, 1, 0)[3]).toBe(255);
        expect(pixelAt(grid, 2, 0)[3]).toBe(0);
        expect(pixelAt(grid, 3, 0)).toEqual(CLEAR);
        const alphas = new Set<number>();
        for (let i = 3; i < grid.rgba.length; i += 4) alphas.add(grid.rgba[i]);
        expect([...alphas].sort()).toEqual([0, 255]);
    });

    it('accepts any input size with the right proportions', () => {
        const big = blocks(32, 32, 16, (cx, cy) => ((cx + cy) % 2 ? RED : GREEN));
        const grid = reduceToGrid(big, 32, 32);
        expect(pixelAt(grid, 0, 0)).toEqual(GREEN);
        expect(pixelAt(grid, 1, 0)).toEqual(RED);
        expect(pixelAt(grid, 31, 30)).toEqual(RED);
    });

    it('scales the result up four times with square blocks', () => {
        const grid = blocks(2, 2, 1, (cx, cy) => (cx === cy ? RED : GREEN));
        const up = scaleUp(grid);
        expect(up.width).toBe(8);
        expect(pixelAt(up, 3, 3)).toEqual(RED);
        expect(pixelAt(up, 4, 3)).toEqual(GREEN);
        expect(pixelAt(up, 4, 4)).toEqual(RED);
    });
});

describe('palette', () => {
    it('snaps every opaque colour to the nearest palette entry and leaves clear pixels alone', () => {
        const grid = image(3, 1, x => (x === 0 ? [250, 10, 10, 255] : x === 1 ? [10, 12, 9, 255] : [200, 200, 200, 0]));
        const snapped = snapToPalette(grid, [[0, 0, 0], [255, 255, 255], [255, 0, 0]]);
        expect(pixelAt(snapped, 0, 0)).toEqual([255, 0, 0, 255]);
        expect(pixelAt(snapped, 1, 0)).toEqual([0, 0, 0, 255]);
        expect(pixelAt(snapped, 2, 0)).toEqual([200, 200, 200, 0]);
    });

    it('counts the colours outside the palette', () => {
        const grid = image(2, 1, x => (x === 0 ? [1, 2, 3, 255] : [9, 9, 9, 255]));
        expect(countOffPalette(grid, [[1, 2, 3]])).toBe(1);
        expect(countOffPalette(grid, [[1, 2, 3], [9, 9, 9]])).toBe(0);
    });

    it('keeps a small palette exactly and reduces a large one to at most 48 colours, deterministically', () => {
        const few = colourCounts(image(3, 1, x => [x * 50, 0, 0, 255]));
        expect(buildPalette(few)).toHaveLength(3);
        const many = colourCounts(image(100, 1, x => [x * 2, 255 - x, (x * 7) % 256, 255]));
        const a = buildPalette(many);
        expect(a.length).toBeLessThanOrEqual(48);
        expect(a.length).toBeGreaterThan(10);
        expect(buildPalette(many)).toEqual(a);
    });

    it('extracts a palette from a folder of approved images and writes it as JSON', () => {
        const dir = tempDir();
        save(dir, 'floor/grass-a.png', blocks(32, 32, 4, (cx, cy) => [(cx * 8) % 256, (cy * 8) % 256, 90, 255]));
        save(dir, 'cover/bush@1x1.png', blocks(32, 32, 4, (cx) => [20, (cx * 7) % 256, 100, 255]));
        const out = join(tempDir(), 'palette.json');
        const lines: string[] = [];
        expect(main([dir, '--extract-palette', out], line => lines.push(line))).toBe(0);
        const palette = JSON.parse(readFileSync(out, 'utf8')) as { colors: string[] };
        expect(palette.colors.length).toBeGreaterThan(1);
        expect(palette.colors.length).toBeLessThanOrEqual(48);
        expect(palette.colors.every(c => /^#[0-9a-f]{6}$/.test(c))).toBe(true);
        expect(extractPalette(dir, () => {}).colors).toEqual(palette.colors);
    });
});

describe('seams and footprints', () => {
    it('reports a floor whose opposite edges match as seamless', () => {
        const flat = blocks(32, 32, 1, (cx, cy) => (cx > 3 && cx < 28 && cy > 3 && cy < 28 ? RED : GREEN));
        expect(seamReport(flat).seamless).toBe(true);
        const bad = blocks(32, 32, 1, (cx, cy) => (cx === 0 || cy === 0 ? RED : GREEN));
        const report = seamReport(bad);
        expect(report.seamless).toBe(false);
        expect(report.horizontalMismatch).toBeGreaterThan(0.9);
    });

    it('measures how much of a prop footprint is filled', () => {
        const name = parseTileName('tree@1x1+1.png') as ReturnType<typeof parseTileName> & object;
        const tall = blocks(32, 64, 1, (cx, cy) => (cy >= 32 ? (cx < 8 ? GREEN : CLEAR) : GREEN));
        const fill = footprintFill(tall, name);
        expect(fill).toBeCloseTo(0.25, 2);
    });
});

describe('normalising a folder', () => {
    it('writes each image at four times the art grid and prints a report line per file', () => {
        const input = tempDir();
        const output = join(tempDir(), 'out');
        save(input, 'floor/grass-a.png', blocks(32, 32, 8, () => GREEN));
        save(input, 'cover/crate@2x1.png', blocks(64, 32, 6, (_cx, cy) => (cy < 2 ? CLEAR : RED)));
        const lines: string[] = [];
        const result = normaliseFolder(input, output, [[40, 160, 60], [200, 30, 30]], line => lines.push(line));
        expect(result).toEqual({ written: 2, skipped: 0 });
        const floor = decodePng(readFileSync(join(output, 'floor/grass-a.png')));
        expect([floor.width, floor.height]).toEqual([128, 128]);
        expect(pixelAt(floor, 127, 127)).toEqual(GREEN);
        const prop = decodePng(readFileSync(join(output, 'cover/crate@2x1.png')));
        expect([prop.width, prop.height]).toEqual([256, 128]);
        expect(pixelAt(prop, 0, 0)).toEqual(CLEAR);
        expect(pixelAt(prop, 0, 127)).toEqual(RED);
        const report = lines.join('\n');
        expect(report).toContain('floor/grass-a.png');
        expect(report).toMatch(/seamless yes/);
        expect(report).toMatch(/stray alpha 0/);
        expect(report).toMatch(/off-palette 0/);
        expect(report).toMatch(/footprint \d+% filled/);
    });

    it('reports stray semi-transparent pixels and colours outside the palette', () => {
        const input = tempDir();
        const output = join(tempDir(), 'out');
        save(input, 'decal/spot.png', blocks(32, 32, 4, (cx, cy) => (cx === 5 && cy === 5 ? [10, 200, 10, 90] : cx === 6 ? RED : CLEAR)));
        const lines: string[] = [];
        normaliseFolder(input, output, [[200, 30, 30]], line => lines.push(line));
        const report = lines.join('\n');
        expect(report).toMatch(/stray alpha 16/);
        expect(report).toMatch(/off-palette 0/);
        const lines2: string[] = [];
        normaliseFolder(input, join(tempDir(), 'out2'), [[1, 1, 1]], line => lines2.push(line));
        expect(lines2.join('\n')).toMatch(/off-palette 1/);
    });

    it('reports an unseamed floor', () => {
        const input = tempDir();
        save(input, 'floor/edge-a.png', blocks(32, 32, 4, (cx, cy) => (cx === 0 || cy === 0 ? RED : GREEN)));
        const lines: string[] = [];
        normaliseFolder(input, join(tempDir(), 'out'), null, line => lines.push(line));
        expect(lines.join('\n')).toMatch(/seamless NO/);
    });

    it('reports and skips a file of the wrong size or proportions, and a name that does not parse', () => {
        const input = tempDir();
        const output = join(tempDir(), 'out');
        save(input, 'floor/wide-a.png', blocks(40, 30, 4, () => GREEN));
        save(input, 'floor/tiny-a.png', blocks(16, 16, 1, () => GREEN));
        save(input, 'floor/Bad Name.png', blocks(32, 32, 4, () => GREEN));
        save(input, 'floor/fine-a.png', blocks(32, 32, 4, () => GREEN));
        writeFileSync(join(input, 'floor/broken-a.png'), 'not a png');
        const lines: string[] = [];
        const result = normaliseFolder(input, output, null, line => lines.push(line));
        expect(result).toEqual({ written: 1, skipped: 4 });
        expect(lines.filter(l => l.startsWith('skip'))).toHaveLength(4);
        expect(lines.join('\n')).toMatch(/skip floor\/wide-a\.png: size 160x120 does not fit 1x1 tiles/);
        expect(existsSync(join(output, 'floor/fine-a.png'))).toBe(true);
        expect(existsSync(join(output, 'floor/wide-a.png'))).toBe(false);
    });

    it('refuses to write into its input folder, and writes nothing there', () => {
        const input = tempDir();
        save(input, 'floor/grass-a.png', blocks(32, 32, 4, () => GREEN));
        const before = readdirSync(input, { recursive: true }).map(String).sort();
        expect(() => normaliseFolder(input, input)).toThrow(/input folder/);
        expect(() => normaliseFolder(input, join(input, 'out'))).toThrow(/input folder/);
        const lines: string[] = [];
        expect(main([input, input], line => lines.push(line))).toBe(1);
        expect(main([input, join(input, 'nested')], line => lines.push(line))).toBe(1);
        expect(main([input, '--extract-palette', join(input, 'palette.json')], line => lines.push(line))).toBe(1);
        expect(readdirSync(input, { recursive: true }).map(String).sort()).toEqual(before);
        expect(lines.join('\n')).toContain('refusing to write into the input folder');
    });

    it('prints usage when the folders are missing and fails on an unknown option', () => {
        const lines: string[] = [];
        expect(main([], line => lines.push(line))).toBe(1);
        expect(lines.join('\n')).toContain('usage: node scripts/normalise-tiles.mjs');
        expect(main([tempDir(), tempDir(), '--wat'], () => {})).toBe(1);
    });

    it('snaps to a palette file given on the command line', () => {
        const input = tempDir();
        const output = join(tempDir(), 'out');
        const paletteFile = join(tempDir(), 'p.json');
        writeFileSync(paletteFile, JSON.stringify({ colors: ['#28a03c', '#c81e1e'] }));
        save(input, 'floor/grass-a.png', blocks(32, 32, 4, () => [44, 150, 70, 255]));
        expect(main([input, output, '--palette', paletteFile], () => {})).toBe(0);
        expect(pixelAt(decodePng(readFileSync(join(output, 'floor/grass-a.png'))), 5, 5)).toEqual(GREEN);
    });
});
