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
// The atlas cell is the SOURCE resolution of a biome's art, and is a separate
// number from the rasterised tile. It used to be `TILE_PIXELS` — a 256px
// square blitted into an on-screen cell of at most 32px, so seven eighths of
// every atlas cell was thrown away by the downscale and any detail drawn into
// it turned to mush. 64px is 2x the largest cell the map ever draws, which
// leaves headroom for the filter without paying for invisible pixels.
const ATLAS_TILE_PIXELS = 64;
// Every cell of one biome used to blit the identical atlas square, so a region
// of savanna painted as one flat rectangle of colour. Four variants per biome,
// chosen by a hash of the cell's own coordinates, is the standard tilemap
// answer: the cost stays one blit per cell and the wallpaper repeat goes away.
const BIOME_VARIANTS = 4;
// Contour lines are drawn where a cell's elevation band differs from its north
// or west neighbour. Below this on-screen cell size they are thinner than the
// cells they separate, so they are skipped — that also keeps them off the
// zoomed-out level, where one tile covers 4096 cells.
const CONTOUR_MIN_CELL_PIXELS = 3;
const CONTOUR_INTERVAL = 0.055;
// Exported for the WO 5.5 §7 test (screen-pixel sizing assertion across all
// four zoom levels). Frozen — exporting does not change behaviour.
export const ZOOM_LEVELS = Object.freeze([
    Object.freeze({ level: 0, cellPixels: 4 }),
    Object.freeze({ level: 1, cellPixels: 8 }),
    Object.freeze({ level: 2, cellPixels: 16 }),
    Object.freeze({ level: 3, cellPixels: 32 }),
]);
const GRID_FADE_BELOW_CELL_PIXELS = 8;
const LABEL_MIN_CELL_PIXELS = 9;

/**
 * Is there a committed journey polyline to draw?
 *
 * `drawJourney` and `drawConnections` both need this answer and must not
 * disagree about it: the road emphasis stands down exactly when the journey
 * line stands up, or the map draws the same journey twice in the same colour.
 * One function, two callers — the alternative is two conditions that drift.
 *
 * Exported so the decision can be tested for what it is (a decision) rather
 * than inferred from canvas stroke widths, which jsdom cannot see honestly.
 */
export function journeyIsDrawable(snapshot) {
    const journey = snapshot?.journey;
    return Boolean(
        journey
        && Array.isArray(journey.cells)
        && journey.cells.length > 0
        && Number.isFinite(snapshot?.journeyLeg),
    );
}
const DRAG_HIT_RADIUS_PX = 14;
// One dead zone for every gesture. Below this many pixels, a pointer
// down/up pair is a CLICK; at or beyond it, it is a drag or a pan.
//
// The pan path previously had NO dead zone: `panStarted` flipped true on the
// first `pointermove`, and pointer-up only fires a click when `!panStarted`.
// So a one-pixel twitch between press and release silently cancelled the
// click, and travel felt like it ignored you at random. The anchor drag had
// a 3px threshold, which is below the noise floor of a normal click.
//
// 6px is the conventional desktop threshold (browsers and OS toolkits use
// 4-8). One constant, both gestures — a click must mean the same thing over
// a place as it does over open ground.
const DRAG_DEAD_ZONE_PX = 6;
const TILE_LRU_CAP = 200;
const LIGHT_ELEVATION = 1.2;
const FIELD_MIN_ELEVATION = -1;
const SHALLOW_WATER_EPSILON = 0.08;
const BEACH_EPSILON = 0.07;
const ZOOM_INTERPOLATION_MS = 180;
const COAST_DARKEN = 0.84;
const CELL_KILOMETRES = 8;
// WO 5.5 §1 — the party marker is a different kind of object, not an anchor
// with emphasis. A teardrop map pin sized in SCREEN pixels so it cannot be
// mistaken for a place at any zoom (every other anchor scales with `cell`,
// the party does not). Drawn last, over everything, never occluded. The tip
// sits on the anchor cell; the body rises above it. The tip is the truth.
const PARTY_PIN_HEIGHT_PX = 28;
const PARTY_PIN_WIDTH_PX = 18;
const PARTY_PIN_TAIL_PX = 6;
// Two concentric rings outside the pin — the outer one pulses on a slow cycle
// (~2s). Cheap: two `arc` calls per frame. Under `prefers-reduced-motion` the
// phase does not advance (§1 / §7).
const PARTY_HALLO_INNER_PX = 22;
const PARTY_HALLO_OUTER_PX = 30;
const PARTY_PULSE_PERIOD_MS = 2000;
// §2 — the off-screen indicator. An arrow clamped to the viewport edge,
// pointing at the party, in the party colour, with the distance in grids
// beside it. Clicking the arrow centres the camera on the party.
const PARTY_INDICATOR_RADIUS_PX = 16;
const PARTY_INDICATOR_HIT_PX = 22;
const DEFAULT_LAYER_SETTINGS = Object.freeze({
    grid: true,
    roads: true,
    labels: true,
});
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

// WO 5.5 §1 / §7 — under `prefers-reduced-motion` the halo pulse phase does
// not advance (the rings draw static). Read once per paint and cached for the
// frame so every draw call in the same paint agrees.
function prefersReducedMotion() {
    return typeof matchMedia === 'function'
        && matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/**
 * Normalise the conventional map-viewer layers. The settings table is user
 * data, so older campaigns and malformed hand-edited rows must fall back to
 * the visible defaults without disabling the map.
 */
export function normaliseLayerSettings(settings = {}) {
    const layers = settings?.layers ?? settings ?? {};
    return {
        grid: layers.grid === undefined ? DEFAULT_LAYER_SETTINGS.grid : layers.grid !== false,
        roads: layers.roads === undefined ? DEFAULT_LAYER_SETTINGS.roads : layers.roads !== false,
        labels: layers.labels === undefined ? DEFAULT_LAYER_SETTINGS.labels : layers.labels !== false,
    };
}

/** Pick a conventional distance for a scale bar near the requested width. */
export function scaleDistanceKilometres(cellPixels) {
    const targetCells = 100 / Math.max(0.01, Number(cellPixels) || 1);
    const candidates = [];
    for (let exponent = -1; exponent <= 6; exponent += 1) {
        const magnitude = 10 ** exponent;
        for (const factor of [1, 2, 5]) candidates.push(factor * magnitude);
    }
    const targetKilometres = targetCells * CELL_KILOMETRES;
    return candidates.reduce((best, candidate) => (
        Math.abs(candidate - targetKilometres) < Math.abs(best - targetKilometres) ? candidate : best
    ), candidates[0]);
}

export function formatScaleDistance(kilometres) {
    const value = Number(kilometres);
    if (!Number.isFinite(value)) return '—';
    if (value >= 1000) {
        const formatted = value % 1000 === 0 ? String(value / 1000) : (value / 1000).toFixed(1).replace(/\.0$/, '');
        return `${formatted}k km`;
    }
    return `${value} km`;
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
 * A deterministic 32-bit LCG. The atlas is rebuilt whenever the theme or the
 * world version changes, so its art has to come out identical every time —
 * `Math.random()` here would make the terrain shimmer on every rebuild. Same
 * rule the field already follows: there is no `Math.random()` in this map.
 */
function makeAtlasRng(seed) {
    let state = seed >>> 0;
    return function next() {
        state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/** Which of a biome's variants a cell uses. Stable for a given cell forever. */
export function cellTextureVariant(x, y) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1);
    h ^= h >>> 15;
    h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12;
    return (h >>> 0) % BIOME_VARIANTS;
}

function cssRgb(rgb, alpha = 1) {
    return `rgba(${rgb[0] | 0},${rgb[1] | 0},${rgb[2] | 0},${alpha})`;
}

/**
 * The mark vocabulary, one painter per biome.
 *
 * These are map marks, not photographs: a world cell is eight kilometres
 * across, so what belongs here is the shorthand a drawn map uses — stipple,
 * hatching, dune arcs, ridge chevrons — in the biome's own colour, a step
 * lighter or darker. The palette does not change; only the surface does. The
 * existing constants are deliberately muted so the map reads as a map, and
 * these keep to that.
 *
 * Every painter is restricted to `fillRect`, `arc`, `moveTo`/`lineTo` and the
 * alpha/colour properties. That is not an aesthetic choice: the canvas stubs
 * the tests run against implement that subset, and a painter that reaches past
 * it would throw inside a `requestAnimationFrame` the tests swallow — a map
 * that silently renders nothing while the suite stays green.
 */
const BIOME_TEXTURE = Object.freeze({
    ocean(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 2, 0.12);
        ctx.strokeStyle = cssRgb(scaleRgb(base, 1.5), 0.3);
        ctx.lineWidth = Math.max(1, size / 24);
        for (let i = 0; i < 5; i += 1) {
            const y = rng() * size;
            const x = rng() * size * 0.5;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + (size * (0.2 + (rng() * 0.3))), y);
            ctx.stroke();
        }
    },
    glacier(ctx, size, base, rng) {
        ctx.strokeStyle = cssRgb(scaleRgb(base, 0.82), 0.5);
        ctx.lineWidth = Math.max(1, size / 48);
        for (let i = 0; i < 3; i += 1) {
            let x = rng() * size;
            let y = rng() * size;
            ctx.beginPath();
            ctx.moveTo(x, y);
            for (let seg = 0; seg < 3; seg += 1) {
                x += (rng() - 0.5) * size * 0.5;
                y += (rng() - 0.5) * size * 0.5;
                ctx.lineTo(x, y);
            }
            ctx.stroke();
        }
        speckle(ctx, size, rng, scaleRgb(base, 1.12), 10, 0.5);
    },
    tundra(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 3, 0.08);
        speckle(ctx, size, rng, scaleRgb(base, 0.82), 14, 0.55);
        speckle(ctx, size, rng, scaleRgb(base, 1.14), 10, 0.45);
    },
    taiga(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 2, 0.09);
        conifers(ctx, size, base, rng, 9);
    },
    forest(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 2, 0.1);
        crowns(ctx, size, base, rng, 12, 0.2);
    },
    plains(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 3, 0.09);
        tufts(ctx, size, base, rng, 26, 0.34);
        speckle(ctx, size, rng, scaleRgb(base, 0.86), 8, 0.3);
    },
    farmland(ctx, size, base, rng, variant) {
        // Furrows, turned a quarter for half the variants, so neighbouring
        // fields read as separate holdings rather than one continuous crop.
        const vertical = (variant % 2) === 0;
        const rows = 5 + (variant % 2);
        ctx.strokeStyle = cssRgb(scaleRgb(base, 0.86), 0.45);
        ctx.lineWidth = Math.max(1, size / 40);
        for (let i = 1; i < rows; i += 1) {
            const t = (i / rows) * size;
            ctx.beginPath();
            if (vertical) { ctx.moveTo(t, 0); ctx.lineTo(t, size); }
            else { ctx.moveTo(0, t); ctx.lineTo(size, t); }
            ctx.stroke();
        }
    },
    savanna(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 3, 0.08);
        tufts(ctx, size, base, rng, 14, 0.28);
        crowns(ctx, size, scaleRgb(base, 0.7), rng, 2, 0.5);
    },
    desert(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 2, 0.07);
        // Dune crests: a light arc with its own shadow just under it.
        for (let i = 0; i < 3; i += 1) {
            const cx = rng() * size;
            const cy = (i + 0.5) * (size / 3) + ((rng() - 0.5) * size * 0.12);
            const r = size * (0.35 + (rng() * 0.3));
            ctx.lineWidth = Math.max(1, size / 40);
            ctx.strokeStyle = cssRgb(scaleRgb(base, 1.12), 0.5);
            ctx.beginPath();
            ctx.arc(cx, cy, r, Math.PI * 1.15, Math.PI * 1.85);
            ctx.stroke();
            ctx.strokeStyle = cssRgb(scaleRgb(base, 0.86), 0.4);
            ctx.beginPath();
            ctx.arc(cx, cy + (size / 24), r, Math.PI * 1.2, Math.PI * 1.8);
            ctx.stroke();
        }
    },
    marsh(ctx, size, base, rng) {
        ctx.fillStyle = cssRgb(scaleRgb(base, 0.72), 0.55);
        for (let i = 0; i < 5; i += 1) {
            ctx.beginPath();
            ctx.arc(rng() * size, rng() * size, size * (0.05 + (rng() * 0.07)), 0, Math.PI * 2);
            ctx.fill();
        }
        tufts(ctx, size, base, rng, 9, 0.22);
    },
    jungle(ctx, size, base, rng) {
        mottle(ctx, size, base, rng, 2, 0.11);
        crowns(ctx, size, base, rng, 18, 0.22);
    },
    mountain(ctx, size, base, rng) {
        // Ridge chevrons, lit face and shadow face, the same north-west light
        // the hillshade uses so the two do not argue.
        for (let i = 0; i < 3; i += 1) {
            const cx = rng() * size;
            const cy = (i + 0.5) * (size / 3) + ((rng() - 0.5) * size * 0.15);
            const w = size * (0.16 + (rng() * 0.14));
            const h = w * 0.85;
            ctx.lineWidth = Math.max(1, size / 32);
            ctx.strokeStyle = cssRgb(scaleRgb(base, 1.2), 0.55);
            ctx.beginPath();
            ctx.moveTo(cx - w, cy + h);
            ctx.lineTo(cx, cy - h);
            ctx.stroke();
            ctx.strokeStyle = cssRgb(scaleRgb(base, 0.7), 0.55);
            ctx.beginPath();
            ctx.moveTo(cx, cy - h);
            ctx.lineTo(cx + w, cy + h);
            ctx.stroke();
        }
    },
});

