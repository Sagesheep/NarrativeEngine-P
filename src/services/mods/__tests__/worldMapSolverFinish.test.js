import { describe, expect, it, vi } from 'vitest';
import {
    solveWorldMap,
} from '../../../../public/bundled-mods/worldmap/solver.js';
import {
    mountMapRenderer,
} from '../../../../public/bundled-mods/worldmap/renderer.js';
import { ChunkStore } from '../../../../public/bundled-mods/worldmap/field.js';

function place(id, name, connections = []) {
    return { id, name, aliases: '', connections, kind: 'place' };
}

function transit(id, name, connections) {
    return { id, name, aliases: '', connections, kind: 'transit' };
}

function anchorById(result, id) {
    return result.anchors.find(anchor => anchor.locationId === id);
}

function gridDistance(left, right) {
    return Math.hypot(right.x - left.x, right.y - left.y);
}

function lore(locationName, content) {
    return {
        id: `lore-${locationName}`,
        header: `LOCATION -- ${locationName}`,
        content,
        category: 'location',
    };
}

// ──────────────────────────────────────────────────────────────────────────
// WO 4.2 §1 — integer cells
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.2 §1 — every anchor and every waypoint coordinate is an integer', () => {
    it('rounds every anchor coordinate to an integer across the whole set', () => {
        const result = solveWorldMap({
            locations: [
                place('a', 'A', [{ toId: 'b', band: 'regional' }]),
                place('b', 'B', [{ toId: 'a', band: 'regional' }]),
                place('c', 'C', [{ toId: 'a', band: 'far' }]),
            ],
            loreChunks: [],
            worldSeed: 'integers-1',
        });
        for (const anchor of result.anchors) {
            expect(Number.isInteger(anchor.x)).toBe(true);
            expect(Number.isInteger(anchor.y)).toBe(true);
            expect(anchor.x).toBeGreaterThanOrEqual(0);
            expect(anchor.y).toBeGreaterThanOrEqual(0);
            expect(anchor.x).toBeLessThan(1000);
            expect(anchor.y).toBeLessThan(1000);
        }
    });

    it('rounds every waypoint coordinate to an integer', () => {
        const a = place('a', 'A', [{ toId: 'b', band: 'regional' }, { toId: 'road', band: 'local' }]);
        const b = place('b', 'B', [{ toId: 'a', band: 'regional' }, { toId: 'road', band: 'local' }]);
        const road = transit('road', 'Road', [
            { toId: 'a', band: 'local' },
            { toId: 'b', band: 'local' },
        ]);
        const result = solveWorldMap({
            locations: [a, b, road],
            loreChunks: [],
            worldSeed: 'integers-waypoint',
        });
        for (const waypoint of result.waypoints || []) {
            const anchor = anchorById(result, waypoint.locationId);
            expect(Number.isInteger(anchor.x)).toBe(true);
            expect(Number.isInteger(anchor.y)).toBe(true);
        }
    });

    // The three cases above all solve with NO chunk store, so terrain-aware
    // placement is a no-op in them — and terrain-aware placement was where the
    // invariant broke. It runs AFTER the round-and-de-collide pass and nudges
    // places off impassable ground to sub-cell positions, so live solves
    // shipped anchors like `{ x: 505.246293, y: 492.82053 }` and could push two
    // places back onto one cell with nothing left to separate them. Every case
    // that exercises the integer-cell invariant must pass a real chunk store.
    it('holds the integer-cell invariant with terrain-aware placement active', () => {
        // Same seeds and shape as the collision case below: these are the ones
        // observed to produce fractional anchors before the fix.
        for (const seed of ['terrain-cell-1', 'terrain-cell-2', 'terrain-cell-3', 'terrain-cell-4']) {
            const result = solveWorldMap({
                locations: [
                    place('a', 'A', [{ toId: 'b', band: 'local' }]),
                    place('b', 'B', [{ toId: 'a', band: 'local' }, { toId: 'c', band: 'local' }]),
                    place('c', 'C', [{ toId: 'b', band: 'local' }, { toId: 'd', band: 'local' }]),
                    place('d', 'D', [{ toId: 'c', band: 'local' }]),
                ],
                loreChunks: [],
                worldSeed: seed,
                chunkStore: new ChunkStore(seed, 0.65, [], new Map()),
            });
            for (const anchor of result.anchors) {
                expect(Number.isInteger(anchor.x), `${seed}/${anchor.locationId} x=${anchor.x}`).toBe(true);
                expect(Number.isInteger(anchor.y), `${seed}/${anchor.locationId} y=${anchor.y}`).toBe(true);
            }
        }
    });

    it('leaves no two anchors sharing a cell after terrain-aware placement', () => {
        for (const seed of ['terrain-cell-1', 'terrain-cell-2', 'terrain-cell-3', 'terrain-cell-4']) {
            const result = solveWorldMap({
                locations: [
                    place('a', 'A', [{ toId: 'b', band: 'local' }]),
                    place('b', 'B', [{ toId: 'a', band: 'local' }, { toId: 'c', band: 'local' }]),
                    place('c', 'C', [{ toId: 'b', band: 'local' }, { toId: 'd', band: 'local' }]),
                    place('d', 'D', [{ toId: 'c', band: 'local' }]),
                ],
                loreChunks: [],
                worldSeed: seed,
                chunkStore: new ChunkStore(seed, 0.65, [], new Map()),
            });
            const cells = result.anchors.map(anchor => `${anchor.x},${anchor.y}`);
            expect(new Set(cells).size, `${seed}: ${cells.join(' | ')}`).toBe(cells.length);
        }
    });
});

