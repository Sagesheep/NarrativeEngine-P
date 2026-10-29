import { describe, expect, it } from 'vitest';
import { hillshadeMultiplier } from '../../../../public/bundled-mods/worldmap/renderer.js';
import { observedTerrainStore } from '../../../../public/bundled-mods/worldmap/exploration.js';
import { PIXEL_PALETTE, TERRAIN_VARIANTS, terrainVariant, paintTerrainVariant, paintPixelCell, buildFogMask, FOG_KNOWN_ALPHA, paintPixelRelief, paintPixelShadow } from '../../../../public/bundled-mods/worldmap/pixelArt.js';

function raster(size = 16) {
    const pixels = Array(size * size).fill('');
    const ctx = { fillStyle: '', imageSmoothingEnabled: true, fillRect(x, y, w, h) {
        expect(x).toBeGreaterThanOrEqual(0); expect(y).toBeGreaterThanOrEqual(0);
        expect(x + w).toBeLessThanOrEqual(size); expect(y + h).toBeLessThanOrEqual(size);
        for (let py = Math.floor(y); py < y + h; py++) for (let px = Math.floor(x); px < x + w; px++) pixels[py * size + px] = this.fillStyle;
    } };
    return { ctx, pixels };
}

describe('pixel terrain variants', () => {
    it('gives every biome four visibly distinct sprites with seamless base edges', () => {
        expect(TERRAIN_VARIANTS).toEqual(['A', 'B', 'C', 'D']);
        for (const [biome, base] of Object.entries(PIXEL_PALETTE)) {
            const sprites = TERRAIN_VARIANTS.map((_, v) => {
                const { ctx, pixels } = raster();
                paintTerrainVariant(ctx, biome, v, 0, 0, 16);
                for (let i = 0; i < 16; i++) {
                    expect(pixels[i]).toBe(base); expect(pixels[240 + i]).toBe(base);
                    expect(pixels[i * 16]).toBe(base); expect(pixels[i * 16 + 15]).toBe(base);
                }
                return pixels.join(',');
            });
            expect(new Set(sprites).size, biome).toBe(4);
        }
    });
    it('keeps variant choice stable at negative coordinates and across zoom sizes', () => {
        const found = new Set();
        for (let y = -8; y < 8; y++) for (let x = -8; x < 8; x++) {
            const v = terrainVariant(x, y);
            expect(terrainVariant(x, y)).toBe(v); found.add(v);
            const store = { getCell: () => ({ biome: 'plains' }) };
            const a = raster(), b = raster(32);
            paintPixelCell(a.ctx, store, x, y, 0, 0, 16);
            paintPixelCell(b.ctx, store, x, y, 0, 0, 32);
            for (let i = 0; i < 256; i++) expect(b.pixels[Math.floor(i / 16) * 64 + (i % 16) * 2]).toBe(a.pixels[i]);
        }
        expect([...found].sort()).toEqual([0, 1, 2, 3]);
    });
    it('draws a beach along a straight coast and keeps the inland half of every cell dry', () => {
        const shore = new Set(['#f0dfa0', '#b5a26b', '#91cfdd', PIXEL_PALETTE.ocean]);
        let beach = 0;
        for (let x = 0; x < 16; x++) {
            const store = { getCell: (cx, cy) => ({ biome: cy === -1 ? 'ocean' : 'plains' }) };
            const { ctx, pixels } = raster();
            paintPixelCell(ctx, store, x, 0, 0, 0, 16);
            // The water line wobbles a little either side of the cell edge, so
            // a given column may keep its beach in the cell above; the coast as
            // a whole has one, and it never reaches the middle of the land cell.
            beach += pixels.slice(0, 64).filter(color => color === '#f0dfa0' || color === '#b5a26b').length;
            expect(pixels.slice(128).some(color => shore.has(color)), `cell ${x}`).toBe(false);
        }
        expect(beach).toBeGreaterThan(64);
    });
});