/**
 * Broad, soft patches of slightly-off tone.
 *
 * The fine marks below are the texture you see at full zoom, and they are
 * exactly what a 64px square blitted into an 8px cell averages back into flat
 * colour. Mottling is the part that survives the downscale, so it is what
 * stops the zoomed-out map reading as printed card.
 */
function mottle(ctx, size, base, rng, count, strength) {
    for (let i = 0; i < count; i += 1) {
        const lighter = rng() < 0.5;
        ctx.fillStyle = cssRgb(scaleRgb(base, lighter ? 1 + strength : 1 - strength), 0.5);
        ctx.beginPath();
        ctx.arc(rng() * size, rng() * size, size * (0.18 + (rng() * 0.22)), 0, Math.PI * 2);
        ctx.fill();
    }
}

function speckle(ctx, size, rng, rgb, count, alpha) {
    ctx.fillStyle = cssRgb(rgb, alpha);
    const dot = Math.max(1, size / 32);
    for (let i = 0; i < count; i += 1) {
        ctx.fillRect(rng() * size, rng() * size, dot, dot);
    }
}

function tufts(ctx, size, base, rng, count, alpha) {
    ctx.lineWidth = Math.max(1, size / 48);
    for (let i = 0; i < count; i += 1) {
        const x = rng() * size;
        const y = rng() * size;
        const h = size * (0.05 + (rng() * 0.06));
        ctx.strokeStyle = cssRgb(scaleRgb(base, rng() < 0.5 ? 1.16 : 0.84), alpha + (rng() * 0.1));
        ctx.beginPath();
        ctx.moveTo(x, y + h);
        ctx.lineTo(x + ((rng() - 0.5) * h), y);
        ctx.stroke();
    }
}

function crowns(ctx, size, base, rng, count, alpha) {
    for (let i = 0; i < count; i += 1) {
        const r = size * (0.05 + (rng() * 0.05));
        ctx.fillStyle = cssRgb(scaleRgb(base, 0.74), alpha + 0.18);
        ctx.beginPath();
        ctx.arc(rng() * size, rng() * size, r, 0, Math.PI * 2);
        ctx.fill();
    }
    ctx.fillStyle = cssRgb(scaleRgb(base, 1.22), alpha);
    for (let i = 0; i < Math.ceil(count / 2); i += 1) {
        ctx.beginPath();
        ctx.arc(rng() * size, rng() * size, size * 0.035, 0, Math.PI * 2);
        ctx.fill();
    }
}

function conifers(ctx, size, base, rng, count) {
    ctx.fillStyle = cssRgb(scaleRgb(base, 0.68), 0.5);
    for (let i = 0; i < count; i += 1) {
        const x = rng() * size;
        const y = rng() * size;
        const w = size * (0.05 + (rng() * 0.04));
        ctx.beginPath();
        ctx.moveTo(x, y - (w * 1.6));
        ctx.lineTo(x + w, y + w);
        ctx.lineTo(x - w, y + w);
        ctx.lineTo(x, y - (w * 1.6));
        ctx.fill();
    }
}

/**
 * Build the texture atlas: one offscreen canvas holding `BIOME_VARIANTS`
 * textured squares per biome plus a 16-square shore row for the coastline
 * autotiling pass. Laid out as a GRID rather than a strip — a strip of 64
 * squares would have been 16384px wide, which is exactly the maximum canvas
 * dimension on a good deal of hardware and past it on the rest.
 *
 * Everything here is paid once per theme or world-version change, and nothing
 * here is paid per cell, per tile or per frame: the raster path still blits
 * one square per cell whether that square is a flat colour or a drawn one.
 *
 * The atlas is rebuilt when the theme changes; the renderer detects the change
 * via `worldVersion` (settings carry the version stamp).
 */
export function buildTileAtlas(root) {
    const biomeIds = Object.keys(BIOME_COLORS);
    const slotCount = (biomeIds.length * BIOME_VARIANTS) + 16;
    const cols = Math.ceil(Math.sqrt(slotCount));
    const rows = Math.ceil(slotCount / cols);
    const atlas = makeOffscreenCanvas(ATLAS_TILE_PIXELS * cols, ATLAS_TILE_PIXELS * rows);
    const ctx = atlas.getContext('2d');
    const index = {};
    let slot = 0;

    const paintSquare = (rgb, painter, variant) => {
        const ox = (slot % cols) * ATLAS_TILE_PIXELS;
        const oy = Math.floor(slot / cols) * ATLAS_TILE_PIXELS;
        ctx.save();
        ctx.setTransform(1, 0, 0, 1, ox, oy);
        ctx.globalAlpha = 1;
        ctx.fillStyle = cssRgb(rgb, rgb[3] / 255);
        ctx.fillRect(0, 0, ATLAS_TILE_PIXELS, ATLAS_TILE_PIXELS);
        if (painter) painter(ctx, ATLAS_TILE_PIXELS, rgb, makeAtlasRng(0x9e3779b9 + (slot * 2654435761)), variant);
        ctx.restore();
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        slot += 1;
    };

    for (const biomeId of biomeIds) {
        const token = readTokenOnce(root, `--worldmap-biome-${biomeId}`, '');
        const color = token || BIOME_COLORS[biomeId] || '#444';
        const valueScale = BIOME_VALUE_SCALES[biomeId] || 1;
        const adjusted = adjustLightness(parseColor(color), valueScale);
        const painter = BIOME_TEXTURE[biomeId] || null;
        index[biomeId] = slot;
        for (let variant = 0; variant < BIOME_VARIANTS; variant += 1) {
            // A few percent of tone between variants. On its own this is most
            // of what stops a region reading as one printed rectangle; the
            // marks on top are what make it read as ground.
            const jitter = 1 + (((variant % BIOME_VARIANTS) - ((BIOME_VARIANTS - 1) / 2)) * 0.045);
            paintSquare(scaleRgb(adjusted, jitter), painter, variant);
        }
    }

    // Shore variants: darken the base land colour by a small amount per
    // bitmask value so a coastline reads as a shore rather than a hard edge.
    const shoreBase = readTokenOnce(root, '--worldmap-biome-plains', '') || BIOME_COLORS.plains || '#7d9b5d';
    const shoreBaseRgb = adjustLightness(parseColor(shoreBase), BIOME_VALUE_SCALES.plains || 1);
    for (let mask = 0; mask < 16; mask += 1) {
        const oceanSides = popcount(mask);
        const darken = 1 - (oceanSides * 0.07);
        index[`shore:${mask}`] = slot;
        paintSquare(scaleRgb(shoreBaseRgb, darken), BIOME_TEXTURE.plains, mask % BIOME_VARIANTS);
    }

    return { atlas, index, cols, tile: ATLAS_TILE_PIXELS, variants: BIOME_VARIANTS };
}

/**
 * The source rectangle for one atlas slot. `variant` is ignored for keys that
 * have only one square (the shore masks), so callers can pass a cell's variant
 * unconditionally.
 */
