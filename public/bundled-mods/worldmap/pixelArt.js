// Original handheld-inspired art. Presentation only: never changes field or route data.
export const PIXEL_PALETTE = Object.freeze({
    plains: '#8cbd62', farmland: '#a8be64', forest: '#669e58', jungle: '#5d9f58',
    taiga: '#719a75', tundra: '#bbc9a4', glacier: '#d6e8e6', mountain: '#a9ac88',
    snow: '#e4edf0', volcanic: '#63535b', deadzone: '#9b8c91', sand: '#e9cc8b', swamp: '#486b60',
    desert: '#e4cb85', savanna: '#c6c373', marsh: '#789d7a', ocean: '#3986b5',
});
export const SITE_SPRITES = Object.freeze({ settlement: 13, camp: 5, ruin: 6, shrine: 7, crossing: 15, landmark: 14 });
let sheet = null;
let loading = null;
export function loadPixelArt() {
    if (sheet) return Promise.resolve(true);
    if (loading) return loading;
    if (typeof Image === 'undefined') return Promise.resolve(false);
    loading = new Promise(resolve => {
        const image = new Image();
        image.onload = () => { sheet = image; resolve(true); };
        image.onerror = () => { loading = null; resolve(false); };
        image.src = new URL('./assets/overworld-sprites-v1.png', import.meta.url).href;
    });
    return loading;
}
export function drawPixelSprite(ctx, slot, x, y, size, shadow = false) {
    if (!sheet) return false;
    if (shadow) paintPixelShadow(ctx, x, y, size);
    const unitX = sheet.naturalWidth / 4, unitY = sheet.naturalHeight / 4;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sheet, (slot % 4) * unitX, Math.floor(slot / 4) * unitY, unitX, unitY,
        Math.round(x), Math.round(y), Math.round(size), Math.round(size));
    return true;
}
/** Small stepped contact shadow, cast toward the lower right by north-west light. */
export function paintPixelShadow(ctx, x, y, size) {
    const bands = [[0.20, 0.66, 0.64, 0.16, 0.06], [0.25, 0.69, 0.54, 0.10, 0.10], [0.32, 0.71, 0.40, 0.06, 0.13]];
    for (const [dx, dy, w, h, alpha] of bands) {
        ctx.fillStyle = `rgba(22,31,39,${alpha})`;
        ctx.fillRect(x + dx * size, y + dy * size, w * size, h * size);
    }
}

/** Shared vertex normals give adjacent cells identical lighting along their edges. */
export function paintPixelRelief(ctx, store, x, y, px, py, size, shade) {
    const cell = store.getCell(x, y);
    if (!cell || !Number.isFinite(cell.elevation)) return;
    if (cell.biome === 'ocean') { paintWaterDepth(ctx, store, x, y, px, py, size, cell.elevation); return; }
    const heights = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const value = store.getCell(x + dx, y + dy)?.elevation;
        heights.push(Number.isFinite(value) ? value : cell.elevation);
    }
    const flat = shade(0, 0);
    const corners = [[0,1,3,4],[1,2,4,5],[3,4,6,7],[4,5,7,8]].map(([a,b,c,d]) => {
        const ex = (heights[b] + heights[d] - heights[a] - heights[c]) / 2;
        const ey = (heights[c] + heights[d] - heights[a] - heights[b]) / 2;
        return shade(ex, ey) / flat;
    });
    const samples = Math.min(8, Math.max(1, Math.round(size / 4)));
    const step = size / samples;
    for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) {
        const u = (i + 0.5) / samples, v = (j + 0.5) / samples;
        const value = (corners[0] * (1-u) + corners[1] * u) * (1-v)
            + (corners[2] * (1-u) + corners[3] * u) * v;
        const alpha = Math.min(0.28, Math.abs(value - 1));
        if (alpha < 0.002) continue;
        ctx.fillStyle = value < 1 ? `rgba(23,31,47,${alpha.toFixed(3)})` : `rgba(255,240,197,${alpha.toFixed(3)})`;
        ctx.fillRect(px + i * step, py + j * step, step, step);
    }
    // Short broken rock faces mark a substantial downhill drop, never a new obstacle.
    if (size < 16) return;
    for (const [dx,dy,index] of [[1,0,5],[0,1,7]]) {
        const neighbour = store.getCell(x + dx, y + dy);
        if (!neighbour || neighbour.biome === 'ocean' || cell.elevation - heights[index] < 0.08) continue;
        for (let i = 0; i < 3; i++) {
            const jitter = noise(x, y, 109 + i) % 2;
            const a = dx ? 13 + jitter : 2 + i * 4, b = dy ? 13 + jitter : 2 + i * 4;
            ctx.fillStyle = 'rgba(35,36,40,0.22)';
            ctx.fillRect(px + a * size / 16, py + b * size / 16, (dx ? 1 : 3) * size / 16, (dy ? 1 : 3) * size / 16);
            ctx.fillStyle = 'rgba(245,225,180,0.16)';
            ctx.fillRect(px + (a - dx) * size / 16, py + (b - dy) * size / 16, (dx ? 1 : 3) * size / 16, (dy ? 1 : 3) * size / 16);
        }
    }
}
/**
 * Shallows lighter, deep water darker, interpolated from shared corners like the
 * hillshade so the sea has no cell grid in it. Land and unobserved neighbours
 * count as the shoreline, which is what makes water near a coast read shallow.
 */