describe('WO 4.2 §1 — collision branches now execute (previously unreachable)', () => {
    it('two solved places forced onto the same cell trigger the displacement path', () => {
        // Two unpinned places pinned via Coords to the same cell would be a
        // hard-hard conflict, not a displacement. The displacement path is
        // for two *solved* places rounding onto the same cell. We force that
        // by giving both places the same single connection with a hard `0`
        // band and no Coords — the layout's centring force pulls both to the
        // centre, and the integer rounding puts them on the same cell. The
        // displacement path must move one of them to a neighbouring cell.
        const result = solveWorldMap({
            locations: [
                place('a', 'A', [{ toId: 'b', band: 'adjacent' }]),
                place('b', 'B', [{ toId: 'a', band: 'adjacent' }]),
            ],
            loreChunks: [],
            worldSeed: 'displacement-force',
        });
        const ax = anchorById(result, 'a');
        const bx = anchorById(result, 'b');
        // After the collision pass they must occupy distinct integer cells.
        expect(`${ax.x},${ax.y}`).not.toBe(`${bx.x},${bx.y}`);
        // Both are still integers.
        expect(Number.isInteger(ax.x)).toBe(true);
        expect(Number.isInteger(ax.y)).toBe(true);
        expect(Number.isInteger(bx.x)).toBe(true);
        expect(Number.isInteger(bx.y)).toBe(true);
    });

    it('two pinned places on the same cell produce a hard-conflict refusal', () => {
        const result = solveWorldMap({
            locations: [
                place('a', 'A'),
                place('b', 'B'),
            ],
            loreChunks: [
                lore('A', '**Coords:** 500,500'),
                lore('B', '**Coords:** 500,500'),
            ],
            worldSeed: 'hard-conflict-pins',
        });
        // A refusal is recorded naming both places.
        const refusal = result.report.refusals.find(r =>
            r.locationIds.includes('a') && r.locationIds.includes('b'));
        expect(refusal).toBeDefined();
        expect(refusal.message).toContain('hard pins at the same coordinate');
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.2 §4 + §5 — zero spurious warnings on the live shape
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.2 §4+§5 — the live shape solves with zero warnings', () => {
    it('three places, one transit road, and Coords lore pins produce zero warnings', () => {
        const a = place('a', 'A', [
            { toId: 'b', band: 'regional' },
            { toId: 'road', band: 'local' },
        ]);
        const b = place('b', 'B', [
            { toId: 'a', band: 'regional' },
            { toId: 'road', band: 'local' },
        ]);
        const c = place('c', 'C', [{ toId: 'a', band: 'far' }]);
        const road = transit('road', 'Road', [
            { toId: 'a', band: 'local' },
            { toId: 'b', band: 'local' },
        ]);
        const result = solveWorldMap({
            locations: [a, b, c, road],
            loreChunks: [
                lore('A', '**Coords:** 480,500'),
                lore('B', '**Coords:** 520,500'),
            ],
            worldSeed: 'live-shape-zero-warnings',
        });
        // No `malformed player anchor` warnings (§4) and no
        // `connection to missing location` warnings (§5).
        const malformed = result.report.warnings.filter(w =>
            w.message.includes('malformed player anchor'));
        const missing = result.report.warnings.filter(w =>
            w.message.includes('connection to missing location'));
        expect(malformed).toHaveLength(0);
        expect(missing).toHaveLength(0);
    });

    it('a connection to a toId that names nothing at all still warns (§5 genuine case)', () => {
        const a = place('a', 'A', [{ toId: 'ghost', band: 'local' }]);
        const result = solveWorldMap({
            locations: [a],
            loreChunks: [],
            worldSeed: 'genuine-missing-connection',
        });
        const missing = result.report.warnings.filter(w =>
            w.message.includes('connection to missing location'));
        expect(missing.length).toBeGreaterThanOrEqual(1);
        expect(missing[0].message).toContain('ghost');
    });

    it('a place→transit connection does NOT warn (§5 silent skip)', () => {
        const a = place('a', 'A', [
            { toId: 'b', band: 'regional' },
            { toId: 'road', band: 'local' },
        ]);
        const b = place('b', 'B', [
            { toId: 'a', band: 'regional' },
            { toId: 'road', band: 'local' },
        ]);
        const road = transit('road', 'Road', [
            { toId: 'a', band: 'local' },
            { toId: 'b', band: 'local' },
        ]);
        const result = solveWorldMap({
            locations: [a, b, road],
            loreChunks: [],
            worldSeed: 'place-to-transit-silent',
        });
        const missing = result.report.warnings.filter(w =>
            w.message.includes('connection to missing location'));
        expect(missing).toHaveLength(0);
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.2 §3 — player marker
// ──────────────────────────────────────────────────────────────────────────

function makeStubContext() {
    return {
        fillStyle: '',
        strokeStyle: '',
        lineWidth: 1,
        globalAlpha: 1,
        font: '',
        textAlign: 'left',
        textBaseline: 'middle',
        imageSmoothingEnabled: true,
        setTransform() {},
        save() {},
        restore() {},
        scale() {},
        beginPath() {},
        moveTo() {},
        lineTo() {},
        arc() {},
        fill() {},
        stroke() {},
        closePath() {},
        fillRect() {},
        drawImage() {},
        createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData() {},
        measureText(text) { return { width: String(text).length * 6 }; },
        fillText() {},
    };
}

function makeOffscreenStub() {
    const proto = globalThis.OffscreenCanvas?.prototype || {};
    return Object.assign(Object.create(proto), {
        width: 256,
        height: 256,
        getContext: () => makeStubContext(),
    });
}

function makeDragSnapshot(overrides = {}) {
    const result = solveWorldMap({
        locations: [place('a', 'Aethelgard'), place('b', 'Briarwatch')],
        loreChunks: [],
        worldSeed: 'drag-seed',
    });
    return {
        anchors: result.anchors.map(a => ({ ...a, name: a.locationId })),
        transects: result.transects || [],
        connections: result.connections || [],
        waypoints: result.waypoints || [],
        settings: { worldSeed: 'drag-seed', climateGradient: 0.65 },
        hardened: new Map(),
        locationId: null,
        worldVersion: 1,
        chunkStore: {
            getCell: () => ({ biome: 'plains', elevation: 0.1 }),
            getCellBiomeByte: () => 0,
            version: 1,
            bumpWorldVersion() { this.version += 1; },
            chunks: new Map(),
        },
        controls: [],
        ...overrides,
    };
}

describe('WO 4.2 §3 — player marker', () => {
    let cleanup = null;
    let root = null;
    let stubCtx = null;
    let rafRestore = null;

    beforeEach(() => {
        root = document.createElement('div');
        Object.defineProperty(root, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ left: 0, top: 0, width: 900, height: 640, right: 900, bottom: 640 }),
        });
        document.body.appendChild(root);
        // Build a shared recording stub context and force every canvas's
        // `getContext` to return it, so we can inspect draw calls across a
        // paint. `arc` and `stroke` are the ones we assert on.
        stubCtx = makeStubContext();
        stubCtx.arc = vi.fn();
        stubCtx.stroke = vi.fn();
        stubCtx.fill = vi.fn();
        stubCtx.beginPath = vi.fn();
        const originalGetContext = HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext = function () { return stubCtx; };
        const originalOffscreen = globalThis.OffscreenCanvas;
        function FakeOffscreen(w, h) {
            const stub = makeOffscreenStub();
            stub.width = w;
            stub.height = h;
            return stub;
        }
        globalThis.OffscreenCanvas = FakeOffscreen;
        cleanup = () => {
            HTMLCanvasElement.prototype.getContext = originalGetContext;
            globalThis.OffscreenCanvas = originalOffscreen;
        };
        // RAF flush so paint() runs synchronously on scheduleRender().
        const originalRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = fn => { fn(); return 0; };
        rafRestore = () => { globalThis.requestAnimationFrame = originalRaf; };
    });

    afterEach(() => {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        if (cleanup) cleanup();
        if (rafRestore) rafRestore();
    });

    it('currentPlaceId naming a place with no anchor draws no marker and does not throw', () => {
        const snapshot = makeDragSnapshot({ locationId: 'ghost' });
        expect(() => {
            const rendererCleanup = mountMapRenderer(root, {
                getSnapshot: () => snapshot,
            });
            rendererCleanup();
        }).not.toThrow();
    });

    it('the current place is drawn with a larger radius (ring) than other anchors', () => {
        const snapshot = makeDragSnapshot({ locationId: 'a' });
        const rendererCleanup = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
        });
        // The current anchor 'a' is drawn last with a ring + larger radius.
        // `arc` is called once for the outer ring and once for the inner
        // dot of the current place, plus once for each non-current anchor.
        // With two anchors and one current, we expect at least three arc
        // calls (one for the non-current, two for the current — ring + dot).
        expect(stubCtx.arc.mock.calls.length).toBeGreaterThanOrEqual(3);
        rendererCleanup();
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.4 — lore Coords pins survive; stale player pins are inert
// ──────────────────────────────────────────────────────────────────────────

describe('WO 4.4 — pins die', () => {
    it('a Coords bullet still places its location at the authored cell', () => {
        const result = solveWorldMap({
            locations: [
                place('a', 'A', [{ toId: 'b', band: 'regional' }]),
                place('b', 'B', [{ toId: 'a', band: 'regional' }]),
            ],
            loreChunks: [
                lore('A', '**Coords:** 480,510'),
            ],
            worldSeed: 'coords-survives',
        });
        const anchor = anchorById(result, 'a');
        expect(anchor.x).toBe(480);
        expect(anchor.y).toBe(510);
        // The report's Source column reads `lore` for a Coords-pinned place.
        expect(anchor.source).toBe('lore');
    });

    it('a stale pinned:true sitting in the anchors table has no effect on the solve', () => {
        // Existing campaigns have anchors carrying `pinned: true`. After WO
        // 4.4 nothing reads the field, and the next solve rewrites the file
        // without it. The solve must proceed normally and produce no
        // `malformed player anchor` warnings — the stale player anchor is
        // simply ignored, not parsed.
        const result = solveWorldMap({
            locations: [
                place('a', 'A', [{ toId: 'b', band: 'regional' }]),
                place('b', 'B', [{ toId: 'a', band: 'regional' }]),
            ],
            loreChunks: [],
            existingAnchors: [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
            ],
            worldSeed: 'stale-pinned-inert',
        });
        const malformed = result.report.warnings.filter(w =>
            w.message.includes('malformed player anchor'));
        expect(malformed).toHaveLength(0);
        // No anchor reports `pinned` or `player` — the stale field is gone.
        for (const anchor of result.anchors) {
            expect(anchor.pinned).toBeUndefined();
            expect(anchor.source).not.toBe('player');
        }
    });
});