function atlasRect(atlas, key, variant, variants) {
    const base = atlas.index[key];
    if (base === undefined) return null;
    const slot = base + (variants > 1 ? (variant % variants) : 0);
    return {
        sx: (slot % atlas.cols) * atlas.tile,
        sy: Math.floor(slot / atlas.cols) * atlas.tile,
        size: atlas.tile,
    };
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
    if (!ctx) return canvas;
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
            const isShore = mask >= 0;
            const slotKey = isShore ? `shore:${mask}` : cell.biome;
            const variant = cellTextureVariant(worldX, worldY);
            const rect = atlasRect(atlas, slotKey, variant, isShore ? 1 : atlas.variants)
                ?? atlasRect(atlas, cell.biome, variant, atlas.variants);
            const px = lx * cellPixelSize;
            const py = ly * cellPixelSize;
            const drawSize = Math.ceil(cellPixelSize) + 0.5;
            if (rect) {
                ctx.drawImage(
                    atlas.atlas,
                    rect.sx, rect.sy, rect.size, rect.size,
                    px, py, drawSize, drawSize,
                );
            }

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
                    // `hillshadeMultiplier` returns up to 1.28, so a lit slope
                    // used to paint `rgba(0,0,0,-0.28)` — an invalid colour
                    // string the canvas ignores. Half the relief was being
                    // thrown away: slopes could darken but never catch light.
                    ctx.fillStyle = shade < 1
                        ? `rgba(0,0,0,${clamp(1 - shade, 0, 1)})`
                        : `rgba(255,255,255,${clamp((shade - 1) * 0.7, 0, 1)})`;
                    ctx.fillRect(px, py, drawSize, drawSize);
                }
                // Contour lines. The band a cell sits in is compared with its
                // north and west neighbours, and the shared edge is inked when
                // they differ — which is what makes flat-looking country read
                // as country with a shape. The four neighbours are already
                // fetched for the hillshade, so this costs a comparison and at
                // most two thin rects.
                //
                // Skipped below `CONTOUR_MIN_CELL_PIXELS`: at the zoomed-out
                // level one tile covers 4096 cells and the lines would be
                // wider than the cells they separate.
                if (cellPixelSize >= CONTOUR_MIN_CELL_PIXELS) {
                    const band = Math.floor(cell.elevation / CONTOUR_INTERVAL);
                    const inkWidth = Math.max(1, cellPixelSize / 16);
                    ctx.fillStyle = 'rgba(0,0,0,0.16)';
                    if (north && Math.floor(north.elevation / CONTOUR_INTERVAL) !== band) {
                        ctx.fillRect(px, py, drawSize, inkWidth);
                    }
                    if (west && Math.floor(west.elevation / CONTOUR_INTERVAL) !== band) {
                        ctx.fillRect(px, py, inkWidth, drawSize);
                    }
                }

                // Beach blend near sea level.
                if (cell.elevation >= FIELD_SEA_LEVEL && cell.elevation < FIELD_SEA_LEVEL + BEACH_EPSILON) {
                    const sand = atlasRect(atlas, 'desert', variant, atlas.variants)
                        ?? atlasRect(atlas, 'plains', variant, atlas.variants);
                    const beachAmount = clamp(
                        1 - ((cell.elevation - FIELD_SEA_LEVEL) / BEACH_EPSILON),
                        0, 1,
                    ) * 0.5;
                    if (sand) {
                        ctx.globalAlpha = beachAmount;
                        ctx.drawImage(
                            atlas.atlas,
                            sand.sx, sand.sy, sand.size, sand.size,
                            px, py, drawSize, drawSize,
                        );
                        ctx.globalAlpha = 1;
                    }
                }
            } else {
                // Ocean depth ramp.
                const depth = clamp(
                    (FIELD_SEA_LEVEL - cell.elevation) / (FIELD_SEA_LEVEL - FIELD_MIN_ELEVATION),
                    0, 1,
                );
                if (depth > 0.01) {
                    ctx.fillStyle = `rgba(0,0,0,${clamp(depth * 0.35, 0, 0.45)})`;
                    ctx.fillRect(px, py, drawSize, drawSize);
                }
                // Shallow band lighten.
                const shallowDepth = SHALLOW_WATER_EPSILON / (FIELD_SEA_LEVEL - FIELD_MIN_ELEVATION);
                if (depth < shallowDepth && depth > 0) {
                    ctx.fillStyle = `rgba(255,255,255,${clamp(0.12 * (1 - depth / shallowDepth), 0, 0.12)})`;
                    ctx.fillRect(px, py, drawSize, drawSize);
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
 *     anchors: Array<{ locationId: string, name: string, x: number, y: number, source: string }>,
 *     transects: Array<object>,
 *     connections: Array<{ fromId: string, toId: string }>,
 *     settings: { worldSeed: string, climateGradient: number },
 *     hardened: Map<string, string>,
 *     locationId: string | null,
 *     worldVersion: number,
 *     chunkStore: object,
 *     controls: Array<object>,
 *   },
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
 *   onLayerChange?: (patch: { grid?: boolean, roads?: boolean, labels?: boolean }) => void,
 *   onContextAction?: (action: string, payload: object) => void,
 * }} options
 */
