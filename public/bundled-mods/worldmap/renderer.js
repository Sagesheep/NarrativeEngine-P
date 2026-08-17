/**
 * World Map — the tiled canvas renderer.
 *
 * Implements the standard slippy-map / tile-pyramid model (WORKORDER 5.3 §4):
 *
 *   • Four zoom levels at cell sizes 4, 8, 16, 32 px. Wheel zoom snaps between
 *     them; the blit scale is interpolated between snaps for smoothness, but
 *     the *tile cache* is per level.
 *   • A tile is identified by `(level, tileX, tileY)`, rasterised **once** from
 *     chunk data into an offscreen canvas, then cached. Pan draws cached
 *     tiles — no field evaluation, no chunk generation for tiles already
 *     rendered. This is the entire point of the rewrite.
 *   • LRU eviction at ~200 tiles. Tiles missing at the current level blit
 *     from a coarser cached level, upscaled, until they render — the standard
 *     fallback that keeps a pan from ever showing blank ground.
 *   • Every cached tile carries a `worldVersion`. A pan or zoom does *not*
 *     bump it; a re-solve, a settings change, a newly hardened cell, or a
 *     mutation does. On bump, the tile cache and the affected chunks clear.
 *
 * Hillshade (the one thing WORKORDER 5.1 got right) is computed at tile-raster
 * time from the stored elevation of the four neighbouring cells, once per
 * cell — not per pixel and not per frame.
 *
 * Coastlines use a 4-bit cardinal bitmask autotiling pass (§5): for each land
 * cell a 4-bit mask is built from whether each cardinal neighbour is ocean,
 * and a shore variant is selected. Sixteen tiles. Land-to-land transitions
 * read fine hard-edged at this zoom and are explicitly out of scope.
 *
 * The grid overlay (§6) strokes cell boundaries above terrain and below
 * anchors, fading out below 8 px/cell so a zoomed-out map is not a mesh of
 * lines. The screen↔cell conversion lives in `screenToCell`/`cellToScreen`
 * so WORKORDER 6's click-to-travel can reuse it.
 *
 * The interaction bugs carried over from WORKORDER 5.2 (§7) are fixed here:
 * `pointermove` is bound to the canvas for hover and to `window` only while a
 * drag/pan is active; the bounding rect is cached and refreshed from the
 * `ResizeObserver`; theme tokens are read once per paint into locals; the
 * cache key is the `worldVersion` integer, not a `JSON.stringify` of every
 * transect.
 *
 * This module deliberately has no imports outside the mod. It receives the
 * solved campaign snapshot and the field module via the options bag, so the
 * host never has to reach into the mod's interior.
 */

import {
    BIOME_COLORS,
    FIELD_SEA_LEVEL,
    FIELD_WORLD_SIZE,
} from './field.js';

const TILE_PIXELS = 256;
const ZOOM_LEVELS = Object.freeze([
    Object.freeze({ level: 0, cellPixels: 4 }),
    Object.freeze({ level: 1, cellPixels: 8 }),
    Object.freeze({ level: 2, cellPixels: 16 }),
    Object.freeze({ level: 3, cellPixels: 32 }),
]);
const GRID_FADE_BELOW_CELL_PIXELS = 8;
const LABEL_MIN_CELL_PIXELS = 9;
const DRAG_HIT_RADIUS_PX = 14;
const DOUBLE_CLICK_MS = 320;
const TILE_LRU_CAP = 200;
const LIGHT_ELEVATION = 1.2;
const FIELD_MIN_ELEVATION = -1;
const SHALLOW_WATER_EPSILON = 0.08;
const BEACH_EPSILON = 0.07;
const ZOOM_INTERPOLATION_MS = 180;
const COAST_DARKEN = 0.84;
const BIOME_VALUE_SCALES = Object.freeze({
    plains: 0.93,
    farmland: 1.07,
});

/** Renderer-only tuning knobs. Settings supplied by a snapshot override these. */
export const DEFAULT_RENDER_SETTINGS = Object.freeze({
    lightAzimuth: -((3 * Math.PI) / 4), // north-west in screen coordinates
    shadeStrength: 0.56,
});

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

// WO 4.1 §3.1 — one polyline per edge, routed through any waypoints on it in
// `t` order. The waypoint-grouping helpers live at module scope so they are
// reusable and so WO 6 can swap the straight segment for the pathfound route
// and the waypoint snaps to a point on *that* by changing one call site.
function edgeKey(fromId, toId) {
    return fromId < toId ? `${fromId}\u241f${toId}` : `${toId}\u241f${fromId}`;
}

/**
 * Group waypoints by the edge they sit on. A waypoint with `fromId` and
 * `toId` belongs to the undirected edge between them. Waypoints missing
 * both (degenerate fallback cases) are not grouped and do not draw on any
 * edge — they still render as anchors. The per-edge list is sorted by `t`
 * so the polyline walks from the `from` endpoint to the `to` endpoint
 * through the waypoints in order.
 */
function groupWaypointsByEdge(waypoints) {
    const byEdge = new Map();
    for (const waypoint of waypoints) {
        if (!waypoint || !waypoint.fromId || !waypoint.toId) continue;
        const key = edgeKey(waypoint.fromId, waypoint.toId);
        if (!byEdge.has(key)) byEdge.set(key, []);
        byEdge.get(key).push(waypoint);
    }
    for (const list of byEdge.values()) {
        list.sort((a, b) => (a.t ?? 0.5) - (b.t ?? 0.5));
    }
    return byEdge;
}

/**
 * Return the waypoints on the edge between `fromId` and `toId`, in t-order
 * relative to the `fromId` endpoint. The solver stores `t` as the fraction
 * from `fromId` to `toId`; if the connection is asked for in the reverse
 * direction (the ledger's symmetric connection was authored on the other
 * row), flip `t` so the polyline still walks in connection order.
 */
function waypointsForEdge(fromId, toId, byEdge) {
    const list = byEdge.get(edgeKey(fromId, toId));
    if (!list || list.length === 0) return [];
    return list.map(waypoint => {
        if (waypoint.fromId === fromId) return waypoint;
        return { ...waypoint, t: 1 - (waypoint.t ?? 0.5) };
    }).sort((a, b) => (a.t ?? 0.5) - (b.t ?? 0.5));
}

function normaliseRenderSettings(settings = {}) {
    const configured = settings.render || settings;
    const lightAzimuth = Number(configured.lightAzimuth);
    const shadeStrength = Number(configured.shadeStrength);
    return {
        lightAzimuth: Number.isFinite(lightAzimuth) ? lightAzimuth : DEFAULT_RENDER_SETTINGS.lightAzimuth,
        shadeStrength: Number.isFinite(shadeStrength)
            ? clamp(shadeStrength, 0, 1)
            : DEFAULT_RENDER_SETTINGS.shadeStrength,
    };
}