const WATER_DEPTH_SCALE = 0.3;
function paintWaterDepth(ctx, store, x, y, px, py, size, elevation) {
    const depths = [];
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const other = store.getCell(x + dx, y + dy);
        const value = !other ? elevation : other.biome !== 'ocean' ? 0 : other.elevation;
        depths.push(Math.max(0, Math.min(1, -(Number.isFinite(value) ? value : elevation) / WATER_DEPTH_SCALE)));
    }
    const corners = CORNER_CELLS.map(cells => cells.reduce((sum, i) => sum + depths[i], 0) / 4);
    const samples = Math.min(8, Math.max(1, Math.round(size / 4)));
    const step = size / samples;
    for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) {
        const u = (i + 0.5) / samples, v = (j + 0.5) / samples;
        const depth = (corners[0] * (1 - u) + corners[1] * u) * (1 - v) + (corners[2] * (1 - u) + corners[3] * u) * v;
        const alpha = Math.abs(depth - 0.5) * 0.44;
        if (alpha < 0.01) continue;
        ctx.fillStyle = depth < 0.5 ? `rgba(196,236,232,${alpha.toFixed(3)})` : `rgba(14,38,74,${alpha.toFixed(3)})`;
        ctx.fillRect(px + i * step, py + j * step, step, step);
    }
}
function noise(x, y, salt = 0) {
    let n = Math.imul(x + 1013, 374761393) ^ Math.imul(y + 719, 668265263) ^ Math.imul(salt + 1, 1274126177);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    return (n ^ (n >>> 16)) >>> 0;
}
export function terrainSprite(biome, variant) {
    if (biome === 'forest') return 0;
    if (biome === 'taiga') return 2 === variant % 5 ? 10 : 1;
    if (biome === 'jungle') return variant % 3 ? 0 : 2;
    if (biome === 'mountain') return 3;
    if (biome === 'marsh' || biome === 'swamp') return variant % 3 === 0 ? 11 : null;
    if (biome === 'tundra') return variant % 9 === 0 ? 10 : null;
    if (biome === 'savanna') return variant % 7 === 0 ? 0 : null;
    if (biome === 'plains') return variant % 11 === 0 ? 9 : null;
    return null;
}
// Four authored motifs per terrain family, with placement independent of camera/cache.
export const TERRAIN_VARIANTS = Object.freeze(['A', 'B', 'C', 'D']);
export function terrainVariant(x, y) {
    return noise(x, y, 47) % TERRAIN_VARIANTS.length;
}

