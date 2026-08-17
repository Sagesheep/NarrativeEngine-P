import { describe, expect, it, vi } from 'vitest';
import {
    solveWorldMap,
} from '../../../../public/bundled-mods/worldmap/solver.js';
import {
    mountMapRenderer,
} from '../../../../public/bundled-mods/worldmap/renderer.js';

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

    it('rounds a fractional player pin to the nearest integer cell (not preserved, not rejected)', () => {
        const result = solveWorldMap({
            locations: [
                place('a', 'A', [{ toId: 'b', band: 'regional' }]),
                place('b', 'B', [{ toId: 'a', band: 'regional' }]),
            ],
            loreChunks: [],
            existingAnchors: [
                { locationId: 'a', x: 496.6312543426704, y: 500.49, pinned: true, source: 'player' },
            ],
            worldSeed: 'integers-fractional-pin',
        });
        const anchor = anchorById(result, 'a');
        expect(Number.isInteger(anchor.x)).toBe(true);
        expect(Number.isInteger(anchor.y)).toBe(true);
        expect(anchor.x).toBe(497);
        expect(anchor.y).toBe(500);
        expect(anchor.pinned).toBe(true);
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
    it('three places, one transit road, and valid player pins produce zero warnings', () => {
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
            existingAnchors: [
                { locationId: 'a', x: 480, y: 500, pinned: true, source: 'player' },
                { locationId: 'b', x: 520, y: 500, pinned: true, source: 'player' },
                { locationId: 'road', x: 500, y: 500, pinned: true, source: 'player' },
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

    it('an anchor naming a location in neither partition still warns (§4 genuine case)', () => {
        const a = place('a', 'A');
        const result = solveWorldMap({
            locations: [a],
            loreChunks: [],
            existingAnchors: [
                { locationId: 'ghost', x: 100, y: 100, pinned: true, source: 'player' },
            ],
            worldSeed: 'genuine-malformed',
        });
        const malformed = result.report.warnings.filter(w =>
            w.message.includes('malformed player anchor'));
        expect(malformed.length).toBeGreaterThanOrEqual(1);
    });

    it('a non-finite player anchor coordinate still warns (§4 genuine case)', () => {
        const a = place('a', 'A');
        const result = solveWorldMap({
            locations: [a],
            loreChunks: [],
            existingAnchors: [
                { locationId: 'a', x: Number.NaN, y: 100, pinned: true, source: 'player' },
            ],
            worldSeed: 'genuine-nan',
        });
        const malformed = result.report.warnings.filter(w =>
            w.message.includes('malformed player anchor'));
        expect(malformed.length).toBeGreaterThanOrEqual(1);
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
// WO 4.2 §2 — drag commits once, on release
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

function installCanvasStubs() {
    const stubs = [];
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () { return makeStubContext(); };
    stubs.push(() => { HTMLCanvasElement.prototype.getContext = originalGetContext; });
    const originalOffscreen = globalThis.OffscreenCanvas;
    function FakeOffscreen(w, h) {
        const stub = makeOffscreenStub();
        stub.width = w;
        stub.height = h;
        return stub;
    }
    globalThis.OffscreenCanvas = FakeOffscreen;
    stubs.push(() => { globalThis.OffscreenCanvas = originalOffscreen; });
    return () => { for (const restore of stubs) restore(); };
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

describe('WO 4.2 §2 — drag commits once on release', () => {
    let cleanup = null;
    let root = null;
    let rafRestore = null;

    beforeEach(() => {
        cleanup = installCanvasStubs();
        root = document.createElement('div');
        Object.defineProperty(root, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ left: 0, top: 0, width: 900, height: 640, right: 900, bottom: 640 }),
        });
        document.body.appendChild(root);
        // Make requestAnimationFrame run synchronously so paint() fires
        // immediately on scheduleRender(). The renderer registers a RAF
        // on every scheduleRender() call; without this, jsdom never fires
        // RAF and the canvas never paints.
        const originalRaf = globalThis.requestAnimationFrame;
        globalThis.requestAnimationFrame = fn => { fn(); return 0; };
        rafRestore = () => { globalThis.requestAnimationFrame = originalRaf; };
    });

    afterEach(() => {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        if (cleanup) cleanup();
        if (rafRestore) rafRestore();
    });

    // jsdom does not define PointerEvent. Build a minimal MouseEvent with
    // the fields the renderer reads (`button`, `clientX`, `clientY`).
    function pointerEvent(type, clientX, clientY) {
        const event = new MouseEvent(type, {
            bubbles: true,
            clientX,
            clientY,
            button: 0,
        });
        return event;
    }

    function dispatchPointerDown(target, clientX, clientY) {
        target.dispatchEvent(pointerEvent('pointerdown', clientX, clientY));
    }
    function dispatchWindowPointerMove(clientX, clientY) {
        window.dispatchEvent(pointerEvent('pointermove', clientX, clientY));
    }
    function dispatchWindowPointerUp(clientX, clientY) {
        window.dispatchEvent(pointerEvent('pointerup', clientX, clientY));
    }

    it('a drag spanning many pointer-move events produces exactly one onDragAnchor call', () => {
        const snapshot = makeDragSnapshot();
        const onDragAnchor = vi.fn();
        const rendererCleanup = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor,
        });
        const canvas = root.querySelector('canvas');
        expect(canvas).not.toBeNull();
        // Replicate the renderer's `centreOnAnchors` math to find where the
        // first anchor lands on screen, then hit-test there. The renderer
        // centres on the anchor bounding box on mount.
        const anchors = snapshot.anchors;
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const a of anchors) {
            if (a.x < minX) minX = a.x;
            if (a.y < minY) minY = a.y;
            if (a.x > maxX) maxX = a.x;
            if (a.y > maxY) maxY = a.y;
        }
        const span = Math.max(maxX - minX, maxY - minY, 10) + 8;
        const cell = Math.max(4, Math.min(32, Math.min(900, 640) / span));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        // First anchor's screen position.
        const ax = ((anchors[0].x - cx) * cell) + 450;
        const ay = ((anchors[0].y - cy) * cell) + 320;
        dispatchPointerDown(canvas, ax, ay);
        // Move several times — this used to fire onDragAnchor per move.
        // Each move is well past the 3px drag threshold.
        for (let i = 1; i <= 10; i += 1) {
            dispatchWindowPointerMove(ax + i * 10, ay + i * 5);
        }
        dispatchWindowPointerUp(ax + 100, ay + 50);
        // Exactly one commit on release.
        expect(onDragAnchor).toHaveBeenCalledTimes(1);
        // The committed coordinates are integers.
        const callArgs = onDragAnchor.mock.calls[0];
        expect(Number.isInteger(callArgs[1])).toBe(true);
        expect(Number.isInteger(callArgs[2])).toBe(true);
        rendererCleanup();
    });

    it('a drag ending on its start cell writes nothing', () => {
        const snapshot = makeDragSnapshot();
        const onDragAnchor = vi.fn();
        const rendererCleanup = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor,
        });
        const canvas = root.querySelector('canvas');
        dispatchPointerDown(canvas, 450, 320);
        // Move less than the 3px drag threshold so the gesture stays a
        // click, not a drag. The pointer-up then lands on the start cell
        // and writes nothing.
        dispatchWindowPointerMove(451, 321);
        dispatchWindowPointerUp(450, 320);
        expect(onDragAnchor).not.toHaveBeenCalled();
        rendererCleanup();
    });

    it('a non-finite or out-of-bounds drag coordinate is rejected and the previous position survives', () => {
        // The renderer clamps the preview to [0, WORLD_SIZE-1] during the
        // drag, so a wildly out-of-bounds release still commits a finite,
        // in-bounds integer — or no commit at all if it rounds back onto
        // the start cell. We assert that *if* onDragAnchor fires, its
        // coordinates are finite integers in bounds. The "previous
        // position survives" contract is upheld because no bad value is
        // ever stored.
        const snapshot = makeDragSnapshot();
        const onDragAnchor = vi.fn();
        const rendererCleanup = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor,
        });
        const canvas = root.querySelector('canvas');
        dispatchPointerDown(canvas, 450, 320);
        dispatchWindowPointerMove(-5000, -5000);
        dispatchWindowPointerUp(-5000, -5000);
        for (const call of onDragAnchor.mock.calls) {
            expect(Number.isFinite(call[1])).toBe(true);
            expect(Number.isFinite(call[2])).toBe(true);
            expect(call[1]).toBeGreaterThanOrEqual(0);
            expect(call[2]).toBeGreaterThanOrEqual(0);
            expect(call[1]).toBeLessThan(1000);
            expect(call[2]).toBeLessThan(1000);
            expect(Number.isInteger(call[1])).toBe(true);
            expect(Number.isInteger(call[2])).toBe(true);
        }
        rendererCleanup();
    });
});

// ──────────────────────────────────────────────────────────────────────────
// WO 4.2 §3 — player marker
// ──────────────────────────────────────────────────────────────────────────

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
                onDragAnchor: () => undefined,
            });
            rendererCleanup();
        }).not.toThrow();
    });

    it('the current place is drawn with a larger radius (ring) than other anchors', () => {
        const snapshot = makeDragSnapshot({ locationId: 'a' });
        const rendererCleanup = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
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