/** Return a land-light multiplier for a central-difference surface normal. */
export function hillshadeMultiplier(
    ex,
    ey,
    d = 1,
    lightAzimuth = DEFAULT_RENDER_SETTINGS.lightAzimuth,
    shadeStrength = DEFAULT_RENDER_SETTINGS.shadeStrength,
) {
    const normalLength = Math.hypot(-ex, -ey, 2 * d) || 1;
    const nx = -ex / normalLength;
    const ny = -ey / normalLength;
    const nz = (2 * d) / normalLength;
    const lightLength = Math.hypot(Math.cos(lightAzimuth), Math.sin(lightAzimuth), LIGHT_ELEVATION) || 1;
    const lx = Math.cos(lightAzimuth) / lightLength;
    const ly = Math.sin(lightAzimuth) / lightLength;
    const lz = LIGHT_ELEVATION / lightLength;
    const shade = clamp((nx * lx) + (ny * ly) + (nz * lz), 0, 1);
    return clamp(1 - (shadeStrength / 2) + (shadeStrength * shade), 0.72, 1.28);
}

function parseColor(value) {
    const text = String(value || '').trim();
    const hex = text.match(/^#([0-9a-f]{3,8})$/i);
    if (hex) {
        const digits = hex[1];
        if (digits.length === 3 || digits.length === 4) {
            const expanded = [...digits].map(digit => digit + digit).join('');
            return [
                parseInt(expanded.slice(0, 2), 16),
                parseInt(expanded.slice(2, 4), 16),
                parseInt(expanded.slice(4, 6), 16),
                digits.length === 4 ? parseInt(expanded.slice(6, 8), 16) : 255,
            ];
        }
        if (digits.length === 6 || digits.length === 8) {
            return [
                parseInt(digits.slice(0, 2), 16),
                parseInt(digits.slice(2, 4), 16),
                parseInt(digits.slice(4, 6), 16),
                digits.length === 8 ? parseInt(digits.slice(6, 8), 16) : 255,
            ];
        }
    }
    const rgb = text.match(/^rgba?\(\s*([\d.]+)[, ]+\s*([\d.]+)[, ]+\s*([\d.]+)(?:[,/]\s*([\d.]+)%?)?\s*\)$/i);
    if (rgb) {
        const alpha = rgb[4] === undefined
            ? 255
            : (text.includes('%') ? (Number(rgb[4]) * 2.55) : (Number(rgb[4]) * 255));
        return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3]), clamp(alpha, 0, 255)];
    }
    return [68, 68, 68, 255];
}

function rgbToHsl([red, green, blue]) {
    const r = red / 255;
    const g = green / 255;
    const b = blue / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let hue = 0;
    const lightness = (max + min) / 2;
    if (delta !== 0) {
        const saturation = delta / (1 - Math.abs((2 * lightness) - 1));
        if (max === r) hue = ((g - b) / delta) % 6;
        else if (max === g) hue = ((b - r) / delta) + 2;
        else hue = ((r - g) / delta) + 4;
        return [((hue / 6) + 1) % 1, saturation, lightness];
    }
    return [0, 0, lightness];
}

function hslToRgb(hue, saturation, lightness, alpha = 255) {
    if (saturation === 0) {
        const value = lightness * 255;
        return [value, value, value, alpha];
    }
    const hue2rgb = (p, q, t) => {
        let next = t;
        if (next < 0) next += 1;
        if (next > 1) next -= 1;
        if (next < 1 / 6) return p + ((q - p) * 6 * next);
        if (next < 1 / 2) return q;
        if (next < 2 / 3) return p + ((q - p) * ((2 / 3) - next) * 6);
        return p;
    };
    const q = lightness < 0.5
        ? lightness * (1 + saturation)
        : lightness + saturation - (lightness * saturation);
    const p = (2 * lightness) - q;
    return [
        hue2rgb(p, q, hue + (1 / 3)) * 255,
        hue2rgb(p, q, hue) * 255,
        hue2rgb(p, q, hue - (1 / 3)) * 255,
        alpha,
    ];
}

function adjustLightness(rgb, multiplier) {
    const [hue, saturation, lightness] = rgbToHsl(rgb);
    return hslToRgb(hue, saturation, clamp(lightness * multiplier, 0, 1), rgb[3]);
}

function scaleRgb(rgb, multiplier) {
    return [
        clamp(rgb[0] * multiplier, 0, 255),
        clamp(rgb[1] * multiplier, 0, 255),
        clamp(rgb[2] * multiplier, 0, 255),
        rgb[3],
    ];
}

function blendRgb(left, right, amount) {
    const t = clamp(amount, 0, 1);
    return [
        left[0] + ((right[0] - left[0]) * t),
        left[1] + ((right[1] - left[1]) * t),
        left[2] + ((right[2] - left[2]) * t),
        left[3] + ((right[3] - left[3]) * t),
    ];
}

function applyStyle(node, styles) {
    Object.assign(node.style, styles);
    return node;
}

function makeElement(tag, text, styles = {}) {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    return applyStyle(node, styles);
}