/** Paint a reusable 16x16 terrain sprite. Edges retain the biome's base colour. */
export function paintTerrainVariant(ctx, biome, variant, px, py, size) {
    const v = ((variant % 4) + 4) % 4, pixel = size / 16;
    const mark = (color, x, y, w = 1, h = 1) => {
        ctx.fillStyle = color;
        ctx.fillRect(px + x * pixel, py + y * pixel, w * pixel, h * pixel);
    };
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = PIXEL_PALETTE[biome] ?? PIXEL_PALETTE.plains;
    ctx.fillRect(px, py, size, size);
    const spots = [[3, 4], [10, 10], [4, 11], [11, 4]];
    const tuft = (x, y, dark, light) => {
        mark(dark, x, y, 3, 1); mark(dark, x, y - 2, 1, 2);
        mark(light, x + 1, y - 3, 1, 3); mark(dark, x + 2, y - 1);
    };
    const stone = (x, y, dark, light) => {
        mark(dark, x, y + 1, 4, 1); mark(dark, x + 1, y, 3, 1);
        mark(light, x + 1, y, 2, 1);
    };
    for (let i = 0; i < 2 + (v === 1 ? 1 : 0); i++) {
        const [x, y] = spots[(i + v) % spots.length];
        if (biome === 'ocean') {
            mark('#4f9ec9', x - 1, y, 4, 1);
            mark('#72b9d6', x, y + 1, v === 2 ? 3 : 2, 1);
            if (v === 3) mark('#286e9c', x + 1, y + 3, 3, 1);
        } else if (['sand', 'desert'].includes(biome)) {
            if (v === 2) stone(x, y, '#c39b61', '#f9e4ae');
            else {
                mark('#d2b274', x - 1, y + 1, 5, 1);
                mark('#f9e4ae', x, y, v === 1 ? 4 : 2, 1);
                if (v === 3) mark('#c39b61', x + 2, y + 3);
            }
        } else if (['snow', 'glacier', 'tundra'].includes(biome)) {
            if (v === 3 && biome === 'tundra') tuft(x, y, '#879e80', '#d4dfb7');
            else if (v === 2) stone(x, y, '#96b4c3', '#f7fcfa');
            else {
                mark('#b7cedd', x - 1, y + 1, 4, 1);
                mark('#f7fcfa', x, y, 3, 1);
                if (v === 1) mark('#a3c3d1', x + 1, y + 2, 1, 2);
            }
        } else if (['swamp', 'marsh'].includes(biome)) {
            if (v === 1 || v === 3) tuft(x, y, '#304f59', '#a2b773');
            else {
                mark('#365962', x - 1, y, 5, 2);
                mark('#669183', x, y, 3, 1);
                if (v === 2) mark('#a2b773', x + 1, y - 1, 2, 1);
            }
        } else if (biome === 'farmland') {
            const vertical = v % 2 === 1;
            for (let row = 2; row < 14; row += 4) {
                mark('#8b9f4e', vertical ? row : 1, vertical ? 1 : row, vertical ? 1 : 14, vertical ? 14 : 1);
                if (v < 2) mark('#c2cf77', vertical ? row + 1 : 1, vertical ? 1 : row + 1, vertical ? 1 : 14, vertical ? 14 : 1);
                else for (let col = 3; col < 14; col += 3) mark('#d4d58a', vertical ? row + 1 : col, vertical ? col : row + 1);
            }
            break;
        } else if (['mountain', 'volcanic', 'deadzone'].includes(biome)) {
            const dark = biome === 'volcanic' ? '#403d49' : biome === 'deadzone' ? '#6e666e' : '#858b73';
            const light = biome === 'volcanic' ? '#aa8074' : biome === 'deadzone' ? '#c0ada7' : '#d0d0ab';
            if (v === 1 || v === 3) {
                mark(dark, x, y - 1, 1, 3); mark(dark, x + 1, y + 1, 3, 1);
                mark(light, x + 1, y - 1, 2, 1);
            } else stone(x, y, dark, light);
        } else {
            const dry = biome === 'savanna';
            const dark = dry ? '#a49e54' : '#60954d', light = dry ? '#e5d68b' : '#b4d984';
            if (v === 0 || v === 1) tuft(x, y, dark, light);
            else if (v === 2) {
                tuft(x, y, dark, light);
                mark(dry ? '#f6e8b2' : '#f1e6a6', x + 1, y - 3);
                mark(dry ? '#d4a562' : '#dfb4cc', x + 2, y - 2);
            } else {
                stone(x, y, dry ? '#9e9b70' : '#819879', dry ? '#ded2a0' : '#c2cead');
                mark(dark, x - 1, y + 2);
            }
        }
    }
}
const smooth = value => { const t = Math.max(0, Math.min(1, value)); return t * t * (3 - 2 * t); };

// ── Biome boundaries ──────────────────────────────────────────────────────
// Marching squares over cell corners. Every corner is shared by four cells, and
// a biome's weight at a corner is the share of those four it holds. Weights are
// interpolated across the cell, so a staircase of square cells reads as the
// diagonal a drawn map would show, while a straight edge stays exactly on the
// cell boundary. Both cells beside an edge read the same corners and the same
// world-space noise, so the line is continuous across cells and cached tiles.
// Presentation only: the cell keeps its biome for routing, hover and the story.
const NEIGHBOURHOOD = [[-1,-1],[0,-1],[1,-1],[-1,0],[0,0],[1,0],[-1,1],[0,1],[1,1]];
const CORNER_CELLS = [[0, 1, 3, 4], [1, 2, 4, 5], [3, 4, 6, 7], [4, 5, 7, 8]];
const BOUNDARY_WOBBLE = 0.18;
// A cell its own biome would lose even at its centre (a lone cell, a one-cell
// line, a peninsula tip) keeps a rounded core by at least this margin, so the
// smoothing never erases ground the pathfinder still treats as real.
const BOUNDARY_KEEP = 0.3;
const BEACH_LIGHT = '#f0dfa0', BEACH_DARK = '#b5a26b', FOAM = '#91cfdd', COASTLINE = '#2a5f80';

