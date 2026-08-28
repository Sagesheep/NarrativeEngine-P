import { describe, expect, it, afterEach, beforeEach } from 'vitest';
import {
    buildTileAtlas,
    cellTextureVariant,
} from '../../../../public/bundled-mods/worldmap/renderer.js';
import { BIOME_COLORS } from '../../../../public/bundled-mods/worldmap/field.js';

/**
 * The texture atlas.
 *
 * Every cell of one biome used to blit the identical flat square, so a region
 * of savanna painted as one rectangle of colour. The atlas now holds several
 * textured variants per biome and the raster picks one by a hash of the cell's
 * own coordinates — one blit per cell either way, so none of this is paid at
 * render time.
 *
 * Two things here are load-bearing beyond looks:
 *
 * **The atlas is a grid.** As a strip it would be 64 squares wide, which at
 * the old 256px square is 16384px — exactly the maximum canvas dimension on a
 * good deal of hardware and past it on the rest.
 *
 * **The painters stay inside the canvas subset the stubs implement.** A
 * painter that reaches past it throws inside `buildTileAtlas`, which runs
 * inside the paint, which runs inside a `requestAnimationFrame` — so the map
 * silently draws nothing while a suite that never looks at the canvas stays
 * green. That already happened once, with `closePath`.
 */

/** The context surface the renderer is allowed to use. */
const ALLOWED_PROPS = new Set([
    'fillStyle', 'strokeStyle', 'lineWidth', 'globalAlpha',
    'font', 'textAlign', 'textBaseline', 'imageSmoothingEnabled',
    'lineJoin', 'lineCap',
]);
const ALLOWED_METHODS = new Set([
    'setTransform', 'save', 'restore', 'scale',
    'beginPath', 'moveTo', 'lineTo', 'arc', 'fill', 'stroke',
    'fillRect', 'drawImage', 'createImageData', 'putImageData',
    'measureText', 'fillText',
]);

/**
 * A context that throws — loudly, by name — the moment anything touches a
 * method outside the subset. The point is to fail in the test rather than in
 * a swallowed animation frame.
 */
function makeStrictContext(reached) {
    const store = {
        fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
        font: '', textAlign: 'left', textBaseline: 'middle',
        imageSmoothingEnabled: true, lineJoin: 'miter', lineCap: 'butt',
    };
    const methods = {};
    for (const name of ALLOWED_METHODS) {
        methods[name] = (...args) => {
            reached.push(name);
            if (name === 'createImageData') {
                return { width: args[0], height: args[1], data: new Uint8ClampedArray(4) };
            }
            if (name === 'measureText') return { width: String(args[0]).length * 6 };
            return undefined;
        };
    }
    return new Proxy(store, {
        get(target, prop) {
            if (typeof prop === 'symbol') return target[prop];
            if (prop in methods) return methods[prop];
            if (ALLOWED_PROPS.has(prop)) return target[prop];
            throw new Error(
                `the atlas reached for canvas API "${String(prop)}", which is outside `
                + 'the subset the renderer commits to. Either use the subset or widen '
                + 'it deliberately — every canvas stub in the suite has to grow with it.',
            );
        },
        set(target, prop, value) {
            if (ALLOWED_PROPS.has(prop)) { target[prop] = value; return true; }
            throw new Error(`the atlas set canvas property "${String(prop)}", outside the subset.`);
        },
    });
}

let created = [];
let reached = [];

function installStrictCanvas() {
    const restores = [];
    const originalOffscreen = globalThis.OffscreenCanvas;
    function FakeOffscreen(w, h) {
        const canvas = { width: w, height: h, getContext: () => makeStrictContext(reached) };
        created.push(canvas);
        return canvas;
    }
    globalThis.OffscreenCanvas = FakeOffscreen;
    restores.push(() => { globalThis.OffscreenCanvas = originalOffscreen; });
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () { return makeStrictContext(reached); };
    restores.push(() => { HTMLCanvasElement.prototype.getContext = originalGetContext; });
    return () => { for (const restore of restores) restore(); };
}