export function mountMapRenderer(root, options) {
    const {
        getSnapshot, log = () => undefined,
        getInitialView, onViewChange,
        onClickCell, onRouteAction, getRoutePreview, getTravelMode,
        travelModes, onLayerChange, onContextAction,
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
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'World map. Use arrow keys to pan, plus and minus to zoom, and zero to fit the map.');
    applyStyle(canvas, {
        position: 'absolute', inset: '0', width: '100%', height: '100%', display: 'block',
        outline: 'none',
    });
    canvas.addEventListener('focus', () => { canvas.style.boxShadow = 'inset 0 0 0 2px var(--color-terminal, #A78BFA)'; });
    canvas.addEventListener('blur', () => { canvas.style.boxShadow = ''; });
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

    const hoverReadout = makeElement('div', 'Hover a cell for terrain details', {
        position: 'absolute', top: '42px', left: '8px', padding: '4px 9px', borderRadius: '5px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.72))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.14))',
        color: 'var(--color-text-dim, inherit)',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'none', opacity: '0.9',
    });
    hoverReadout.dataset.worldmapHover = 'true';
    overlay.appendChild(hoverReadout);

    const loadingIndicator = makeElement('div', 'Loading terrain...', {
        position: 'absolute', top: '74px', left: '8px', padding: '4px 9px', borderRadius: '5px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.78))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.14))',
        color: 'var(--color-text-dim, inherit)',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
        pointerEvents: 'none', opacity: '0.9', display: 'none',
    });
    loadingIndicator.dataset.worldmapLoading = 'true';
    overlay.appendChild(loadingIndicator);
    let layerState = normaliseLayerSettings();

    const toolbar = makeElement('div', undefined, {
        position: 'absolute', top: '8px', right: '8px', padding: '5px',
        display: 'flex', gap: '4px', alignItems: 'center', flexWrap: 'wrap',
        maxWidth: '260px', justifyContent: 'flex-end',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.82))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        borderRadius: '5px', pointerEvents: 'auto',
    });
    const controlButton = (label, title, action) => {
        const button = makeElement('button', label, {
            minWidth: '28px', padding: '3px 7px',
            border: '1px solid var(--color-border, rgba(255,255,255,0.22))',
            borderRadius: '3px', background: 'transparent',
            color: 'inherit', font: 'inherit', fontSize: '11px', cursor: 'pointer',
        });
        button.type = 'button';
        button.title = title;
        button.setAttribute('aria-label', title);
        button.dataset.mapAction = action;
        button.addEventListener('click', () => {
            if (action === 'zoom-in') zoomBy(1.25);
            else if (action === 'zoom-out') zoomBy(0.8);
            else if (action === 'fit') centreOnAnchors();
            else if (action === 'centre') centreOnParty();
        });
        return button;
    };
    toolbar.append(
        controlButton('−', 'Zoom out', 'zoom-out'),
        controlButton('+', 'Zoom in', 'zoom-in'),
        controlButton('Fit', 'Fit map to content', 'fit'),
        controlButton('Centre', 'Centre on your party (C)', 'centre'),
    );
    overlay.appendChild(toolbar);

    const layerPanel = makeElement('div', undefined, {
        position: 'absolute', top: '50px', right: '8px', padding: '5px 7px',
        display: 'flex', gap: '7px', alignItems: 'center',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.82))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.18))',
        borderRadius: '5px', pointerEvents: 'auto',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
    });
    const layerInputs = new Map();
    const layerLabels = [
        ['grid', 'Grid'],
        ['roads', 'Roads'],
        ['labels', 'Labels'],
    ];
    for (const [key, label] of layerLabels) {
        const labelNode = makeElement('label', undefined, {
            display: 'inline-flex', gap: '3px', alignItems: 'center',
            cursor: 'pointer', userSelect: 'none',
        });
        const input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = layerState[key];
        input.dataset.layerToggle = key;
        input.setAttribute('aria-label', `${label} layer`);
        input.addEventListener('change', () => {
            layerState = { ...layerState, [key]: input.checked };
            if (onLayerChange) onLayerChange({ [key]: input.checked });
            scheduleRender();
        });
        labelNode.append(input, document.createTextNode(label));
        layerPanel.appendChild(labelNode);
        layerInputs.set(key, input);
    }
    overlay.appendChild(layerPanel);

    const scaleBar = makeElement('div', undefined, {
        position: 'absolute', right: '8px', bottom: '42px', padding: '4px 7px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.72))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.14))',
        borderRadius: '4px', pointerEvents: 'none', minWidth: '108px',
        font: '10px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
    });
    scaleBar.dataset.worldmapScale = 'true';
    const scaleLabel = makeElement('div', undefined, { textAlign: 'right', marginBottom: '2px' });
    const scaleLine = makeElement('div', undefined, {
        height: '5px', border: '1px solid currentColor', borderTop: '0',
        background: 'currentColor', opacity: '0.8',
    });
    scaleBar.append(scaleLabel, scaleLine);
    overlay.appendChild(scaleBar);

    const contextMenu = makeElement('div', undefined, {
        position: 'absolute', display: 'none', minWidth: '150px', padding: '4px',
        background: 'var(--color-void-lighter, rgba(20,21,25,0.96))',
        border: '1px solid var(--color-border, rgba(255,255,255,0.24))',
        borderRadius: '5px', boxShadow: '0 6px 18px rgba(0,0,0,0.35)',
        pointerEvents: 'auto', zIndex: '5',
        font: '11px/1.4 ui-monospace, SFMono-Regular, Consolas, monospace',
    });
    contextMenu.dataset.worldmapContextMenu = 'true';
    const contextTitle = makeElement('div', 'Cell', {
        padding: '4px 6px', color: 'var(--color-text-dim, inherit)',
        borderBottom: '1px solid var(--color-border, rgba(255,255,255,0.12))',
        marginBottom: '3px',
    });
    contextMenu.appendChild(contextTitle);
    for (const [action, label] of [
        ['travel', 'Travel here'],
        ['current', 'Set as current place'],
        ['details', 'Place details'],
    ]) {
        const button = makeElement('button', label, {
            display: 'block', width: '100%', padding: '5px 6px',
            border: '0', borderRadius: '3px', background: 'transparent',
            color: 'inherit', font: 'inherit', textAlign: 'left', cursor: 'pointer',
        });
        button.type = 'button';
        button.dataset.contextAction = action;
        button.addEventListener('click', () => {
            if (!contextMenu._contextPayload) return;
            const payload = contextMenu._contextPayload;
            contextMenu.style.display = 'none';
            if (onContextAction) onContextAction(action, payload);
        });
        contextMenu.appendChild(button);
    }
    overlay.appendChild(contextMenu);
    const help = makeElement('div', 'Scroll to zoom · Drag to pan · Click a cell to travel', {
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

    // WO 6.3 §1 — the offer. When the click target has no ledger path, the
    // refusal becomes an offer: a band selector (defaulted to the band whose
    // grid range best matches the straight-line distance between the two
    // anchors) and a "Create and travel" button. The player commits the
    // connection; the map only proposes it. Hidden unless the preview is a
    // `no-ledger-path` block.
    const offerRow = makeElement('div', undefined, {
        display: 'none', flexDirection: 'column', gap: '4px',
        paddingTop: '2px', borderTop: '1px solid var(--color-border, rgba(255,255,255,0.18))',
    });
    const offerLabel = makeElement('div', 'Create one?', {
        fontSize: '10px', opacity: '0.85', textTransform: 'uppercase', letterSpacing: '0.04em',
    });
    const offerBandRow = makeElement('div', undefined, { display: 'flex', alignItems: 'center', gap: '4px' });
    const offerBandSelect = document.createElement('select');
    offerBandSelect.setAttribute('aria-label', 'Distance band for the new connection');
    applyStyle(offerBandSelect, {
        background: 'var(--color-void, #0e0f12)', color: 'inherit',
        border: '1px solid var(--color-border, rgba(255,255,255,0.22))',
        borderRadius: '3px', padding: '2px 4px', font: 'inherit', fontSize: '10px', flex: '1',
    });
    // Mirror the host's `DISTANCE_BANDS` minus `adjacent` — a connection
    // always covers ground, so `adjacent` is not offered. The labels are
    // the host's, kept in sync by the contract test (WO 6.3 §5).
    const OFFER_BANDS = [
        { id: 'nearby', label: 'nearby — 1–2 grids' },
        { id: 'local', label: 'local — 3–6 grids' },
        { id: 'regional', label: 'regional — 7–15 grids' },
        { id: 'far', label: 'far — 16–30 grids' },
        { id: 'distant', label: 'distant — 31–60 grids' },
        { id: 'remote', label: 'remote — 61–120 grids' },
        { id: 'farthest', label: 'farthest — 121+ grids' },
    ];
    for (const band of OFFER_BANDS) {
        const opt = document.createElement('option');
        opt.value = band.id;
        opt.textContent = band.label;
        offerBandSelect.appendChild(opt);
    }
    offerBandRow.appendChild(offerBandSelect);
    const offerAcceptButton = makeElement('button', 'Create and travel', {
        padding: '3px 8px',
        border: '1px solid var(--color-command-accent, #E01B1B)',
        borderRadius: '3px', background: 'transparent',
        color: 'var(--color-command-accent, #E01B1B)',
        font: 'inherit', fontSize: '10px', cursor: 'pointer', alignSelf: 'flex-start',
    });
    offerAcceptButton.addEventListener('click', () => {
        if (onRouteAction) onRouteAction('createConnection', { band: offerBandSelect.value });
    });
    offerRow.append(offerLabel, offerBandRow, offerAcceptButton);
    routePanel.appendChild(offerRow);

    // The commit is a BUTTON, not a second click on the same cell.
    //
    // Click-to-travel used to be a two-phase gesture: click a cell to preview,
    // click the same cell again to depart. That overloads one gesture with two
    // meanings, makes departure depend on hitting the same cell twice, and
    // turns any pointer twitch in between into a cancelled journey. A click
    // now always means "show me the route"; travelling is its own control,
    // beside the connect-on-demand offer that already worked this way.
    const routeActionRow = makeElement('div', undefined, {
        display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap',
        alignSelf: 'flex-start',
    });
    const routeTravelButton = makeElement('button', 'Travel', {
        padding: '3px 10px', border: '1px solid var(--color-terminal-dim, #5B21B6)',
        borderRadius: '3px', background: 'transparent',
        color: 'var(--color-terminal-dim, #5B21B6)',
        font: 'inherit', fontSize: '10px', fontWeight: '600', cursor: 'pointer',
    });
    // The panel has two states and reuses one pair of buttons, so the action
    // each button dispatches depends on which state is showing. Planning:
    // Travel / Cancel route. Travelling: Continue / Abandon. Tracked here
    // rather than read off the button's own label, because a label is a
    // rendering of the state and not the state itself.
    let panelMode = 'plan';
    routeTravelButton.addEventListener('click', () => {
        if (!onRouteAction) return;
        onRouteAction(panelMode === 'journey' ? 'continue' : 'commit');
    });
    const routeCancelButton = makeElement('button', 'Cancel route', {
        padding: '3px 8px', border: '1px solid var(--color-border, rgba(255,255,255,0.22))',
        borderRadius: '3px', background: 'transparent', color: 'inherit',
        font: 'inherit', fontSize: '10px', cursor: 'pointer',
    });
    routeCancelButton.addEventListener('click', () => {
        if (!onRouteAction) return;
        onRouteAction(panelMode === 'journey' ? 'abandon' : 'cancel');
    });
    routeActionRow.append(routeTravelButton, routeCancelButton);
    routePanel.appendChild(routeActionRow);

    const view = { cx: FIELD_WORLD_SIZE / 2, cy: FIELD_WORLD_SIZE / 2, cellPixels: ZOOM_LEVELS[1].cellPixels };

    // Cached bounding rect — refreshed from the ResizeObserver and on scroll,
    // never recomputed inside `worldToScreen`/`screenToWorld` which are called
    // in loops (§7). `getBoundingClientRect()` forces a layout each call.
    let cachedRect = null;
    function refreshRect() {
        cachedRect = root.getBoundingClientRect();
    }

    let panLast = null;
    let resizeObserver = null;
    let rafHandle = 0;
    let disposed = false;

    // WO 6.1 §1 — click-to-travel state. A click (no pan) is a two-phase
    // gesture: first click previews the route, second click on the same cell
    // commits. A click elsewhere re-routes. The previewed cell is tracked so
    // the second click can be matched. The renderer reports the click to the
    // host via `onClickCell`; the host computes the route (the pathfinder
    // lives in the mod) and surfaces it back through `getRoutePreview`.
    // Commit/cancel/mode-change go through `onRouteAction`.
    let panStarted = false;     // true if the current gesture moved enough to be a pan

    // Tile pyramid + atlas. The pyramid is dropped wholesale on a world
    // version change; the atlas is rebuilt only when the theme changes.
    let pyramid = new TilePyramid();
    let atlas = null;
    let atlasWorldVersion = -1;
    let paintedWorldVersion = -1;
    let rasterCount = 0;
    let pendingTiles = new Map();
    let pendingFlushTimer = 0;
    let hoverCell = null;
    let contextCell = null;
    // WO 5.5 §1 / §2 — the party marker's pulse phase (advanced once per
    // paint, frozen under `prefers-reduced-motion`) and the last-computed
    // party screen position + on-screen flag, read by the off-screen edge
    // indicator's hit test.
    let partyPulsePhase = 0;
    let partyScreen = null;
    let partyOnScreen = true;
    let partyIndicatorPos = null;
    // The pulse is a slow cycle (~2s). A `setInterval` advances the phase and
    // schedules a repaint, so the halo breathes even when the map is idle.
    // `requestAnimationFrame` would loop synchronously under the test stub
    // (which fires RAF inline) and never yield; the interval is async.
    let pulseInterval = 0;

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
    // A cell is a BOX. Cell (x, y) spans the grid lines at x..x+1 and
    // y..y+1, which is exactly how the terrain tiles are blitted — so a place
    // "at" (496, 500) belongs in the middle of that box, not on the corner
    // where four cells meet. Everything that sits ON the map (places, roads,
    // the route line, the hit test) goes through this; the grid lines and the
    // terrain keep using `cellToScreen` directly, because a grid line really
    // does belong on the boundary.
    function cellCentreToScreen(x, y) {
        return cellToScreen(x + 0.5, y + 0.5);
    }

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
            const screen = cellCentreToScreen(anchor.x, anchor.y);
            const d = Math.hypot(screen.x - px, screen.y - py);
            if (d <= bestDistance) { bestDistance = d; best = anchor; }
        }
        return best;
    }

    function anchorAtCell(x, y) {
        const snapshot = getSnapshot();
        if (!snapshot || !Array.isArray(snapshot.anchors)) return null;
        let best = null;
        let bestDistance = 3;
        for (const anchor of snapshot.anchors) {
            const distance = Math.max(Math.abs(anchor.x - x), Math.abs(anchor.y - y));
            if (distance <= 2 && distance < bestDistance) {
                best = anchor;
                bestDistance = distance;
            }
        }
        return best;
    }

    function updateHover(px, py) {
        const snapshot = getSnapshot();
        const world = screenToCell(px, py);
        const x = Math.floor(world.x);
        const y = Math.floor(world.y);
        if (!snapshot || !snapshot.chunkStore
            || x < 0 || y < 0 || x >= FIELD_WORLD_SIZE || y >= FIELD_WORLD_SIZE) {
            hoverCell = null;
            hoverReadout.textContent = 'Hover a cell for terrain details';
            return;
        }
        const cell = snapshot.chunkStore.getCell(x, y);
        hoverCell = { x, y, biome: cell.biome, elevation: cell.elevation };
        hoverReadout.textContent = `cell ${x},${y} · ${cell.biome} · elevation ${cell.elevation.toFixed(2)}`;
    }

    function showContextMenu(event) {
        event.preventDefault();
        refreshRect();
        const rect = cachedRect;
        if (!rect) return;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const world = screenToCell(px, py);
        const cell = {
            x: clamp(Math.floor(world.x), 0, FIELD_WORLD_SIZE - 1),
            y: clamp(Math.floor(world.y), 0, FIELD_WORLD_SIZE - 1),
        };
        const anchor = anchorAtCell(cell.x, cell.y);
        const payload = {
            x: cell.x, y: cell.y, cell,
            locationId: anchor?.locationId ?? null,
            anchor: anchor ? { ...anchor } : null,
        };
        contextCell = cell;
        contextMenu._contextPayload = payload;
        contextTitle.textContent = anchor
            ? `cell ${cell.x},${cell.y} · ${anchor.name || anchor.locationId}`
            : `cell ${cell.x},${cell.y}`;
        const buttons = contextMenu.querySelectorAll('[data-context-action]');
        for (const button of buttons) {
            const action = button.dataset.contextAction;
            const enabled = Boolean(anchor);
            button.disabled = !enabled;
            button.style.opacity = enabled ? '1' : '0.45';
            button.style.cursor = enabled ? 'pointer' : 'not-allowed';
        }
        const menuWidth = 170;
        const menuHeight = 150;
        contextMenu.style.left = `${clamp(px, 4, Math.max(4, rect.width - menuWidth))}px`;
        contextMenu.style.top = `${clamp(py, 4, Math.max(4, rect.height - menuHeight))}px`;
        contextMenu.style.display = 'block';
    }

    function clampView() {
        const margin = 10;
        view.cx = Math.max(-margin, Math.min(FIELD_WORLD_SIZE + margin, view.cx));
        view.cy = Math.max(-margin, Math.min(FIELD_WORLD_SIZE + margin, view.cy));
        // Every pan, zoom, key and centring lands here, so this is the one
        // place the camera has to be reported from.
        if (typeof onViewChange === 'function') {
            onViewChange({ cx: view.cx, cy: view.cy, cellPixels: view.cellPixels });
        }
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
        const nextLayers = normaliseLayerSettings(snapshot.settings);
        layerState = nextLayers;
        for (const [key, input] of layerInputs) {
            if (document.activeElement !== input) input.checked = nextLayers[key];
        }

        ctx.fillStyle = readTokenOnce(root, '--color-void-darker', '#0e0f12');
        ctx.fillRect(0, 0, width, height);

        drawTiles(snapshot, currentAtlas, width, height, cell);
        drawGridOverlay(width, height, cell);
        drawConnections(snapshot, cell);
        // WO 6.2 — the committed journey draws behind the preview. The two
        // are mutually exclusive, and are now enforced to be:
        // `computeRoutePreview` refuses while `context.travel` is set, and the
        // mod clears any standing preview on departure. This comment used to
        // say "in practice", which was another way of saying nobody checked.
        // The journey survives a repaint (it is backed by the `journey`
        // table, not the ephemeral preview) — a solve, a ledger change or
        // a tab switch leaves it on screen (§3).
        drawJourney(snapshot, cell);
        drawRoutePreview(cell);
        drawAnchors(snapshot, cell);
        // WO 5.5 §2 — the off-screen indicator draws AFTER the party marker so
        // it sits on top of the terrain and roads, and only when the party is
        // off-screen. `drawAnchors` sets `partyOnScreen` / `partyScreen`.
        drawPartyIndicator(width, height, cell);
        drawHud(snapshot, cell);
        updateRoutePanel(snapshot);

        // WO 5.5 §1 — keep the pulse alive. The halo's slow cycle is a
        // continuous animation, so the phase must advance even when the map
        // is idle. A `setInterval` (~50ms, ~20fps) advances the phase and
        // schedules a repaint. Under `prefers-reduced-motion` the phase does
        // not advance and no interval is scheduled (§7). The interval is
        // started/stopped here so it tracks the party's presence: no pulse
        // when there is no party marker to draw.
        if (prefersReducedMotion() || !partyScreen) {
            if (pulseInterval) { clearInterval(pulseInterval); pulseInterval = 0; }
        } else if (!pulseInterval) {
            pulseInterval = setInterval(() => {
                if (disposed) { clearInterval(pulseInterval); pulseInterval = 0; return; }
                partyPulsePhase = (partyPulsePhase + 50) % PARTY_PULSE_PERIOD_MS;
                scheduleRender();
            }, 50);
        }

        refreshTokenCache(root);
    }

    function updateLoadingIndicator() {
        loadingIndicator.style.display = pendingTiles.size > 0 ? 'block' : 'none';
    }

    function fallbackTile(levelIdx, tileX, tileY) {
        for (let fallbackLevel = levelIdx - 1; fallbackLevel >= 0; fallbackLevel -= 1) {
            const factor = 2 ** (levelIdx - fallbackLevel);
            const parentX = Math.floor(tileX / factor);
            const parentY = Math.floor(tileY / factor);
            const tile = pyramid.get(fallbackLevel, parentX, parentY);
            if (!tile) continue;
            const sourceSize = TILE_PIXELS / factor;
            return {
                tile,
                sx: (tileX - (parentX * factor)) * sourceSize,
                sy: (tileY - (parentY * factor)) * sourceSize,
                sw: sourceSize,
                sh: sourceSize,
            };
        }
        return null;
    }

    function schedulePendingTiles() {
        if (pendingFlushTimer || pendingTiles.size === 0) return;
        pendingFlushTimer = requestAnimationFrame(() => {
            pendingFlushTimer = 0;
            if (disposed) return;
            const [key, request] = pendingTiles.entries().next().value || [];
            if (!request) return;
            pendingTiles.delete(key);
            const snapshot = getSnapshot();
            if (snapshot && snapshot.worldVersion === request.worldVersion) {
                rasteriseTile(pyramid, request.level, request.tileX, request.tileY, snapshot, atlas, cachedRect);
                rasterCount += 1;
            }
            updateLoadingIndicator();
            scheduleRender();
            schedulePendingTiles();
        });
    }

    function queueTile(level, tileX, tileY, snapshot, currentAtlas) {
        const key = TilePyramid.key(level, tileX, tileY);
        if (pendingTiles.has(key) || pyramid.get(level, tileX, tileY)) return;
        pendingTiles.set(key, {
            level, tileX, tileY, worldVersion: snapshot.worldVersion,
            atlas: currentAtlas,
        });
        updateLoadingIndicator();
        schedulePendingTiles();
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
                let fallback = null;
                if (!tile) {
                    fallback = fallbackTile(levelIdx, tx, ty);
                    queueTile(level.level, tx, ty, snapshot, currentAtlas);
                    // Seed the fallback pyramid synchronously when a level is
                    // first visited. Subsequent tiles can use the cached
                    // parent while the requested level renders in the queue.
                    if (!fallback && levelIdx > 0) {
                        const parentFactor = 2;
                        const parentLevel = levelIdx - 1;
                        const parentX = Math.floor(tx / parentFactor);
                        const parentY = Math.floor(ty / parentFactor);
                        if (!pyramid.get(parentLevel, parentX, parentY)) {
                            rasteriseTile(pyramid, parentLevel, parentX, parentY, snapshot, currentAtlas, cachedRect);
                            rasterCount += 1;
                        }
                        fallback = fallbackTile(levelIdx, tx, ty);
                    }
                    // At the coarsest level there is no fallback. Rasterise one
                    // tile synchronously so the map never presents blank ground.
                    if (!fallback && levelIdx === 0) {
                        tile = rasteriseTile(pyramid, level.level, tx, ty, snapshot, currentAtlas, cachedRect);
                        pendingTiles.delete(TilePyramid.key(level.level, tx, ty));
                        rasterCount += 1;
                    }
                }
                const screenX = ((tx * cellsPerTile - view.cx) * cellPixelSize) + (width / 2);
                const screenY = ((ty * cellsPerTile - view.cy) * cellPixelSize) + (height / 2);
                const drawW = cellsPerTile * cellPixelSize;
                const drawH = cellsPerTile * cellPixelSize;
                ctx.imageSmoothingEnabled = false;
                if (tile) {
                    ctx.drawImage(tile, screenX, screenY, drawW, drawH);
                } else if (fallback) {
                    ctx.drawImage(
                        fallback.tile,
                        fallback.sx, fallback.sy, fallback.sw, fallback.sh,
                        screenX, screenY, drawW, drawH,
                    );
                }
            }
        }
        updateLoadingIndicator();
    }

    function drawGridOverlay(width, height, cell) {
        if (!layerState.grid) return;
        // One drawn box == one world cell. The test is which side of the
        // threshold we are on: hide the grid when cells are too small to be
        // distinguishable (a mesh of lines), show it when they are not. This
        // was inverted, so the per-cell grid only appeared when zoomed out and
        // was absent at every usable zoom.
        if (cell < GRID_FADE_BELOW_CELL_PIXELS) return;
        const alpha = clamp((cell - GRID_FADE_BELOW_CELL_PIXELS) / 4, 0, 1) * 0.28;
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
        if (!layerState.roads || !snapshot.connections || cell < LABEL_MIN_CELL_PIXELS) return;
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
        // The road emphasis was WO 4.2 §3, written before the journey line
        // existed — back when highlighting the road was the only way to show
        // "you are on this road". `drawJourney` now draws the pathfound route
        // in the SAME token, so both ran at once: the road as a straight chord
        // through the transit waypoint, the journey as a terrain staircase.
        // Two purple lines a few pixels apart, which reads as two journeys.
        //
        // The journey line says it better and says it truthfully, so when one
        // is drawable the emphasis stands down. It stays for the degrade path
        // (a Places-panel or composer departure carries no route geometry),
        // where the road really is the only thing that can show the journey.
        if (currentPlaceId && !journeyIsDrawable(snapshot)) {
            for (const [key, list] of waypointsByEdge) {
                if (list.some(waypoint => waypoint.locationId === currentPlaceId)) {
                    emphasisedEdges.add(key);
                }
            }
        }
        const baseWidth = Math.max(1, cell / 6);
        const baseStroke = readTokenOnce(root, '--color-border', 'rgba(220,220,220,0.55)');
        // WO 5.5 §4 — the road emphasis uses `--color-terminal-dim`, not the
        // reserved party colour. "You" and "the road you are on" are no longer
        // the same colour.
        const emphasisStroke = readTokenOnce(root, '--color-terminal-dim', '#5B21B6');
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
            const fromScreen = cellCentreToScreen(from.x, from.y);
            const toScreen = cellCentreToScreen(to.x, to.y);
            const intermediates = waypointsForEdge(connection.fromId, connection.toId, waypointsByEdge)
                .map(waypoint => {
                    const anchor = byId.get(waypoint.locationId);
                    return anchor ? cellCentreToScreen(anchor.x, anchor.y) : null;
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

    /**
     * WO 5.5 §1 — draw the party marker as a teardrop map pin, sized in
     * SCREEN pixels (not cell pixels) so it cannot be mistaken for a place
     * at any zoom. The tip sits on the anchor cell; the body rises above it.
     * The tip is the truth. Drawn last, over everything, never occluded.
     * A reserved colour (`--color-terminal` — nothing else on the map may
     * use it) and a two-ring halo, the outer one pulsing on a ~2s cycle.
     * Under `prefers-reduced-motion` the rings draw static (§1 / §7).
     */
    function drawPartyPin(screen, color, groundColor) {
        const reduced = prefersReducedMotion();
        // The pulse phase is advanced by the interval in `paint()`, not here
        // (so it advances at a steady rate independent of paint frequency).
        // Under `prefers-reduced-motion` the phase does not advance (§7).
        const phase = partyPulsePhase / PARTY_PULSE_PERIOD_MS;
        // Pulse: a sinusoidal alpha between ~0.35 and ~0.9.
        const pulseAlpha = reduced ? 0.55 : (0.35 + 0.55 * (0.5 + 0.5 * Math.sin(phase * Math.PI * 2)));

        ctx.save();
        // Halo — two concentric rings outside the pin. The outer ring pulses;
        // the inner ring is static. Cheap: two `arc` calls.
        ctx.strokeStyle = color;
        ctx.lineWidth = 2;
        ctx.globalAlpha = reduced ? 0.5 : 0.75;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - PARTY_PIN_HEIGHT_PX / 2, PARTY_HALLO_INNER_PX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = pulseAlpha;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        ctx.arc(screen.x, screen.y - PARTY_PIN_HEIGHT_PX / 2, PARTY_HALLO_OUTER_PX, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;

        // Teardrop body. The tip is at `screen` (the anchor cell); the body
        // rises above it. Built from an arc (the round top) and two lines
        // converging to the tip — the universal "this location" silhouette.
        const bodyCx = screen.x;
        const bodyCy = screen.y - PARTY_PIN_HEIGHT_PX + PARTY_PIN_WIDTH_PX / 2;
        const r = PARTY_PIN_WIDTH_PX / 2;
        ctx.fillStyle = color;
        ctx.strokeStyle = groundColor;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        // Start at the tip, go up the left side, arc the top, down the right.
        ctx.moveTo(screen.x, screen.y);
        ctx.lineTo(bodyCx - r, bodyCy);
        ctx.arc(bodyCx, bodyCy, r, Math.PI, 0, false);
        ctx.lineTo(screen.x, screen.y);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Inner highlight — a small white-ish dot near the top of the body.
        ctx.fillStyle = 'rgba(255,255,255,0.85)';
        ctx.beginPath();
        ctx.arc(bodyCx, bodyCy - r * 0.25, r * 0.28, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }

    function drawAnchors(snapshot, cell) {
        const currentColor = readTokenOnce(root, '--color-terminal', '#A78BFA');
        const idleColor = readTokenOnce(root, '--color-ice', '#E8EAED');
        const strokeColor = readTokenOnce(root, '--color-void-darker', '#0e0f12');
        const textColor = readTokenOnce(root, '--color-text-primary', '#E8EAED');
        const currentPlaceId = snapshot.locationId ?? null;
        let currentAnchorEntry = null;
        // First pass: every anchor except the current one.
        for (const anchor of snapshot.anchors || []) {
            if (anchor.locationId === currentPlaceId) {
                currentAnchorEntry = anchor;
                continue;
            }
            const screen = cellCentreToScreen(anchor.x, anchor.y);
            const radius = Math.max(5, cell / 2.4);
            const fill = idleColor;
            drawAnchorDot(anchor, screen, radius, fill, strokeColor);
            if (layerState.labels && cell >= LABEL_MIN_CELL_PIXELS) {
                drawAnchorLabel(screen, radius, anchor.name || anchor.locationId, textColor);
            }
        }
        // WO 5.5 §1 — the party marker is a different kind of object, not an
        // anchor with emphasis. A teardrop map pin sized in screen pixels,
        // drawn LAST so nothing overlaps it. Its label always renders, even
        // below LABEL_MIN_CELL_PIXELS where other labels are suppressed — the
        // shape already says "you", so the label is the place name (no "You
        // are here" text).
        //
        // WO 6.2 §3 — during a journey, the party marker sits on
        // `snapshot.party` (today's checkpoint cell), NOT the current place's
        // anchor (which during a journey is the transit node — one fixed dot
        // per road). The label still names the current place (the transit
        // node, e.g. "Road between A and B") so the HUD and the marker agree
        // on what the header says.
        if (currentAnchorEntry) {
            const partyCell = snapshot.party;
            const usePartyCell = Boolean(partyCell)
                && Number.isFinite(partyCell.x) && Number.isFinite(partyCell.y);
            const ax = usePartyCell ? partyCell.x : currentAnchorEntry.x;
            const ay = usePartyCell ? partyCell.y : currentAnchorEntry.y;
            const screen = cellCentreToScreen(ax, ay);
            // Record the party's screen position + on-screen flag for the
            // off-screen edge indicator (§2) and its hit test.
            partyScreen = { x: screen.x, y: screen.y };
            const rect = cachedRect;
            partyOnScreen = Boolean(rect)
                && screen.x >= -PARTY_PIN_WIDTH_PX
                && screen.x <= rect.width + PARTY_PIN_WIDTH_PX
                && screen.y >= -PARTY_PIN_HEIGHT_PX
                && screen.y <= rect.height + PARTY_PIN_TAIL_PX;
            drawPartyPin(screen, currentColor, strokeColor);
            // Label offset: clear the pin body (which rises above the tip).
            const labelRadius = PARTY_PIN_WIDTH_PX / 2 + 4;
            if (layerState.labels) {
                drawAnchorLabel(screen, labelRadius, currentAnchorEntry.name || currentAnchorEntry.locationId, textColor);
            }
        } else {
            partyScreen = null;
            partyOnScreen = true;
        }
    }

    /**
     * WO 5.5 §2 — the off-screen indicator. When the party's cell is outside
     * the viewport, draw an arrow clamped to the viewport edge, pointing at
     * it, in the party colour, with the distance in grids beside it. Clicking
     * the arrow centres the camera on the party. A marker you cannot see is
     * not a marker — this is what actually delivers "scream your character is
     * here".
     *
     * Records the indicator's screen position in `partyIndicatorPos` so the
     * pointer-up hit test (§2) can detect a click on the arrow.
     */
    function drawPartyIndicator(width, height, cell) {
        partyIndicatorPos = null;
        if (!partyScreen || partyOnScreen) return;
        const color = readTokenOnce(root, '--color-terminal', '#A78BFA');
        const textColor = readTokenOnce(root, '--color-text-primary', '#E8EAED');
        const groundColor = readTokenOnce(root, '--color-void-darker', '#0e0f12');
        // Direction from viewport centre to the party, normalised.
        const cx = width / 2;
        const cy = height / 2;
        const dx = partyScreen.x - cx;
        const dy = partyScreen.y - cy;
        const len = Math.hypot(dx, dy) || 1;
        const ux = dx / len;
        const uy = dy / len;
        // Clamp the arrow to the viewport edge with a margin so it is not
        // cut off by the viewport border.
        const margin = PARTY_INDICATOR_RADIUS_PX + 6;
        // Intersect the ray from the centre with the viewport rectangle.
        // Scale so the arrow sits on the nearer edge.
        const halfW = (width / 2) - margin;
        const halfH = (height / 2) - margin;
        const sx = ux !== 0 ? halfW / Math.abs(ux) : Infinity;
        const sy = uy !== 0 ? halfH / Math.abs(uy) : Infinity;
        const scale = Math.min(sx, sy);
        const ax = cx + (ux * scale);
        const ay = cy + (uy * scale);
        partyIndicatorPos = { x: ax, y: ay };
        // Distance in grids (Manhattan, the travel currency).
        const grids = Math.max(1, Math.round((Math.abs(dx) + Math.abs(dy)) / cell));

        ctx.save();
        // A small disc so the arrow reads against any terrain.
        ctx.fillStyle = groundColor;
        ctx.globalAlpha = 0.78;
        ctx.beginPath();
        ctx.arc(ax, ay, PARTY_INDICATOR_RADIUS_PX + 2, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        // The arrow — a triangle pointing along (ux, uy).
        const r = PARTY_INDICATOR_RADIUS_PX;
        const angle = Math.atan2(uy, ux);
        const tipX = ax + (Math.cos(angle) * r);
        const tipY = ay + (Math.sin(angle) * r);
        const baseAngle = angle + Math.PI;
        const leftX = ax + (Math.cos(baseAngle - 0.5) * r * 0.7);
        const leftY = ay + (Math.sin(baseAngle - 0.5) * r * 0.7);
        const rightX = ax + (Math.cos(baseAngle + 0.5) * r * 0.7);
        const rightY = ay + (Math.sin(baseAngle + 0.5) * r * 0.7);
        ctx.fillStyle = color;
        ctx.strokeStyle = color;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(tipX, tipY);
        ctx.lineTo(leftX, leftY);
        ctx.lineTo(rightX, rightY);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        // Distance label beside the arrow.
        ctx.font = '10px ui-monospace, SFMono-Regular, Consolas, monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const labelOffset = PARTY_INDICATOR_RADIUS_PX + 10;
        const lx = ax + (Math.cos(angle) * labelOffset);
        const ly = ay + (Math.sin(angle) * labelOffset);
        const label = `${grids} grid${grids === 1 ? '' : 's'}`;
        const metrics = ctx.measureText(label);
        ctx.fillStyle = 'rgba(0,0,0,0.6)';
        ctx.fillRect(lx - (metrics.width / 2) - 3, ly - 8, metrics.width + 6, 16);
        ctx.fillStyle = textColor;
        ctx.fillText(label, lx, ly);
        ctx.restore();
    }

    // WO 6.2 §3 — draw the committed journey. The walked leg of the polyline
    // renders behind the remaining leg — dimmer, and reading as *done*. The
    // remaining leg keeps the route-preview treatment. Passed checkpoints are
    // filled; future ones stay hollow. The day numbers stay on both. The
    // party marker itself is drawn by `drawAnchors` (it sits on
    // `snapshot.party`, the cell for today's leg).
    //
    // The journey survives a repaint (it is backed by the `journey` table),
    // unlike a preview which is cleared on commit. A solve, a ledger change
    // or a tab switch must leave the journey on screen (§3).
    function drawJourney(snapshot, cell) {
        if (!journeyIsDrawable(snapshot)) return;
        const journey = snapshot.journey;
        const leg = snapshot.journeyLeg;

        const cells = journey.cells;
        const checkpoints = Array.isArray(journey.checkpoints) ? journey.checkpoints : [];

        // The walked leg covers cells from the origin up to and including the
        // party's current cell. Leg 1 is the origin (cells[0]); leg L (L ≥ 2)
        // is checkpoint L-2. The split index is the cell index of the current
        // checkpoint (or 0 for leg 1). The walked polyline is cells[0..split],
        // the remaining is cells[split..end].
        //
        // The split is by CHECKPOINT cell, which may not be an exact cell in
        // the `cells` array (checkpoints are placed on terrain-cost
        // boundaries). Find the cell in `cells` closest to the current
        // checkpoint's coordinates. This is a visual approximation — the
        // exact leg boundary is the host's `leg`, not the cell index.
        let splitIndex = 0;
        if (leg <= 1) {
            splitIndex = 0;
        } else {
            const cpIndex = leg - 2;
            const cp = cpIndex < checkpoints.length ? checkpoints[cpIndex] : checkpoints[checkpoints.length - 1];
            if (cp) {
                // Find the cell in `cells` closest to the checkpoint.
                let bestDist = Infinity;
                let bestIdx = cells.length - 1;
                for (let i = 0; i < cells.length; i += 1) {
                    const d = Math.abs(cells[i].x - cp.x) + Math.abs(cells[i].y - cp.y);
                    if (d < bestDist) { bestDist = d; bestIdx = i; }
                }
                splitIndex = bestIdx;
            } else {
                splitIndex = cells.length - 1;
            }
        }

        // WO 5.5 §4 — the journey stroke uses `--color-terminal-dim`, not
        // the reserved party colour. The party is the loudest thing on the
        // map; the journey is a route, not "you".
        const journeyStroke = readTokenOnce(root, '--color-terminal-dim', '#5B21B6');
        const walkedStroke = readTokenOnce(root, '--color-ice', '#E8EAED');
        const groundColor = readTokenOnce(root, '--color-void-darker', '#0e0f12');
        const labelColor = readTokenOnce(root, '--color-text-primary', '#E8EAED');

        ctx.save();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';

        // Walked leg — dimmer, reading as *done*. Lower alpha and thinner
        // stroke than the remaining leg.
        if (splitIndex > 0) {
            ctx.lineWidth = Math.max(1, cell / 5);
            ctx.strokeStyle = walkedStroke;
            ctx.globalAlpha = 0.4;
            ctx.beginPath();
            const first = cellCentreToScreen(cells[0].x, cells[0].y);
            ctx.moveTo(first.x, first.y);
            for (let i = 1; i <= splitIndex && i < cells.length; i += 1) {
                const s = cellCentreToScreen(cells[i].x, cells[i].y);
                ctx.lineTo(s.x, s.y);
            }
            ctx.stroke();
        }

        // Remaining leg — the route-preview treatment (bright, full alpha).
        if (splitIndex < cells.length - 1) {
            ctx.lineWidth = Math.max(1.5, cell / 4);
            ctx.strokeStyle = journeyStroke;
            ctx.globalAlpha = 0.85;
            ctx.beginPath();
            const start = cellCentreToScreen(cells[splitIndex].x, cells[splitIndex].y);
            ctx.moveTo(start.x, start.y);
            for (let i = splitIndex + 1; i < cells.length; i += 1) {
                const s = cellCentreToScreen(cells[i].x, cells[i].y);
                ctx.lineTo(s.x, s.y);
            }
            ctx.stroke();
        }

        // Checkpoints — passed ones are filled; future ones stay hollow.
        // The day numbers stay on both (§3).
        ctx.globalAlpha = 1;
        const radius = Math.max(3, cell / 4.5);
        for (const checkpoint of checkpoints) {
            const screen = cellCentreToScreen(checkpoint.x, checkpoint.y);
            // A checkpoint is "passed" when its day < the current leg's day.
            // Leg 1 = day 0 (origin, no day passed). Leg L ≥ 2 = day L-1
            // (the day that just ended). So a checkpoint on day D is passed
            // when D < leg. Actually: checkpoint.day is the day the camp ends
            // (1-based), and leg L means L-1 days have passed. A checkpoint
            // on day D is passed when D <= leg - 1, i.e. D < leg.
            const passed = checkpoint.day < leg;
            ctx.beginPath();
            ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
            if (passed) {
                ctx.fillStyle = journeyStroke;
                ctx.fill();
            } else {
                ctx.fillStyle = groundColor;
                ctx.fill();
            }
            ctx.strokeStyle = journeyStroke;
            ctx.lineWidth = checkpoint.kind === 'place' ? 2.5 : 1.5;
            ctx.stroke();
            if (cell >= LABEL_MIN_CELL_PIXELS) {
                ctx.font = `${Math.max(9, Math.round(cell / 2.4))}px ui-monospace, SFMono-Regular, Consolas, monospace`;
                ctx.textAlign = 'center';
                ctx.textBaseline = 'bottom';
                ctx.fillStyle = groundColor;
                ctx.lineWidth = 3;
                ctx.strokeStyle = groundColor;
                ctx.strokeText(String(checkpoint.day), screen.x, screen.y - radius - 2);
                ctx.fillStyle = labelColor;
                ctx.fillText(String(checkpoint.day), screen.x, screen.y - radius - 2);
            }
        }

        // Destination ring — same as the preview, so the click target reads.
        if (cells.length > 0) {
            const end = cells[cells.length - 1];
            const endScreen = cellCentreToScreen(end.x, end.y);
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(endScreen.x, endScreen.y, Math.max(6, cell / 1.8), 0, Math.PI * 2);
            ctx.strokeStyle = journeyStroke;
            ctx.lineWidth = 2;
            ctx.stroke();
        }

        ctx.restore();
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
        // WO 5.5 §4 — the route preview uses `--color-terminal-dim`, not the
        // reserved party colour. "You" and "the road you are considering" are
        // no longer the same colour.
        const previewStroke = readTokenOnce(root, '--color-terminal-dim', '#5B21B6');
        const blockedStroke = readTokenOnce(root, '--color-command-accent', '#E01B1B');
        const isBlocked = Boolean(preview.blocked);
        ctx.save();
        ctx.lineWidth = Math.max(1.5, cell / 4);
        ctx.strokeStyle = isBlocked ? blockedStroke : previewStroke;
        ctx.globalAlpha = 0.85;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.beginPath();
        const first = cellCentreToScreen(cells[0].x, cells[0].y);
        ctx.moveTo(first.x, first.y);
        for (let i = 1; i < cells.length; i += 1) {
            const s = cellCentreToScreen(cells[i].x, cells[i].y);
            ctx.lineTo(s.x, s.y);
        }
        ctx.stroke();
        // The nights. A hollow dot where each day of walking ends, numbered
        // once the zoom can carry a label. This is what turns "6 days" into a
        // journey the player can look at and point to.
        const checkpoints = Array.isArray(preview.checkpoints) ? preview.checkpoints : [];
        if (!isBlocked && checkpoints.length > 0) {
            const groundColor = readTokenOnce(root, '--color-void-darker', '#0e0f12');
            const labelColor = readTokenOnce(root, '--color-text-primary', '#E8EAED');
            const radius = Math.max(3, cell / 4.5);
            ctx.globalAlpha = 1;
            for (const checkpoint of checkpoints) {
                const screen = cellCentreToScreen(checkpoint.x, checkpoint.y);
                ctx.beginPath();
                ctx.arc(screen.x, screen.y, radius, 0, Math.PI * 2);
                ctx.fillStyle = groundColor;
                ctx.fill();
                ctx.strokeStyle = previewStroke;
                // A night at a place reads heavier than a night in a tent.
                ctx.lineWidth = checkpoint.kind === 'place' ? 2.5 : 1.5;
                ctx.stroke();
                if (cell >= LABEL_MIN_CELL_PIXELS) {
                    ctx.font = `${Math.max(9, Math.round(cell / 2.4))}px ui-monospace, SFMono-Regular, Consolas, monospace`;
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'bottom';
                    ctx.fillStyle = groundColor;
                    ctx.lineWidth = 3;
                    ctx.strokeStyle = groundColor;
                    ctx.strokeText(String(checkpoint.day), screen.x, screen.y - radius - 2);
                    ctx.fillStyle = labelColor;
                    ctx.fillText(String(checkpoint.day), screen.x, screen.y - radius - 2);
                }
            }
        }
        // Endpoints: a ring at the destination cell so the click target reads.
        if (cells.length > 0) {
            const end = cells[cells.length - 1];
            const endScreen = cellCentreToScreen(end.x, end.y);
            ctx.globalAlpha = 0.9;
            ctx.beginPath();
            ctx.arc(endScreen.x, endScreen.y, Math.max(6, cell / 1.8), 0, Math.PI * 2);
            ctx.strokeStyle = isBlocked ? blockedStroke : previewStroke;
            ctx.lineWidth = 2;
            ctx.stroke();
        }
        ctx.restore();
    }

    function updateRoutePanel(snapshot) {
        // While the party is on the road the panel stops being a route planner
        // and becomes the journey's own control. Clicking a 32px cell to
        // advance a day is a fiddly way to spend a press, and the composer's
        // button is across the screen from the map you are watching — so the
        // control lives where the journey is drawn.
        //
        // It reads the HOST's travel state, not the journey record's
        // `totalLegs`. The two disagree (the record counts days, the host
        // counts camps) and the host owns the journey's state, so the host is
        // the one that gets to say "camp 1 of 8".
        const travel = snapshot?.travel ?? null;
        if (travel) {
            panelMode = 'journey';
            routePanel.style.display = 'flex';
            modeRow.style.display = 'none';
            offerRow.style.display = 'none';
            const toName = travel.toName || 'your destination';
            const arriving = travel.leg >= travel.totalLegs;
            const lines = [
                '\u2192 ' + toName,
                'camp ' + travel.leg + ' of ' + travel.totalLegs
                    + (Number.isFinite(snapshot.worldDay) ? ' \u00b7 day ' + snapshot.worldDay : ''),
            ];
            // A click on the map mid-journey is refused (one route at a time).
            // Show the refusal here so the click is answered rather than
            // silently swallowed — a dead click is how three of this map's
            // bugs presented.
            const refusal = getRoutePreview ? getRoutePreview() : null;
            if (refusal && refusal.blocked && refusal.reason === 'journey-active') {
                lines.push('Abandon to plan a new route.');
            }
            routeReadout.textContent = lines.join('\n');
            routeReadout.style.color = 'var(--color-text-primary, inherit)';
            routeTravelButton.style.display = 'inline-block';
            routeTravelButton.textContent = arriving
                ? 'Arrive at ' + toName
                : 'Continue \u2192';
            routeTravelButton.title = arriving
                ? 'Finish the journey and arrive at ' + toName
                : 'Travel on to camp ' + (travel.leg + 1) + ' of ' + travel.totalLegs;
            routeCancelButton.textContent = 'Abandon';
            routeCancelButton.title = 'Stop travelling without arriving';
            return;
        }

        panelMode = 'plan';
        modeRow.style.display = 'flex';
        routeCancelButton.title = '';
        if (!getRoutePreview) { routePanel.style.display = 'none'; return; }
        const preview = getRoutePreview();
        if (!preview) {
            routePanel.style.display = 'none';
            offerRow.style.display = 'none';
            routeTravelButton.style.display = 'none';
            return;
        }
        routePanel.style.display = 'flex';
        routeTravelButton.textContent = 'Travel';
        routeTravelButton.title = '';
        // Keep the mode selector in sync with the host's current mode without
        // firing a change event (the host is the source of truth).
        const currentMode = getTravelMode ? getTravelMode() : preview.mode;
        if (currentMode && modeSelect.value !== currentMode) {
            modeSelect.value = currentMode;
        }
        if (preview.blocked) {
            // `computeRoutePreview` emits a FLAT shape:
            //   { blocked: true, reason: 'no-ledger-path', label: 'No road to this place...' }
            // Reading `preview.blocked.label` off the boolean `true` yielded
            // undefined, so every refusal rendered as the generic fallback and
            // all six authored labels were dead. Accept the object form too, so
            // a future producer that nests them still works.
            const detail = (preview.blocked && typeof preview.blocked === 'object') ? preview.blocked : preview;
            const reason = detail.label || detail.reason || 'no route';
            const toName = (preview.toAnchor && preview.toAnchor.name) || 'destination';
            routeReadout.textContent = `Blocked: ${reason}`;
            routeReadout.style.color = 'var(--color-command-accent, #E01B1B)';
            routeCancelButton.textContent = 'Dismiss';
            routeTravelButton.style.display = 'none';
            // WO 6.3 §1 — the no-road refusal is an offer, not a dead end.
            // Show the band selector (defaulted to the straight-line band
            // the mod pre-computed) and the "Create and travel" button. The
            // other blocked reasons (no current place, no anchor, terrain
            // refused) do not offer a connection — the offer is only for a
            // missing edge, not a missing anchor or impassable terrain.
            const isOfferable = detail.reason === 'no-ledger-path'
                && preview.fromAnchor?.locationId && preview.toAnchor?.locationId;
            if (isOfferable) {
                const defaultBand = typeof detail.defaultBand === 'string' && detail.defaultBand !== 'adjacent'
                    ? detail.defaultBand
                    : 'regional';
                if (offerBandSelect.value !== defaultBand) offerBandSelect.value = defaultBand;
                offerRow.style.display = 'flex';
            } else {
                offerRow.style.display = 'none';
            }
        } else {
            const cellCount = preview.cellCount != null ? preview.cellCount : Math.max(0, (preview.cells || []).length - 1);
            const toName = (preview.toAnchor && preview.toAnchor.name) || 'destination';
            routeReadout.textContent = `→ ${toName}\n${cellCount} cells · ${preview.days} day${preview.days === 1 ? '' : 's'}`;
            routeReadout.style.color = 'var(--color-text-primary, inherit)';
            routeCancelButton.textContent = 'Cancel route';
            routeTravelButton.style.display = 'inline-block';
            offerRow.style.display = 'none';
        }
    }

    function updateScaleBar(cell) {
        const kilometres = scaleDistanceKilometres(cell);
        const width = (kilometres / CELL_KILOMETRES) * cell;
        scaleLabel.textContent = `1 cell = ${CELL_KILOMETRES} km · ${formatScaleDistance(kilometres)}`;
        scaleLine.style.width = `${Math.max(24, Math.min(150, width))}px`;
    }

    function drawHud(snapshot, cell) {
        updateScaleBar(cell);
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
        if (panLast) return;
        const rect = cachedRect || root.getBoundingClientRect();
        cachedRect = rect;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        updateHover(px, py);
        const hover = hitTestAnchor(px, py);
        root.style.cursor = hover ? 'pointer' : 'grab';
    }

    function onCanvasPointerLeave() {
        hoverCell = null;
        hoverReadout.textContent = 'Hover a cell for terrain details';
    }

    function onWindowPointerMove(event) {
        if (!panLast) return;
        const rect = cachedRect;
        if (!rect) return;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        if (!panStarted) {
            // `panLast` is still the press point until the pan actually
            // starts, so it doubles as the dead-zone origin. Inside the
            // dead zone this is still a click: move nothing, and leave
            // `panStarted` false so pointer-up fires the click.
            if (Math.hypot(px - panLast.px, py - panLast.py) < DRAG_DEAD_ZONE_PX) return;
            // Re-base on the current point as the pan begins, so the map
            // does not jump by the width of the dead zone on frame one.
            panStarted = true;
            panLast = { px, py };
            return;
        }
        const cell = cellSizePixels();
        view.cx -= (px - panLast.px) / cell;
        view.cy -= (py - panLast.py) / cell;
        panLast = { px, py };
        clampView();
        scheduleRender();
    }

    function onWindowPointerUp(event) {
        const rect = cachedRect;
        const px = rect ? event.clientX - rect.left : 0;
        const py = rect ? event.clientY - rect.top : 0;
        if (panLast && !panStarted) {
            // WO 5.5 §2 — a click on the off-screen indicator centres the
            // camera on the party. This takes precedence over a cell click:
            // the indicator is the affordance that says "go back to your
            // character", and a click on it should not also route to whatever
            // cell happens to be under the arrow.
            if (partyIndicatorPos
                && Math.hypot(px - partyIndicatorPos.x, py - partyIndicatorPos.y) <= PARTY_INDICATOR_HIT_PX) {
                centreOnParty();
            } else if (onClickCell) {
                // WO 6.1 §1 — a click (no pan). One click, one meaning: show the
                // route to this cell. Departing is the Travel button in the route
                // panel. The renderer only reports the cell — the mod computes the
                // route (pathfinder + anchor snap) and surfaces it back through
                // `getRoutePreview`. A click on a place routes to it: the
                // pathfinder's anchor-snap finds the place at that cell.
                const world = screenToCell(px, py);
                if (Number.isFinite(world.x) && Number.isFinite(world.y)) {
                    // `floor`, not `round` — the cell you clicked is the box the
                    // cursor is inside. Rounding picked the NEAREST corner, so a
                    // click in the right or lower half of a cell selected the
                    // neighbour. Hover and the context menu already floored, so
                    // the readout named one cell and the click travelled to
                    // another.
                    onClickCell(
                        clamp(Math.floor(world.x), 0, FIELD_WORLD_SIZE - 1),
                        clamp(Math.floor(world.y), 0, FIELD_WORLD_SIZE - 1),
                    );
                }
            }
        }
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
        canvas.focus();
        contextMenu.style.display = 'none';
        refreshRect();
        const rect = cachedRect;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        // WO 4.4 — drag always pans. A pointer-down on an anchor is the same
        // gesture as a pointer-down on terrain: a potential pan, or a click
        // if it stays inside the dead zone. A click on a place routes to it
        // (travel), handled on pointer-up via `onClickCell`.
        panLast = { px, py };
        root.style.cursor = 'grabbing';
        attachWindowListeners();
    }

    function zoomBy(factor, anchorX, anchorY) {
        refreshRect();
        const rect = cachedRect;
        const px = anchorX ?? rect.width / 2;
        const py = anchorY ?? rect.height / 2;
        const before = screenToCell(px, py);
        view.cellPixels = clamp(
            view.cellPixels * factor,
            ZOOM_LEVELS[0].cellPixels,
            ZOOM_LEVELS[ZOOM_LEVELS.length - 1].cellPixels,
        );
        const cell = cellSizePixels();
        view.cx = before.x - ((px - rect.width / 2) / cell);
        view.cy = before.y - ((py - rect.height / 2) / cell);
        clampView();
        scheduleRender();
    }

    function onWheel(event) {
        event.preventDefault();
        refreshRect();
        const rect = cachedRect;
        const px = event.clientX - rect.left;
        const py = event.clientY - rect.top;
        const factor = Math.exp(-event.deltaY * 0.0015);
        zoomBy(factor, px, py);
    }

    function onCanvasKeyDown(event) {
        const panStep = Math.max(1, Math.round(40 / cellSizePixels()));
        let handled = true;
        if (event.key === 'ArrowLeft') view.cx -= panStep;
        else if (event.key === 'ArrowRight') view.cx += panStep;
        else if (event.key === 'ArrowUp') view.cy -= panStep;
        else if (event.key === 'ArrowDown') view.cy += panStep;
        else if (event.key === '+' || event.key === '=') zoomBy(1.25);
        else if (event.key === '-' || event.key === '_') zoomBy(0.8);
        else if (event.key === '0') centreOnAnchors();
        else if (event.key === 'c' || event.key === 'C') centreOnParty();
        else handled = false;
        if (!handled) return;
        event.preventDefault();
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
        view.cx = ((minX + maxX) / 2) + 0.5;
        view.cy = ((minY + maxY) / 2) + 0.5;
        const span = Math.max(maxX - minX, maxY - minY, 10) + 8;
        const rect = cachedRect || root.getBoundingClientRect();
        cachedRect = rect;
        const targetCell = Math.min(rect.width, rect.height) / span;
        view.cellPixels = clamp(targetCell, ZOOM_LEVELS[0].cellPixels, ZOOM_LEVELS[ZOOM_LEVELS.length - 1].cellPixels);
        clampView();
        scheduleRender();
    }

    // The map opens on the party, not on the world.
    //
    // `centreOnAnchors` frames the bounding box of every place — a wall chart
    // answering "where is everything", when the question the player is asking
    // is "where am I". Falls back to fit-all when no current place is set.
    //
    // WO 6.2 §3 — during a journey, the party is at `snapshot.party` (today's
    // checkpoint cell), not the current place's anchor (the transit node).
    // `centreOnParty` follows the party down the road: it centres on
    // `snapshot.party` when set, falling back to the current place's anchor.
    //
    // The marker itself — its shape, its screen-pixel sizing, the off-screen
    // indicator — is WORKORDER 5.5. This is only the camera half.
    function centreOnParty() {
        const snapshot = getSnapshot();
        // WO 6.2 — prefer the party cell during a journey.
        const partyCell = snapshot && snapshot.party;
        if (partyCell && Number.isFinite(partyCell.x) && Number.isFinite(partyCell.y)) {
            view.cx = partyCell.x + 0.5;
            view.cy = partyCell.y + 0.5;
            view.cellPixels = ZOOM_LEVELS[2].cellPixels;
            clampView();
            scheduleRender();
            return;
        }
        const currentId = snapshot && snapshot.locationId;
        const anchor = currentId && Array.isArray(snapshot.anchors)
            ? snapshot.anchors.find(candidate => candidate.locationId === currentId)
            : null;
        if (!anchor || !Number.isFinite(anchor.x) || !Number.isFinite(anchor.y)) {
            centreOnAnchors();
            return;
        }
        view.cx = anchor.x + 0.5;
        view.cy = anchor.y + 0.5;
        view.cellPixels = ZOOM_LEVELS[2].cellPixels;
        clampView();
        scheduleRender();
    }

    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onCanvasPointerMove);
    canvas.addEventListener('pointerleave', onCanvasPointerLeave);
    canvas.addEventListener('contextmenu', showContextMenu);
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('keydown', onCanvasKeyDown);

    if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => { refreshRect(); refreshTokenCache(root); resize(); });
        resizeObserver.observe(root);
    } else {
        window.addEventListener('resize', resize);
    }

    refreshRect();
    resize();
    // Restore the camera the panel was holding. Only a genuinely first mount
    // frames itself on the party; a remount must land exactly where the
    // player left off, or every background solve becomes a jump cut.
    const restoredView = typeof getInitialView === 'function' ? getInitialView() : null;
    if (restoredView
        && Number.isFinite(restoredView.cx)
        && Number.isFinite(restoredView.cy)
        && Number.isFinite(restoredView.cellPixels)) {
        view.cx = restoredView.cx;
        view.cy = restoredView.cy;
        view.cellPixels = restoredView.cellPixels;
        clampView();
        scheduleRender();
    } else {
        centreOnParty();
    }

    return () => {
        disposed = true;
        if (rafHandle) cancelAnimationFrame(rafHandle);
        rafHandle = 0;
        if (pulseInterval) { clearInterval(pulseInterval); pulseInterval = 0; }
        detachWindowListeners();
        canvas.removeEventListener('pointerdown', onPointerDown);
        canvas.removeEventListener('pointermove', onCanvasPointerMove);
        canvas.removeEventListener('pointerleave', onCanvasPointerLeave);
        canvas.removeEventListener('contextmenu', showContextMenu);
        canvas.removeEventListener('wheel', onWheel);
        canvas.removeEventListener('keydown', onCanvasKeyDown);
        if (pendingFlushTimer) cancelAnimationFrame(pendingFlushTimer);
        pendingFlushTimer = 0;
        if (resizeObserver) { resizeObserver.disconnect(); resizeObserver = null; }
        else window.removeEventListener('resize', resize);
        pyramid.clear();
        root.replaceChildren();
    };
}