function biomeSalt(biome) {
    let h = 2166136261;
    for (let i = 0; i < biome.length; i++) h = Math.imul(h ^ biome.charCodeAt(i), 16777619);
    return (h >>> 0) % 9973;
}
/** Smooth value noise in world space: the same at a shared edge whichever cell asks. */
function valueNoise(wx, wy, salt) {
    const ix = Math.floor(wx), iy = Math.floor(wy);
    const fx = smooth(wx - ix), fy = smooth(wy - iy);
    const at = (x, y) => (noise(x, y, salt) % 1024) / 1023;
    const top = at(ix, iy) + (at(ix + 1, iy) - at(ix, iy)) * fx;
    const bottom = at(ix, iy + 1) + (at(ix + 1, iy + 1) - at(ix, iy + 1)) * fx;
    return top + (bottom - top) * fy;
}
const plateau = t => smooth(Math.min(t, 1 - t) / 0.3);

/**
 * The biomes of a cell's 3×3 neighbourhood. Unobserved neighbours count as the
 * cell's own biome, so the boundary pass never reveals terrain the party has
 * not seen. (Farmland was tried with ruled edges; a diagonal field margin then
 * reads as exactly the staircase this pass exists to remove.)
 */
function boundaryNeighbourhood(store, x, y, biome) {
    return NEIGHBOURHOOD.map(([dx, dy]) => (dx || dy ? store.getCell(x + dx, y + dy)?.biome : biome) || biome);
}

function paintBoundaries(ctx, store, x, y, px, py, size, biome) {
    const ids = boundaryNeighbourhood(store, x, y, biome);
    const kinds = [...new Set(ids)];
    if (kinds.length === 1) return;
    const own = kinds.indexOf(biome);
    const ocean = kinds.indexOf('ocean');
    const corners = kinds.map(kind => CORNER_CELLS.map(cells => cells.reduce((n, i) => n + (ids[i] === kind ? 0.25 : 0), 0)));
    const at = (k, u, v) => (corners[k][0] * (1 - u) + corners[k][1] * u) * (1 - v) + (corners[k][2] * (1 - u) + corners[k][3] * u) * v;
    let rival = 0;
    for (let k = 0; k < kinds.length; k++) if (k !== own) rival = Math.max(rival, at(k, 0.5, 0.5));
    const keep = Math.max(0, rival - at(own, 0.5, 0.5) + BOUNDARY_KEEP);
    const salts = kinds.map(biomeSalt);
    const samples = Math.min(16, Math.max(4, Math.round(size / 2)));
    const step = size / samples;
    const weight = new Array(kinds.length);
    for (let j = 0; j < samples; j++) {
        const v = (j + 0.5) / samples;
        let runColour = null, runStart = 0;
        for (let i = 0; i <= samples; i++) {
            let colour = null;
            if (i < samples) {
                const u = (i + 0.5) / samples;
                let best = 0;
                for (let k = 0; k < kinds.length; k++) {
                    weight[k] = at(k, u, v) + BOUNDARY_WOBBLE * (valueNoise((x + u) * 4, (y + v) * 4, salts[k]) - 0.5)
                        + (k === own && keep ? keep * plateau(u) * plateau(v) : 0);
                    if (weight[k] > weight[best]) best = k;
                }
                if (best !== own) colour = PIXEL_PALETTE[kinds[best]] ?? PIXEL_PALETTE.plains;
                if (ocean >= 0) {
                    // Beaches and surf follow the smoothed shoreline rather
                    // than the cell edge. The margin is how far this sample
                    // sits from the water line, in membership.
                    let land = -Infinity;
                    for (let k = 0; k < kinds.length; k++) if (k !== ocean) land = Math.max(land, weight[k]);
                    if (best !== ocean) {
                        const margin = weight[best] - weight[ocean];
                        if (margin < 0.07) colour = BEACH_LIGHT;
                        else if (margin < 0.15) colour = BEACH_DARK;
                    } else if (weight[ocean] - land < 0.07) colour = size >= 8 ? FOAM : COASTLINE;
                }
            }
            if (colour !== runColour) {
                if (runColour) {
                    ctx.fillStyle = runColour;
                    ctx.fillRect(px + runStart * step, py + j * step, (i - runStart) * step, step);
                }
                runColour = colour; runStart = i;
            }
        }
    }
}