describe('World Map texture atlas', () => {
    let restore = null;
    let root = null;

    beforeEach(() => {
        created = [];
        reached = [];
        restore = installStrictCanvas();
        root = document.createElement('div');
        document.body.appendChild(root);
    });

    afterEach(() => {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        if (restore) restore();
    });

    it('every biome painter stays inside the canvas subset', () => {
        // The whole atlas is built, so this exercises every painter at once.
        // A painter that reaches past the subset throws here by name instead
        // of silently blanking the map at runtime.
        expect(() => buildTileAtlas(root)).not.toThrow();
        // Sanity: the strict context was actually the one used, and drawing
        // actually happened. Without this the test passes against a builder
        // that draws nothing at all.
        expect(reached).toContain('fillRect');
        expect(reached).toContain('arc');
        expect(reached).toContain('stroke');
    });

    it('lays the squares out as a grid that no canvas will refuse', () => {
        const atlas = buildTileAtlas(root);
        const biomes = Object.keys(BIOME_COLORS).length;
        const slots = (biomes * atlas.variants) + 16;

        expect(atlas.cols).toBeGreaterThan(1);
        expect(atlas.atlas.width).toBe(atlas.cols * atlas.tile);
        expect(atlas.atlas.width * atlas.atlas.height)
            .toBeGreaterThanOrEqual(slots * atlas.tile * atlas.tile);
        // As a strip this would have been 16384px wide at the old square size.
        expect(atlas.atlas.width).toBeLessThanOrEqual(4096);
        expect(atlas.atlas.height).toBeLessThanOrEqual(4096);
    });

    it('gives every biome its own block of variants, and every shore mask a square', () => {
        const atlas = buildTileAtlas(root);
        const biomes = Object.keys(BIOME_COLORS);
        expect(atlas.variants).toBeGreaterThan(1);

        const claimed = new Set();
        for (const biome of biomes) {
            const base = atlas.index[biome];
            expect(base, biome + ' has a slot').toBeTypeOf('number');
            for (let v = 0; v < atlas.variants; v += 1) {
                expect(claimed.has(base + v), 'slot ' + (base + v) + ' claimed twice').toBe(false);
                claimed.add(base + v);
            }
        }
        for (let mask = 0; mask < 16; mask += 1) {
            const slot = atlas.index[`shore:${mask}`];
            expect(slot, 'shore mask ' + mask).toBeTypeOf('number');
            expect(claimed.has(slot)).toBe(false);
            claimed.add(slot);
        }

        // Nothing may land outside the grid — an off-grid slot reads as a
        // transparent square, which is an invisible hole in the terrain.
        const rows = Math.ceil(atlas.atlas.height / atlas.tile);
        for (const slot of claimed) {
            expect(Math.floor(slot / atlas.cols)).toBeLessThan(rows);
        }
    });

    it('picks a cell variant deterministically, and does not hand out one variant', () => {
        // Deterministic: the same cell must texture the same way on every
        // repaint, or the ground crawls.
        expect(cellTextureVariant(496, 500)).toBe(cellTextureVariant(496, 500));
        expect(cellTextureVariant(-3, 12)).toBe(cellTextureVariant(-3, 12));

        const seen = new Map();
        let neighbourDiffers = 0;
        let pairs = 0;
        for (let y = 480; y < 520; y += 1) {
            for (let x = 480; x < 520; x += 1) {
                const v = cellTextureVariant(x, y);
                expect(Number.isInteger(v)).toBe(true);
                expect(v).toBeGreaterThanOrEqual(0);
                expect(v).toBeLessThan(4);
                seen.set(v, (seen.get(v) ?? 0) + 1);
                pairs += 1;
                if (cellTextureVariant(x + 1, y) !== v) neighbourDiffers += 1;
            }
        }
        // All four variants get used, and roughly evenly — a hash that
        // collapsed onto one value would put the flat wallpaper straight back.
        expect(seen.size).toBe(4);
        for (const count of seen.values()) {
            expect(count).toBeGreaterThan(pairs / 10);
        }
        // And the point of the whole exercise: horizontal neighbours mostly
        // differ, so a run of one biome does not print as one rectangle.
        expect(neighbourDiffers / pairs).toBeGreaterThan(0.5);
    });
});