describe('soft terrain boundaries', () => {
    it('rounds a staircase corner into the neighbouring biome and keeps the cell centre', () => {
        // Plains with volcanic ground east, south and south-east: the square
        // corner is cut, as a drawn map would show it.
        const store = { getCell: (x, y) => ({ biome: (x > 0 && y >= 0) || (y > 0 && x >= 0) ? 'volcanic' : 'plains' }) };
        const { ctx, pixels } = raster();
        paintPixelCell(ctx, store, 0, 0, 0, 0, 16);
        expect(pixels[15 * 16 + 15]).toBe(PIXEL_PALETTE.volcanic);
        expect(pixels[0]).not.toBe(PIXEL_PALETTE.volcanic);
        expect(pixels[8 * 16 + 8]).toBe(PIXEL_PALETTE.plains);
    });
    it('keeps a lone cell visible as a rounded core rather than smoothing it away', () => {
        const store = { getCell: (x, y) => ({ biome: x === 0 && y === 0 ? 'ocean' : 'plains' }) };
        const { ctx, pixels } = raster();
        paintPixelCell(ctx, store, 0, 0, 0, 0, 16);
        expect(['#3986b5', '#4f9ec9', '#72b9d6', '#286e9c']).toContain(pixels[8 * 16 + 8]);
        expect(pixels[0]).toBe(PIXEL_PALETTE.plains);
    });
    it('paints an unobserved neighbourhood exactly like its own biome', () => {
        const hidden = { getCell: (x, y) => x === 0 && y === 0 ? { biome: 'plains' } : null };
        const same = { getCell: () => ({ biome: 'plains' }) };
        const a = raster(), b = raster();
        paintPixelCell(a.ctx, hidden, 0, 0, 0, 0, 16);
        paintPixelCell(b.ctx, same, 0, 0, 0, 0, 16);
        expect(a.pixels).toEqual(b.pixels);
    });
    it('keeps a zoomed-out cell to flat colour', () => {
        const store = { getCell: () => ({ biome: 'plains' }) };
        for (let x = 0; x < 8; x++) {
            const { ctx, pixels } = raster(4);
            paintPixelCell(ctx, store, x, 0, 0, 0, 4);
            expect(pixels).toEqual(Array(16).fill(PIXEL_PALETTE.plains));
        }
    });
    it('gives adjacent farmland cells one coherent crop orientation', () => {
        const store = { getCell: () => ({ biome: 'farmland' }) };
        const a = raster(), b = raster();
        paintPixelCell(a.ctx, store, 1, 1, 0, 0, 16);
        paintPixelCell(b.ctx, store, 2, 1, 0, 0, 16);
        expect(a.pixels).toEqual(b.pixels);
    });
    it('keeps unexplored cells fully opaque even with fog disabled', () => {
        for (const fog of [true, false]) {
            // Cell 0 is unexplored, cell 1 explored and in sight; 4 samples a side.
            const mask = buildFogMask(new Set(['1,0']), new Set(['1,0']), fog, 0, 0, 2, 1, 4);
            for (let j = 0; j < 4; j++) {
                expect([...mask.slice(j * 8, j * 8 + 4)]).toEqual([255, 255, 255, 255]);
                expect([...mask.slice(j * 8 + 4, j * 8 + 8)]).toEqual([0, 0, 0, 0]);
            }
        }
    });
    it('dims explored ground out of sight and fades it in a circle around the party', () => {
        const generated = new Set(), visible = new Set();
        for (let y = 0; y < 13; y++) for (let x = 0; x < 13; x++) {
            generated.add(`${x},${y}`);
            if (Math.hypot(x - 6, y - 6) <= 2) visible.add(`${x},${y}`);
        }
        const sight = { x: 6.5, y: 6.5, r: Math.sqrt(visible.size / Math.PI) + 0.3 };
        const mask = buildFogMask(generated, visible, true, 0, 0, 13, 13, 2, sight);
        const at = (cx, cy) => mask[(cy * 2) * 26 + cx * 2];
        const known = Math.round(FOG_KNOWN_ALPHA * 255);
        expect(at(6, 6)).toBe(0);
        expect(at(0, 0)).toBe(known);
        // The fade is graded through the sight edge rather than a hard step.
        const ramp = [6, 7, 8, 9, 10, 11].map(x => at(x, 6));
        expect(ramp).toEqual([...ramp].sort((a, b) => a - b));
        expect(ramp.some(value => value > 0 && value < known)).toBe(true);
        // With fog off, explored ground is clear whatever the sight.
        expect(buildFogMask(generated, visible, false, 0, 0, 13, 13, 2, sight).every(value => value === 0)).toBe(true);
    });
});