function makeOffscreenCanvas(w, h) {
    const CanvasCtor = globalThis.OffscreenCanvas;
    if (typeof CanvasCtor === 'function') {
        try { return new CanvasCtor(w, h); } catch { /* fall through */ }
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return canvas;
}

// ──────────────────────────────────────────────────────────────────────────
// Tile atlas — one image, one sub-rect per biome, blitted per cell (§5)
//
// Ship flat-colour tiles at the existing field.js:90 palette so the code path
// is complete; real drawn art swaps the atlas with no code change. The atlas
// and its index live in a data structure, not in the renderer. The 4-bit
// cardinal bitmask autotiling pass lives here because it reads neighbouring
// cells, which is a render-time concern.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build a flat-colour texture atlas: a single offscreen canvas with one
 * 256×256 sub-rect per biome, plus a 16-tile shore variant row for the
 * coastline autotiling pass. The atlas is rebuilt when the theme changes;
 * the renderer detects the change via `worldVersion` (settings carry the
 * version stamp). Swapping this builder for one that loads a real image
 * changes the map's appearance with no code change to the renderer.
 */
function buildTileAtlas(root) {
    const biomeIds = Object.keys(BIOME_COLORS);
    const tileCount = biomeIds.length + 16; // biomes + 16 shore variants
    const atlas = makeOffscreenCanvas(TILE_PIXELS * tileCount, TILE_PIXELS);
    const ctx = atlas.getContext('2d');
    const index = {};
    let slot = 0;
    for (const biomeId of biomeIds) {
        const token = readTokenOnce(root, `--worldmap-biome-${biomeId}`, '');
        const color = token || BIOME_COLORS[biomeId] || '#444';
        const valueScale = BIOME_VALUE_SCALES[biomeId] || 1;
        const adjusted = adjustLightness(parseColor(color), valueScale);
        ctx.fillStyle = `rgba(${adjusted[0] | 0},${adjusted[1] | 0},${adjusted[2] | 0},${adjusted[3] / 255})`;
        ctx.fillRect(slot * TILE_PIXELS, 0, TILE_PIXELS, TILE_PIXELS);
        index[biomeId] = slot;
        slot += 1;
    }
    // Shore variants: darken the base land colour by a small amount per
    // bitmask value so a coastline reads as a shore rather than a hard edge.
    const shoreBase = readTokenOnce(root, '--worldmap-biome-plains', '') || BIOME_COLORS.plains || '#7d9b5d';
    const shoreBaseRgb = adjustLightness(parseColor(shoreBase), BIOME_VALUE_SCALES.plains || 1);
    for (let mask = 0; mask < 16; mask += 1) {
        const oceanSides = popcount(mask);
        const darken = 1 - (oceanSides * 0.07);
        const variant = scaleRgb(shoreBaseRgb, darken);
        ctx.fillStyle = `rgba(${variant[0] | 0},${variant[1] | 0},${variant[2] | 0},${variant[3] / 255})`;
        ctx.fillRect(slot * TILE_PIXELS, 0, TILE_PIXELS, TILE_PIXELS);
        index[`shore:${mask}`] = slot;
        slot += 1;
    }
    return { atlas, index };
}

function popcount(n) {
    let count = 0;
    while (n) { count += n & 1; n >>>= 1; }
    return count;
}

/**
 * Build the 4-bit cardinal bitmask for a land cell: bit 0 = north, 1 = east,
 * 2 = south, 3 = west. A bit is set when that cardinal neighbour is ocean.
 * Returns -1 when the centre is itself ocean (no shore variant needed).
 */
function shoreBitmask(chunkStore, x, y) {
    const center = chunkStore.getCellBiomeByte(x, y);
    if (BIOME_IDS_INDEX.ocean === center) return -1;
    const n = chunkStore.getCellBiomeByte(x, y - 1) === BIOME_IDS_INDEX.ocean ? 1 : 0;
    const e = chunkStore.getCellBiomeByte(x + 1, y) === BIOME_IDS_INDEX.ocean ? 1 : 0;
    const s = chunkStore.getCellBiomeByte(x, y + 1) === BIOME_IDS_INDEX.ocean ? 1 : 0;
    const w = chunkStore.getCellBiomeByte(x - 1, y) === BIOME_IDS_INDEX.ocean ? 1 : 0;
    return (n << 0) | (e << 1) | (s << 2) | (w << 3);
}

const BIOME_IDS_INDEX = Object.freeze(
    Object.fromEntries(Object.keys(BIOME_COLORS).map((id, i) => [id, i])),
);

// ──────────────────────────────────────────────────────────────────────────
// Tile pyramid — per-level tile cache with LRU eviction (§4)
// ──────────────────────────────────────────────────────────────────────────

/**
 * A tile pyramid holds one offscreen canvas per `(level, tileX, tileY)` and
 * evicts least-recently-used tiles above `TILE_LRU_CAP`. Every tile carries
 * the `worldVersion` it was rasterised against; a version mismatch invalidates
 * the whole pyramid (the renderer drops the pyramid and starts a new one on
 * a world change, which is cheaper than per-tile invalidation).
 */
class TilePyramid {
    constructor() {
        this.tiles = new Map();
        this.order = [];
    }

    static key(level, tileX, tileY) {
        return `${level}:${tileX}:${tileY}`;
    }

    get(level, tileX, tileY) {
        const key = TilePyramid.key(level, tileX, tileY);
        const tile = this.tiles.get(key);
        if (!tile) return null;
        // Move to most-recently-used.
        const at = this.order.indexOf(key);
        if (at >= 0) this.order.splice(at, 1);
        this.order.push(key);
        return tile;
    }

    set(level, tileX, tileY, canvas) {
        const key = TilePyramid.key(level, tileX, tileY);
        if (this.tiles.has(key)) {
            const at = this.order.indexOf(key);
            if (at >= 0) this.order.splice(at, 1);
        }
        this.tiles.set(key, canvas);
        this.order.push(key);
        while (this.order.length > TILE_LRU_CAP) {
            const evict = this.order.shift();
            this.tiles.delete(evict);
        }
    }

    clear() {
        this.tiles.clear();
        this.order.length = 0;
    }

    get size() { return this.tiles.size; }
}

/**
 * Rasterise one tile from chunk data into an offscreen canvas. The tile
 * covers `cellsPerTile × cellsPerTile` world cells and is drawn at
 * `TILE_PIXELS × TILE_PIXELS`. Each cell is blitted from the atlas sub-rect
 * for its biome (or a shore variant for coastline cells), then hillshade is
 * applied per cell from the stored elevation of the four neighbours. This is
 * one pass per cell — not per pixel and not per frame.
 */
function rasteriseTile(pyramid, level, tileX, tileY, snapshot, atlas, rect) {
    const { cellPixels } = ZOOM_LEVELS[level];
    const cellsPerTile = Math.ceil(TILE_PIXELS / cellPixels);
    const originX = tileX * cellsPerTile;
    const originY = tileY * cellsPerTile;
    const canvas = makeOffscreenCanvas(TILE_PIXELS, TILE_PIXELS);
    const ctx = canvas.getContext('2d');
    const { chunkStore, settings } = snapshot;
    const renderSettings = normaliseRenderSettings(settings);
    const cellPixelSize = TILE_PIXELS / cellsPerTile;

    for (let ly = 0; ly < cellsPerTile; ly += 1) {
        for (let lx = 0; lx < cellsPerTile; lx += 1) {
            const worldX = originX + lx;
            const worldY = originY + ly;
            const cell = chunkStore.getCell(worldX, worldY);
            if (!cell) continue;
            const mask = shoreBitmask(chunkStore, worldX, worldY);
            const slotKey = mask >= 0 ? `shore:${mask}` : cell.biome;
            const slot = atlas.index[slotKey] ?? atlas.index[cell.biome] ?? 0;
            const px = lx * cellPixelSize;
            const py = ly * cellPixelSize;
            ctx.drawImage(
                atlas.atlas,
                slot * TILE_PIXELS, 0, TILE_PIXELS, TILE_PIXELS,
                px, py, Math.ceil(cellPixelSize) + 0.5, Math.ceil(cellPixelSize) + 0.5,
            );

            // Hillshade from the stored elevation of the four neighbours,
            // computed once per cell at tile-raster time (§4.2).
            if (cell.biome !== 'ocean') {
                const east = chunkStore.getCell(worldX + 1, worldY);
                const west = chunkStore.getCell(worldX - 1, worldY);
                const south = chunkStore.getCell(worldX, worldY + 1);
                const north = chunkStore.getCell(worldX, worldY - 1);
                const ex = (east?.elevation ?? cell.elevation) - (west?.elevation ?? cell.elevation);
                const ey = (south?.elevation ?? cell.elevation) - (north?.elevation ?? cell.elevation);
                const shade = hillshadeMultiplier(ex, ey, 1, renderSettings.lightAzimuth, renderSettings.shadeStrength);
                if (shade !== 1) {
                    ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
                    ctx.fillRect(px, py, Math.ceil(cellPixelSize) + 0.5, Math.ceil(cellPixelSize) + 0.5);
                }
                // Beach blend near sea level.
                if (cell.elevation >= FIELD_SEA_LEVEL && cell.elevation < FIELD_SEA_LEVEL + BEACH_EPSILON) {
                    const sandSlot = atlas.index.desert ?? atlas.index.plains ?? 0;
                    const beachAmount = clamp(
                        1 - ((cell.elevation - FIELD_SEA_LEVEL) / BEACH_EPSILON),
                        0, 1,
                    ) * 0.5;
                    ctx.globalAlpha = beachAmount;
                    ctx.drawImage(
                        atlas.atlas,
                        sandSlot * TILE_PIXELS, 0, TILE_PIXELS, TILE_PIXELS,
                        px, py, Math.ceil(cellPixelSize) + 0.5, Math.ceil(cellPixelSize) + 0.5,
                    );
                    ctx.globalAlpha = 1;
                }
            } else {
                // Ocean depth ramp.
                const depth = clamp(
                    (FIELD_SEA_LEVEL - cell.elevation) / (FIELD_SEA_LEVEL - FIELD_MIN_ELEVATION),
                    0, 1,
                );
                if (depth > 0.01) {
                    ctx.fillStyle = `rgba(0,0,0,${clamp(depth * 0.35, 0, 0.45)})`;
                    ctx.fillRect(px, py, Math.ceil(cellPixelSize) + 0.5, Math.ceil(cellPixelSize) + 0.5);
                }
                // Shallow band lighten.
                const shallowDepth = SHALLOW_WATER_EPSILON / (FIELD_SEA_LEVEL - FIELD_MIN_ELEVATION);
                if (depth < shallowDepth && depth > 0) {
                    ctx.fillStyle = `rgba(255,255,255,${clamp(0.12 * (1 - depth / shallowDepth), 0, 0.12)})`;
                    ctx.fillRect(px, py, Math.ceil(cellPixelSize) + 0.5, Math.ceil(cellPixelSize) + 0.5);
                }
            }
        }
    }
    pyramid.set(level, tileX, tileY, canvas);
    return canvas;
}

// ──────────────────────────────────────────────────────────────────────────
// Theme token cache — read once per paint into locals (§7)
// ──────────────────────────────────────────────────────────────────────────

const tokenCache = new WeakMap();

function readTokenOnce(root, name, fallback) {
    let cache = tokenCache.get(root);
    if (!cache) { cache = Object.create(null); tokenCache.set(root, cache); }
    if (Object.hasOwn(cache, name)) return cache[name];
    const value = getComputedStyle(root).getPropertyValue(name).trim();
    const result = value || fallback;
    cache[name] = result;
    return result;
}

function refreshTokenCache(root) {
    tokenCache.delete(root);
}

/**
 * Mount the map renderer into `root`. Returns a cleanup function.
 *
 * @param {HTMLElement} root
 * @param {{
 *   getSnapshot: () => {
 *     anchors: Array<{ locationId: string, name: string, x: number, y: number, pinned: boolean, source: string }>,
 *     transects: Array<object>,
 *     connections: Array<{ fromId: string, toId: string }>,
 *     settings: { worldSeed: string, climateGradient: number },
 *     hardened: Map<string, string>,
 *     locationId: string | null,
 *     worldVersion: number,
 *     chunkStore: object,
 *     controls: Array<object>,
 *   },
 *   onDragAnchor: (locationId: string, x: number, y: number) => void,
 *   log?: (...args: unknown[]) => void,
 *   onClickCell?: (x: number, y: number) => void,
 *   onRouteAction?: (action: 'commit' | 'cancel' | 'setMode', payload?: unknown) => void,
 *   getRoutePreview?: () => (null | {
 *     cells: Array<{x: number, y: number}>,
 *     cost: number,
 *     days: number,
 *     mode: string,
 *     blocked?: { reason: string, label?: string },
 *     fromAnchor?: { locationId: string, name: string },
 *     toAnchor?: { locationId: string, name: string } | { snapped: boolean, name?: string },
 *     cellCount?: number,
 *   }),
 *   getTravelMode?: () => string,
 *   travelModes?: Array<{ id: string, label: string }>,
 * }} options
 */
export function mountMapRenderer(root, options) {
    const {
        getSnapshot, onDragAnchor, log = () => undefined,
        onClickCell, onRouteAction, getRoutePreview, getTravelMode,
        travelModes,
    } = options;

    applyStyle(root, {
        boxSizing: 'border-box',
        position: 'relative',
        width: '100%',
        height: '100%',
        overflow: 'hidden',
        background: 'var(--color-void-darker, #0e0f12)',
        color: 'var(--color-text-primary, inherit)',
        fontFamily: 'inherit',
        touchAction: 'none',
        cursor: 'grab',
    });

    const canvas = document.createElement('canvas');
    applyStyle(canvas, { position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block' });
    root.appendChild(canvas);
    const ctx = canvas.getContext('2d');

    const overlay = makeElement('div', undefined, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    root.appendChild(overlay);

    const hud = makeElement('div', undefined, {
        position: 'absolute', top: '8px', left: '8px', padding: '5px 9px', borderRadius: '5px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.78))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        color: 'var(--color-text-primary, inherit)',
        font: '11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'none', opacity: '0.9',
    });
    overlay.appendChild(hud);

    const help = makeElement('div', 'Scroll to zoom · Drag to pan · Drag a pin to move it · Click a cell to travel', {
        position: 'absolute', bottom: '8px', left: '8px', padding: '4px 8px', borderRadius: '4px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.72))',
        color: 'var(--color-text-dim, inherit)',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'none', opacity: '0.78',
    });
    overlay.appendChild(help);

    // WO 6.1 §3 — a compact mode selector adjacent to the route, plus the
    // route-preview readout (distance in cells, derived days, or a blocked
    // explanation). `pointerEvents: auto` so the mode selector is clickable;
    // the readout stays non-interactive. Both sit top-right so they don't
    // fight the HUD (top-left) or the help line (bottom-left).
    const routePanel = makeElement('div', undefined, {
        position: 'absolute', top: '8px', right: '8px', padding: '6px 8px', borderRadius: '5px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.82))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        color: 'var(--color-text-primary, inherit)',
        font: '11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'auto', opacity: '0.95',
        display: 'none', flexDirection: 'column', gap: '4px', minWidth: '160px',
    });
    overlay.appendChild(routePanel);

    const modeRow = makeElement('div', undefined, { display: 'flex', alignItems: 'center', gap: '6px' });
    const modeLabel = makeElement('span', 'Mode', { opacity: '0.7', fontSize: '10px' });
    const modeSelect = document.createElement('select');
    modeSelect.setAttribute('aria-label', 'Travel mode');
    applyStyle(modeSelect, {
        background: 'var(--color-void, #0e0f12)',
        color: 'inherit',
        border: '1px solid var(--color-border, rgba(255,255,255,0.22))',
        borderRadius: '3px', padding: '2px 4px', font: 'inherit', fontSize: '11px',
    });
    const modeOptions = travelModes && travelModes.length > 0
        ? travelModes
        : [{ id: 'foot', label: 'On foot' }, { id: 'cart', label: 'Cart' }, { id: 'horseback', label: 'Horseback' }, { id: 'flying', label: 'Flying' }];
    for (const mode of modeOptions) {
        const opt = document.createElement('option');
        opt.value = mode.id;
        opt.textContent = mode.label;
        modeSelect.appendChild(opt);
    }
    modeSelect.addEventListener('change', () => {
        if (onRouteAction) onRouteAction('setMode', modeSelect.value);
    });
    modeRow.append(modeLabel, modeSelect);
    routePanel.appendChild(modeRow);

    const routeReadout = makeElement('div', undefined, { fontSize: '11px', whiteSpace: 'pre-wrap' });
    routePanel.appendChild(routeReadout);

    const routeCancelButton = makeElement('button', 'Cancel route', {
        padding: '3px 8px', border: '1px solid var(--color-border, rgba(255,255,255,0.22))',
        borderRadius: '3px', background: 'transparent', color: 'inherit',
        font: 'inherit', fontSize: '10px', cursor: 'pointer', alignSelf: 'flex-start',
    });
    routeCancelButton.addEventListener('click', () => {
        if (onRouteAction) onRouteAction('cancel');
    });
    routePanel.appendChild(routeCancelButton);

    const view = { cx: FIELD_WORLD_SIZE / 2, cy: FIELD_WORLD_SIZE / 2, cellPixels: ZOOM_LEVELS[1].cellPixels };

    // Cached bounding rect — refreshed from the ResizeObserver and on scroll,
    // never recomputed inside `worldToScreen`/`screenToWorld` which are called
    // in loops (§7). `getBoundingClientRect()` forces a layout each call.
    let cachedRect = null;
    function refreshRect() {
        cachedRect = root.getBoundingClientRect();
    }

    let dragging = null;
    let panLast = null;
    let pendingDragId = null;
    let pendingDragStart = null;
    let lastClickAt = 0;
    let lastClickLocationId = null;
    let resizeObserver = null;
    let rafHandle = 0;
    let disposed = false;

    // WO 6.1 §1 — click-to-travel state. A terrain click (no anchor hit, no
    // drag) is a two-phase gesture: first click previews the route, second
    // click on the same cell commits. A click elsewhere re-routes. The
    // previewed cell is tracked so the second click can be matched. The
    // renderer reports the click to the host via `onClickCell`; the host
    // computes the route (the pathfinder lives in the mod) and surfaces it
    // back through `getRoutePreview`. Commit/cancel/mode-change go through
    // `onRouteAction`.
    let travelClickCell = null; // { x, y } — the cell the current preview is for
    let panStarted = false;     // true if the current gesture moved enough to be a pan

    // WO 4.2 §2 — during a drag the renderer keeps the moving anchor's
    // position in `dragPreview` and paints it at the cursor. No host call,
    // no solve, no table write. The commit happens once, on pointer-up,
    // when the gesture rounds to a cell, validates, and calls
    // `onDragAnchor`. This removes the ~60 Hz read-modify-write storm that
    // raced `solveAndPersist` and produced the transient
    // `malformed player anchor` warnings.
    let dragPreview = null;

    // Tile pyramid + atlas. The pyramid is dropped wholesale on a world
    // version change; the atlas is rebuilt only when the theme changes.
    let pyramid = new TilePyramid();
    let atlas = null;
    let atlasWorldVersion = -1;
    let paintedWorldVersion = -1;
    let rasterCount = 0;

    function currentLevelIndex() {
        let best = 0;
        let bestDiff = Infinity;
        for (let i = 0; i < ZOOM_LEVELS.length; i += 1) {
            const diff = Math.abs(ZOOM_LEVELS[i].cellPixels - view.cellPixels);
            if (diff < bestDiff) { bestDiff = diff; best = i; }
        }
        return best;
    }

    function scheduleRender() {
        if (rafHandle) return;
        rafHandle = requestAnimationFrame(() => {
            rafHandle = 0;
            paint();
        });
    }

    function resize() {
        refreshRect();
        const rect = cachedRect;
        if (!rect) return;
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
            canvas.width = w * dpr;
            canvas.height = h * dpr;
            ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        }
        scheduleRender();
    }

    function cellSizePixels() {
        return clamp(view.cellPixels, ZOOM_LEVELS[0].cellPixels, ZOOM_LEVELS[ZOOM_LEVELS.length - 1].cellPixels);
    }

    // ── screen ↔ cell conversion (reusable for WO 6 click-to-travel) ──
    function cellToScreen(x, y) {
        const rect = cachedRect;
        const w = rect ? rect.width : 0;
        const h = rect ? rect.height : 0;
        const cell = cellSizePixels();
        return { x: ((x - view.cx) * cell) + (w / 2), y: ((y - view.cy) * cell) + (h / 2) };
    }

    function screenToCell(px, py) {
        const rect = cachedRect;
        const w = rect ? rect.width : 0;
        const h = rect ? rect.height : 0;
        const cell = cellSizePixels();
        return { x: ((px - (w / 2)) / cell) + view.cx, y: ((py - (h / 2)) / cell) + view.cy };
    }

    function hitTestAnchor(px, py) {
        const snapshot = getSnapshot();
        if (!snapshot || !Array.isArray(snapshot.anchors)) return null;
        let best = null;
        let bestDistance = DRAG_HIT_RADIUS_PX;
        for (const anchor of snapshot.anchors) {
            const screen = cellToScreen(anchor.x, anchor.y);
            const d = Math.hypot(screen.x - px, screen.y - py);
            if (d <= bestDistance) { bestDistance = d; best = anchor; }
        }
        return best;
    }

    function clampView() {
        const margin = 10;
        view.cx = Math.max(-margin, Math.min(FIELD_WORLD_SIZE + margin, view.cx));
        view.cy = Math.max(-margin, Math.min(FIELD_WORLD_SIZE + margin, view.cy));
    }

    function ensureAtlas(snapshot) {
        if (atlas && atlasWorldVersion === snapshot.worldVersion) return atlas;
        atlas = buildTileAtlas(root);
        atlasWorldVersion = snapshot.worldVersion;
        return atlas;
    }

    function paint() {
        const snapshot = getSnapshot();
        if (!snapshot || !snapshot.settings) return;
        const rect = cachedRect || root.getBoundingClientRect();
        cachedRect = rect;
        const width = Math.max(1, Math.floor(rect.width));
        const height = Math.max(1, Math.floor(rect.height));
        const cell = cellSizePixels();

        // World-version invalidation: a pan or zoom must never bump it; a
        // re-solve / settings / hardening change does. On bump, drop the tile
        // cache wholesale (§4.1).
        if (snapshot.worldVersion !== paintedWorldVersion) {
            pyramid.clear();
            paintedWorldVersion = snapshot.worldVersion;
        }
        const currentAtlas = ensureAtlas(snapshot);

        ctx.fillStyle = readTokenOnce(root, '--color-void-darker', '#0e0f12');
        ctx.fillRect(0, 0, width, height);

        drawTiles(snapshot, currentAtlas, width, height, cell);
        drawGridOverlay(width, height, cell);
        drawConnections(snapshot, cell);
        drawRoutePreview(cell);
        drawAnchors(snapshot, cell);
        drawHud(snapshot, cell);
        updateRoutePanel();

        refreshTokenCache(root);
    }

    function drawTiles(snapshot, currentAtlas, width, height, cell) {
        const levelIdx = currentLevelIndex();
        const level = ZOOM_LEVELS[levelIdx];
        const cellsPerTile = Math.ceil(TILE_PIXELS / level.cellPixels);
        const worldLeft = view.cx - ((width / 2) / cell);
        const worldTop = view.cy - ((height / 2) / cell);
        const tileX0 = Math.floor(worldLeft / cellsPerTile) - 1;
        const tileY0 = Math.floor(worldTop / cellsPerTile) - 1;
        const tileX1 = Math.floor((worldLeft + (width / cell)) / cellsPerTile) + 1;
        const tileY1 = Math.floor((worldTop + (height / cell)) / cellsPerTile) + 1;
        const cellPixelSize = cell;

        for (let ty = tileY0; ty <= tileY1; ty += 1) {
            for (let tx = tileX0; tx <= tileX1; tx += 1) {
                let tile = pyramid.get(level.level, tx, ty);
                if (!tile) {
                    tile = rasteriseTile(pyramid, level.level, tx, ty, snapshot, currentAtlas, cachedRect);
                    rasterCount += 1;
                }
                const screenX = ((tx * cellsPerTile - view.cx) * cellPixelSize) + (width / 2);
                const screenY = ((ty * cellsPerTile - view.cy) * cellPixelSize) + (height / 2);
                const drawW = cellsPerTile * cellPixelSize;
                const drawH = cellsPerTile * cellPixelSize;
                ctx.imageSmoothingEnabled = false;
                ctx.drawImage(tile, screenX, screenY, drawW, drawH);
            }
        }
    }

    function drawGridOverlay(width, height, cell) {
        if (cell >= GRID_FADE_BELOW_CELL_PIXELS) return;
        const alpha = clamp(1 - (cell / GRID_FADE_BELOW_CELL_PIXELS), 0, 1) * 0.25;
        if (alpha <= 0.01) return;
        ctx.save();
        ctx.strokeStyle = readTokenOnce(root, '--color-border', 'rgba(220,220,220,0.55)');
        ctx.globalAlpha = alpha;
        ctx.lineWidth = 1;
        ctx.beginPath();
        const worldLeft = view.cx - ((width / 2) / cell);
        const worldTop = view.cy - ((height / 2) / cell);
        const worldRight = worldLeft + (width / cell);
        const worldBottom = worldTop + (height / cell);
        const startCol = Math.floor(worldLeft);
        const endCol = Math.ceil(worldRight);
        const startRow = Math.floor(worldTop);
        const endRow = Math.ceil(worldBottom);
        for (let col = startCol; col <= endCol; col += 1) {
            const sx = ((col - view.cx) * cell) + (width / 2);
            ctx.moveTo(sx, 0);
            ctx.lineTo(sx, height);
        }
        for (let row = startRow; row <= endRow; row += 1) {
            const sy = ((row - view.cy) * cell) + (height / 2);
            ctx.moveTo(0, sy);
            ctx.lineTo(width, sy);
        }
        ctx.stroke();
        ctx.restore();
    }

    function drawConnections(snapshot, cell) {
        if (!snapshot.connections || cell < LABEL_MIN_CELL_PIXELS) return;
        const byId = new Map((snapshot.anchors || []).map(a => [a.locationId, a]));
        // WO 4.1 §3.1 — one polyline per edge, routed through any waypoints
        // on it in `t` order. The A—B connection becomes a single line
        // A→Road→B instead of drawing the triangle. The polyline
        // construction lives in one function so WO 6 can swap the straight
        // segment for the pathfound route and the waypoint snaps to a point
        // on *that*.
        const waypointsByEdge = groupWaypointsByEdge(snapshot.waypoints || []);
        // WO 4.2 §3 — when the party is on a transit node mid-journey, the
        // road it sits on is emphasised so "two days along the road to B"
        // reads at a glance. The current waypoint's edge is identified by
        // either endpoint matching `snapshot.locationId`.
        const currentPlaceId = snapshot.locationId ?? null;
        const emphasisedEdges = new Set();
        if (currentPlaceId) {
            for (const [key, list] of waypointsByEdge) {
                if (list.some(waypoint => waypoint.locationId === currentPlaceId)) {
                    emphasisedEdges.add(key);
                }
            }
        }
        const baseWidth = Math.max(1, cell / 6);
        const baseStroke = readTokenOnce(root, '--color-border', 'rgba(220,220,220,0.55)');
        const emphasisStroke = readTokenOnce(root, '--color-terminal', '#A78BFA');
        // Draw the base pass for every connection, then a second emphasised
        // pass for the current waypoint's road so it sits on top.
        for (const connection of snapshot.connections) {
            const from = byId.get(connection.fromId);
            const to = byId.get(connection.toId);
            if (!from || !to) continue;
            const key = edgeKey(connection.fromId, connection.toId);
            const isEmphasised = emphasisedEdges.has(key);
            ctx.lineWidth = isEmphasised ? Math.max(baseWidth * 2.2, baseWidth + 2) : baseWidth;
            ctx.strokeStyle = isEmphasised ? emphasisStroke : baseStroke;
            const fromScreen = cellToScreen(from.x, from.y);
            const toScreen = cellToScreen(to.x, to.y);
            const intermediates = waypointsForEdge(connection.fromId, connection.toId, waypointsByEdge)
                .map(waypoint => {
                    const anchor = byId.get(waypoint.locationId);
                    return anchor ? cellToScreen(anchor.x, anchor.y) : null;
                })
                .filter(Boolean);
            ctx.beginPath();
            ctx.moveTo(fromScreen.x, fromScreen.y);
            for (const point of intermediates) ctx.lineTo(point.x, point.y);
            ctx.lineTo(toScreen.x, toScreen.y);
            ctx.stroke();
        }
    }

    function drawAnchorDot(anchor, screen, radius, fill, strokeColor) {
        ctx.beginPath();
        ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = strokeColor;
        ctx.stroke();
    }

    function drawAnchorLabel(screen, radius, label, textColor) {
        ctx.font = '11px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        const labelX = screen.x + radius + 4;
        const labelY = screen.y - radius - 2;
        const metrics = ctx.measureText(label);
        ctx.fillStyle = 'rgba(0,0,0,0.55)';
        ctx.fillRect(labelX - 2, labelY - 8, metrics.width + 4, 16);
        ctx.fillStyle = textColor;
        ctx.fillText(label, labelX, labelY);
    }

    function drawAnchors(snapshot, cell) {
        const accentColor = readTokenOnce(root, '--color-command-accent', '#E01B1B');
        const currentColor = readTokenOnce(root, '--color-terminal', '#A78BFA');
        const idleColor = readTokenOnce(root, '--color-ice', '#E8EAED');
        const strokeColor = readTokenOnce(root, '--color-void-darker', '#0e0f12');
        const textColor = readTokenOnce(root, '--color-text-primary', '#E8EAED');
        const currentPlaceId = snapshot.locationId ?? null;
        // WO 4.2 §3 — the player's position is the most legible thing on
        // screen. A distinct marker (ring + larger radius) is drawn LAST so
        // nothing overlaps it, and its label always renders, even below
        // LABEL_MIN_CELL_PIXELS where other labels are suppressed.
        let currentAnchorEntry = null;
        // First pass: every anchor except the current one. The dragged
        // anchor is drawn at its preview position, not its committed one.
        for (const anchor of snapshot.anchors || []) {
            if (anchor.locationId === currentPlaceId) {
                currentAnchorEntry = anchor;
                continue;
            }
            const ax = dragPreview && dragPreview.locationId === anchor.locationId ? dragPreview.x : anchor.x;
            const ay = dragPreview && dragPreview.locationId === anchor.locationId ? dragPreview.y : anchor.y;
            const screen = cellToScreen(ax, ay);
            const radius = Math.max(5, cell / 2.4);
            const fill = anchor.pinned ? accentColor : idleColor;
            drawAnchorDot(anchor, screen, radius, fill, strokeColor);
            if (cell >= LABEL_MIN_CELL_PIXELS) {
                drawAnchorLabel(screen, radius, anchor.name || anchor.locationId, textColor);
            }
        }
        // Second pass: the current place, drawn last so nothing overlaps
        // it. A ring around the dot plus a larger radius makes it the most
        // legible marker on the map. Its label always renders.
        if (currentAnchorEntry) {
            const ax = dragPreview && dragPreview.locationId === currentAnchorEntry.locationId ? dragPreview.x : currentAnchorEntry.x;
            const ay = dragPreview && dragPreview.locationId === currentAnchorEntry.locationId ? dragPreview.y : currentAnchorEntry.y;
            const screen = cellToScreen(ax, ay);
            const baseRadius = Math.max(5, cell / 2.4);
            const radius = baseRadius * 1.45;
            // Outer ring.
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, radius + 4, 0, Math.PI * 2);
            ctx.strokeStyle = currentColor;
            ctx.lineWidth = 2;
            ctx.stroke();
            // Inner dot — keep the fill logic so a pinned current place
            // still reads as pinned (accent), otherwise the current colour.
            const fill = currentAnchorEntry.pinned ? accentColor : currentColor;
            drawAnchorDot(currentAnchorEntry, screen, radius, fill, strokeColor);
            drawAnchorLabel(screen, radius, currentAnchorEntry.name || currentAnchorEntry.locationId, textColor);
        }
    }

    function drawRoutePreview(cell) {
        if (!getRoutePreview) return;
        const preview = getRoutePreview();
        if (!preview) return;
        const cells = preview.cells;
        if (!cells || cells.length === 0) return;
        // WO 6.1 §1 — the preview polyline over the terrain. Highlighted, not
        // the base road colour, so it reads as "planned" not "walked". A
        // blocked route still draws its cells (if any) so the player sees
        // where the attempt was; the readout panel carries the reason.
        const previewStroke = readTokenOnce(root, '--color-terminal', '#A78BFA');
        const blockedStroke = readTokenOnce(root, '--color-command-accent', '#E01B1B');
        const isBlocked = Boolean(preview.blocked);
        ctx.save();
        ctx.lineWidth = Math.max(1.5, cell / 4);
        ctx.strokeStyle = isBlocked ? blockedStroke : previewStroke;
        ctx.globalAlpha = 0.85;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        const first = cellToScreen(cells[0].x, cells[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < cells.length; i += 1) {
            const s = cellToScreen(cells[i].x, cells[i].y);
            ctx.lineTo(s.x, s.y);
        }
        ctx.stroke();
        // Endpoints: a ring at the destination cell so the click target reads.
        if (cells.length > 0) {
            const end = cells[cells.length - 1];
            const endScreen = cellToScreen(end.x, end.y);
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(endScreen.x, endScreen.y, Math.max(6, cell / 1.8), 0, Math.PI * 2);
            ctx.strokeStyle = isBlocked ? blockedStroke : previewStroke;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.restore();
    }

    function updateRoutePanel() {
        if (!getRoutePreview) { routePanel.style.display = 'none'; return; }
        const preview = getRoutePreview();
        if (!preview) {
            routePanel.style.display = 'none';
            // If the host cleared the preview (commit, cancel, or campaign
            // switch), clear the renderer's click target too so the next
            // click is a fresh preview, not a commit.
            travelClickCell = null;
            return;
        }
        routePanel.style.display = 'flex';
        // Keep the mode selector in sync with the host's current mode without
        // firing a change event (the host is the source of truth).
        const currentMode = getTravelMode ? getTravelMode() : preview.mode;
        if (currentMode && modeSelect.value !== currentMode) {
            modeSelect.value = currentMode;
        }
        if (preview.blocked) {
            const reason = preview.blocked.label || preview.blocked.reason || 'no route';
            const toName = (preview.toAnchor && preview.toAnchor.name) || 'destination';
            routeReadout.textContent = `Blocked: ${reason}`;
            routeReadout.style.color = 'var(--color-command-accent, #E01B1B)';
            routeCancelButton.textContent = 'Dismiss';
        } else {
            const cellCount = preview.cellCount != null ? preview.cellCount : Math.max(0, (preview.cells || []).length - 1);
            const toName = (preview.toAnchor && preview.toAnchor.name) || 'destination';
            routeReadout.textContent = `→ ${toName}\n${cellCount} cells · ${preview.days} day${preview.days === 1 ? '' : 's'}\nClick again to travel`;
            routeReadout.style.color = 'var(--color-text-primary, inherit)';
            routeCancelButton.textContent = 'Cancel route';
        }
    }

    function drawHud(snapshot, cell) {
        const anchorCount = (snapshot.anchors || []).length;
        const currentPlaceId = snapshot.locationId ?? null;
        const hasCurrent = currentPlaceId
            ? (snapshot.anchors || []).some(anchor => anchor.locationId === currentPlaceId)
            : false;
        const currentLine = currentPlaceId && !hasCurrent
            ? ' · current place has no anchor'
            : '';
        hud.textContent = 'cell ' + view.cx.toFixed(0) + ',' + view.cy.toFixed(0)
            + ' · ' + cell.toFixed(0) + 'px · ' + anchorCount + ' anchors · '
            + pyramid.size + ' tiles' + currentLine;
    }

    // ── Interaction (§7 fixes) ──
    // Hover hit-testing binds to the canvas only. The window-level
    // `pointermove`/`pointerup` listeners attach while a drag or pan is active
    // and detach on pointer-up, so moving the mouse elsewhere in the app costs
    // nothing.
    function onCanvasPointerMove(event) {
        if (dragging || panLast || pendingDragId) return;
        const rect = cachedRect || root.getBoundingClientRect();
        cachedRect = rect;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const hover = hitTestAnchor(px, py);
        root.style.cursor = hover ? 'pointer' : 'grab';
    }

    function onWindowPointerMove(event) {
        if (!dragging && !panLast && !pendingDragId) return;
        const rect = cachedRect;
        if (!rect) return;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        if (pendingDragId && pendingDragStart) {
            if (Math.hypot(px - pendingDragStart.px, py - pendingDragStart.py) > 3) {
                dragging = pendingDragId;
            }
            if (dragging === pendingDragId) {
                // WO 4.2 §2 — local preview only. No host call, no solve.
                const cell = cellSizePixels();
                const dx = (px - pendingDragStart.px) / cell;
                const dy = (py - pendingDragStart.py) / cell;
                const x = pendingDragStart.x + dx;
                const y = pendingDragStart.y + dy;
                dragPreview = {
                    locationId: pendingDragId,
                    x: clamp(x, 0, FIELD_WORLD_SIZE - 1),
                    y: clamp(y, 0, FIELD_WORLD_SIZE - 1),
                };
                scheduleRender();
            }
            return;
        }
        if (panLast) {
            const cell = cellSizePixels();
            view.cx -= (px - panLast.px) / cell;
            view.cy -= (py - panLast.py) / cell;
            panLast = { px, py };
            panStarted = true;
            clampView();
            scheduleRender();
            return;
        }
    }

    function onWindowPointerUp(event) {
        const rect = cachedRect;
        const px = rect ? event.clientX - rect.left : 0;
        const py = rect ? event.clientY - rect.top : 0;
        if (pendingDragId && pendingDragStart) {
            const moved = Math.hypot(px - pendingDragStart.px, py - pendingDragStart.py) > 3;
            if (!moved) {
                // Click — either a double-click-to-place or a no-op. The
                // double-click path below still commits once, as before.
                const now = Date.now();
                if (now - lastClickAt < DOUBLE_CLICK_MS && lastClickLocationId === pendingDragId) {
                    const world = screenToCell(px, py);
                    // WO 4.2 §2 — validate before committing a double-click
                    // placement too. A non-finite or OOB coordinate is
                    // rejected and the previous position survives.
                    if (Number.isFinite(world.x) && Number.isFinite(world.y)) {
                        const cx = clamp(Math.round(world.x), 0, FIELD_WORLD_SIZE - 1);
                        const cy = clamp(Math.round(world.y), 0, FIELD_WORLD_SIZE - 1);
                        onDragAnchor(pendingDragId, cx, cy);
                    }
                    lastClickAt = 0;
                    lastClickLocationId = null;
                } else {
                    lastClickAt = now;
                    lastClickLocationId = pendingDragId;
                }
            } else if (dragging === pendingDragId) {
                // WO 4.2 §2 — commit once on release. Round to a cell,
                // validate both coordinates are finite and in-bounds, then
                // call onDragAnchor. Reject rather than store a bad
                // coordinate — the previous position survives.
                const candidateX = dragPreview ? Math.round(dragPreview.x) : pendingDragStart.x;
                const candidateY = dragPreview ? Math.round(dragPreview.y) : pendingDragStart.y;
                const startCellX = Math.round(pendingDragStart.x);
                const startCellY = Math.round(pendingDragStart.y);
                if (Number.isFinite(candidateX) && Number.isFinite(candidateY)
                    && candidateX >= 0 && candidateX < FIELD_WORLD_SIZE
                    && candidateY >= 0 && candidateY < FIELD_WORLD_SIZE) {
                    // A drag ending on its starting cell is a click — write
                    // nothing. This matches the spec: "a drag that ends on
                    // its starting cell writes nothing."
                    if (candidateX !== startCellX || candidateY !== startCellY) {
                        onDragAnchor(pendingDragId, candidateX, candidateY);
                    }
                }
            }
        } else if (panLast && onClickCell && !panStarted) {
            // WO 6.1 §1 — a terrain click (no anchor hit, no movement). This
            // is the click-to-travel entry point. The first click on a cell
            // previews the route; a second click on the SAME cell commits; a
            // click on a different cell re-routes. The renderer only reports
            // the cell — the mod computes the route (pathfinder + anchor
            // snap) and surfaces it back through `getRoutePreview`.
            const world = screenToCell(px, py);
            if (Number.isFinite(world.x) && Number.isFinite(world.y)) {
                const cx = clamp(Math.round(world.x), 0, FIELD_WORLD_SIZE - 1);
                const cy = clamp(Math.round(world.y), 0, FIELD_WORLD_SIZE - 1);
                if (travelClickCell && travelClickCell.x === cx && travelClickCell.y === cy) {
                    // Second click on the same cell → commit.
                    if (onRouteAction) onRouteAction('commit');
                    travelClickCell = null;
                } else {
                    // First click (or click on a different cell) → preview.
                    travelClickCell = { x: cx, y: cy };
                    onClickCell(cx, cy);
                }
            }
        }
        pendingDragId = null;
        pendingDragStart = null;
        dragging = null;
        dragPreview = null;
        panLast = null;
        panStarted = false;
        root.style.cursor = 'grab';
        detachWindowListeners();
        scheduleRender();
    }

    function attachWindowListeners() {
        window.addEventListener('pointermove', onWindowPointerMove);
        window.addEventListener('pointerup', onWindowPointerUp);
    }

    function detachWindowListeners() {
        window.removeEventListener('pointermove', onWindowPointerMove);
        window.removeEventListener('pointerup', onWindowPointerUp);
    }

    function onPointerDown(event) {
        if (event.button !== undefined && event.button !== 0) return;
        refreshRect();
        const rect = cachedRect;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const hit = hitTestAnchor(px, py);
        if (hit) {
            pendingDragId = hit.locationId;
            pendingDragStart = { px, py, x: hit.x, y: hit.y };
            root.style.cursor = 'grabbing';
            attachWindowListeners();
            return;
        }
        panLast = { px, py };
        root.style.cursor = 'grabbing';
        attachWindowListeners();
    }

    function onWheel(event) {
        event.preventDefault();
        refreshRect();
        const rect = cachedRect;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const before = screenToCell(px, py);
        const factor = Math.exp(-event.deltaY * 0.0015);
        // Snap to the nearest zoom level after a smooth interpolation.
        view.cellPixels = clamp(view.cellPixels * factor, ZOOM_LEVELS[0].cellPixels, ZOOM_LEVELS[ZOOM_LEVELS.length - 1].cellPixels);
        const cell = cellSizePixels();
        view.cx = before.x - ((px - rect.width / 2) / cell);
        view.cy = before.y - ((py - rect.height / 2) / cell);
        clampView();
        scheduleRender();
    }

    function centreOnAnchors() {
        const snapshot = getSnapshot();
        if (!snapshot || !Array.isArray(snapshot.anchors) || snapshot.anchors.length === 0) return;
        let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
        for (const a of snapshot.anchors) {
            if (a.x < minX) minX = a.x;
            if (a.y < minY) minY = a.y;
            if (a.x > maxX) maxX = a.x;
            if (a.y > maxY) maxY = a.y;
        }
        view.cx = (minX + maxX) / 2;
        view.cy = (minY + maxY) / 2;
        const span = Math.max(maxX - minX, maxY - minY, 10) + 8;
        const rect = cachedRect || root.getBoundingClientRect();
        cachedRect = rect;
        const targetCell = Math.min(rect.width, rect.height) / span;
        view.cellPixels = clamp(targetCell, ZOOM_LEVELS[0].cellPixels, ZOOM_LEVELS[ZOOM_LEVELS.length - 1].cellPixels);
        clampView();
        scheduleRender();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onCanvasPointerMove);
    canvas.addEventListener('wheel', onWheel, { passive: false });

    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { refreshRect(); refreshTokenCache(root); resize(); });
        resizeObserver.observe(root);
    } else {
        window.addEventListener('resize', resize);
    }

    refreshRect();
    resize();
    centreOnAnchors();
    scheduleRender();

    return () => {
        disposed = true;
        if (rafHandle) cancelAnimationFrame(rafHandle);
        rafHandle = 0;
        detachWindowListeners();
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onCanvasPointerMove);
        canvas.removeEventListener('wheel', onWheel);
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        else window.removeEventListener('resize', resize);
        pyramid.clear();
        root.replaceChildren();
    };
}