// ── Fog of war ────────────────────────────────────────────────────────────
// Fog is one low-resolution alpha texture, scaled up with smoothing when drawn:
// the standard fog-of-war technique. One draw means no seams between cells,
// and the soft edge comes from the upscale for free.
export const FOG_COLOUR = [23, 37, 45];
export const FOG_KNOWN_ALPHA = 0.36;
/**
 * Alpha (0-255) for each fog sample over a `cols × rows` cell window starting
 * at `(x0, y0)`, with `perCell` samples per cell side. Unexplored cells are
 * always fully opaque, with fog on or off. Known ground is dimmed only while
 * fog is on; `sight` (a centre and radius in cells) fades the dimming out
 * around the party as a circle instead of a stack of square cells.
 */
export function buildFogMask(generated, visible, fog, x0, y0, cols, rows, perCell, sight = null) {
    const width = cols * perCell, height = rows * perCell;
    const alpha = new Uint8ClampedArray(width * height);
    for (let j = 0; j < height; j++) {
        const wy = y0 + (j + 0.5) / perCell, cy = Math.floor(wy);
        for (let i = 0; i < width; i++) {
            const wx = x0 + (i + 0.5) / perCell, cx = Math.floor(wx);
            const key = `${cx},${cy}`;
            let value;
            if (!generated.has(key)) value = 1;
            else if (!fog) value = 0;
            else if (sight) value = FOG_KNOWN_ALPHA * smooth((Math.hypot(wx - sight.x, wy - sight.y) - sight.r + 1.1) / 1.7);
            else value = visible.has(key) ? 0 : FOG_KNOWN_ALPHA;
            alpha[j * width + i] = Math.round(value * 255);
        }
    }
    return alpha;
}

// Logical 16-pixel ground tiles at every zoom; motifs stay stable across tile/cache boundaries.
export function paintPixelCell(ctx, store, x, y, px, py, size) {
    const cell = store.getCell(x, y);
    if (!cell) return;
    const biome = cell.biome;
    // Crop orientation belongs to a field, rather than changing at every cell.
    const variant = biome === 'farmland' ? terrainVariant(Math.floor(x / 6), Math.floor(y / 6)) : terrainVariant(x, y);
    // Below 8px a 16-pixel motif is sub-pixel noise, so a zoomed-out map keeps
    // to flat colour and lets the coastlines and names carry it.
    if (size < 8 || (biome !== 'farmland' && biome !== 'ocean' && noise(x, y, 83) % 5 < 2)) {
        ctx.fillStyle = PIXEL_PALETTE[biome] ?? PIXEL_PALETTE.plains;
        ctx.fillRect(px, py, size, size);
    } else paintTerrainVariant(ctx, biome, variant, px, py, size);
    paintBoundaries(ctx, store, x, y, px, py, size, biome);
}
export function paintPixelObjects(ctx, store, x, y, px, py, size) {
    if (size < 8) return;
    const biome = store.getCell(x, y)?.biome, seed = noise(x, y);
    if (['snow', 'volcanic', 'deadzone'].includes(biome)) {
        // Small original pixel silhouettes, stable in world coordinates.
        if (seed % 4 !== 0) return;
        paintPixelShadow(ctx, px, py, size);
        const pixel = size / 16;
        const mark = (color, a, b, w, h) => { ctx.fillStyle = color; ctx.fillRect(px + a * pixel, py + b * pixel, w * pixel, h * pixel); };
        if (biome === 'deadzone') {
            mark('#524c55', 8, 5, 2, 8); mark('#524c55', 5, 7, 4, 2); mark('#524c55', 10, 4, 3, 2);
        } else {
            for (let row = 0; row < 5; row++) mark(biome === 'snow' ? '#829aa7' : '#3c3643', 7 - row, 5 + row, 2 + row * 2, 1);
            mark(biome === 'snow' ? '#ffffff' : '#af8175', 6, 5, 4, 2);
        }
        return;
    }
    const sprite = terrainSprite(biome, seed);
    if (sprite === null) return;
    const dense = ['forest', 'jungle', 'taiga', 'mountain'].includes(biome);
    const scale = dense ? 1.6 : 1;
    const offset = dense ? ((seed % 3) - 1) * size / 16 : 0;
    if (!drawPixelSprite(ctx, sprite, px - size * (scale - 1) / 2 + offset, py - size * (scale - 1) * 0.7, size * scale, dense || sprite !== 9)) {
        ctx.fillStyle = '#49774d'; ctx.fillRect(px + size / 4, py + size / 4, size / 2, size / 2);
    }
}