describe('elevation and shadows', () => {
    const shade = (ex, ey) => hillshadeMultiplier(ex, ey, 0.12);
    it('keeps flat land neutral', () => {
        const {ctx,pixels} = raster();
        paintPixelRelief(ctx, {getCell: () => ({biome:'plains',elevation:0.5})}, 0, 0, 0, 0, 16, shade);
        expect(pixels).toEqual(Array(256).fill(''));
    });
    it('shades open sea darker and the shallows near a coast lighter', () => {
        const deep = raster();
        paintPixelRelief(deep.ctx, {getCell: () => ({biome:'ocean',elevation:-0.9})}, 0, 0, 0, 0, 16, shade);
        expect(deep.pixels.every(color => color.startsWith('rgba(14,38,74,'))).toBe(true);
        const shallow = raster();
        paintPixelRelief(shallow.ctx, {getCell: (x) => (x < 0 ? {biome:'plains',elevation:0.1} : {biome:'ocean',elevation:-0.02})}, 0, 0, 0, 0, 16, shade);
        expect(shallow.pixels.every(color => color.startsWith('rgba(196,236,232,'))).toBe(true);
    });
    it('lights slopes facing north-west and darkens opposing slopes', () => {
        for (const direction of [1,-1]) {
            const {ctx,pixels} = raster();
            const store = {getCell: (x,y) => ({biome:'plains',elevation:direction * 0.05 * (x+y)})};
            paintPixelRelief(ctx, store, 0, 0, 0, 0, 16, shade);
            expect(pixels.every(color => color.startsWith(direction === 1 ? 'rgba(255,240,197,' : 'rgba(23,31,47,'))).toBe(true);
        }
    });
    it('keeps shading continuous across cells on a uniform slope', () => {
        const store = {getCell: (x,y) => ({biome:'plains',elevation:0.03*x + 0.02*y})};
        const a=raster(), b=raster();
        paintPixelRelief(a.ctx,store,0,0,0,0,16,shade);
        paintPixelRelief(b.ctx,store,1,0,0,0,16,shade);
        expect(a.pixels).toEqual(b.pixels);
    });
    it('does not sample unobserved terrain to produce lighting', () => {
        const reads=[];
        const store=observedTerrainStore({getCell:(x,y)=>{reads.push(`${x},${y}`);return {biome:'plains',elevation:0.4};}},new Set(['0,0']));
        const {ctx,pixels}=raster();
        paintPixelRelief(ctx,store,0,0,0,0,16,shade);
        expect(reads.every(key=>key==='0,0')).toBe(true);
        expect(pixels.every(color=>color==='')).toBe(true);
    });
    it('draws contact shadows below and to the right, without blurring sprites', () => {
        const {ctx,pixels}=raster();
        paintPixelShadow(ctx,0,0,16);
        expect(pixels.slice(0,16*10).every(color=>color==='')).toBe(true);
        expect(new Set(pixels.filter(Boolean)).size).toBe(3);
    });
    it('adds ledge details only for a steep observed downhill edge', () => {
        const {ctx,pixels}=raster();
        paintPixelRelief(ctx,{getCell:x=>({biome:'mountain',elevation:x>0?0.1:0.5})},0,0,0,0,16,()=>1);
        expect(pixels).toContain('rgba(35,36,40,0.22)');
    });
});
