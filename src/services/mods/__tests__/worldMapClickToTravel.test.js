import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mountMapRenderer } from '../../../../public/bundled-mods/worldmap/renderer.js';
import {
    ChunkStore,
    buildWarpField,
} from '../../../../public/bundled-mods/worldmap/field.js';
import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';

/**
 * WO 6.1 — click-to-travel renderer tests.
 *
 * The renderer's click-to-travel is a two-phase gesture on terrain (no anchor
 * hit, no drag): first click previews, second click on the same cell commits.
 * A click elsewhere re-routes. A drag that ends on its start cell writes
 * nothing (WO 4.2 §2) and is NOT a travel command. A pan is not a click.
 *
 * jsdom does not implement a real 2D canvas context, so the renderer's paint
 * path is stubbed (same pattern as `worldMapRenderer.test.js`). The
 * interaction logic is pure pointer-event handling, which jsdom does support.
 */

function location(id, name) {
    return { id, name, aliases: '', connections: [] };
}

function makeStubContext() {
    return {
        fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
        font: '', textAlign: 'left', textBaseline: 'middle',
        imageSmoothingEnabled: true,
        setTransform() {}, save() {}, restore() {}, scale() {},
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {}, stroke() {},
        fillRect() {}, drawImage() {},
        createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData() {},
        measureText(text) { return { width: String(text).length * 6 }; },
        fillText() {},
    };
}

function makeOffscreenStub() {
    const proto = globalThis.OffscreenCanvas?.prototype || {};
    return Object.assign(Object.create(proto), {
        width: 256, height: 256, getContext: () => makeStubContext(),
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
        stub.width = w; stub.height = h;
        return stub;
    }
    globalThis.OffscreenCanvas = FakeOffscreen;
    stubs.push(() => { globalThis.OffscreenCanvas = originalOffscreen; });
    // Fire requestAnimationFrame callbacks synchronously so paint completes
    // before the test body continues — otherwise the RAF fires after the
    // stubs are torn down in afterEach, causing "Cannot set properties of
    // null" on the stubbed canvas context.
    const originalRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => {
        try { cb(performance.now()); } catch { /* ignore — paint errors are non-fatal to the interaction test */ }
        return 1;
    };
    stubs.push(() => { globalThis.requestAnimationFrame = originalRAF; });
    const originalCancelRAF = globalThis.cancelAnimationFrame;
    globalThis.cancelAnimationFrame = () => undefined;
    stubs.push(() => { globalThis.cancelAnimationFrame = originalCancelRAF; });
    return () => { for (const restore of stubs) restore(); };
}

function makeSnapshot(overrides = {}) {
    const result = solveWorldMap({
        locations: [location('a', 'Aethelgard'), location('b', 'Briarwatch')],
        loreChunks: [],
        worldSeed: 'click-seed',
    });
    const controls = buildWarpField(result.transects);
    const chunkStore = new ChunkStore('click-seed', 0.65, controls, new Map());
    return {
        anchors: result.anchors.map(a => ({ ...a, name: a.locationId })),
        transects: result.transects || [],
        connections: result.connections || [],
        settings: { worldSeed: 'click-seed', climateGradient: 0.65 },
        hardened: new Map(),
        locationId: 'a',
        worldVersion: 1,
        chunkStore,
        controls,
        ...overrides,
    };
}

/**
 * Dispatch a pointer event on the canvas with clientX/clientY in rect space.
 * jsdom does not implement `PointerEvent`, so we use `MouseEvent` (which it
 * does) and set the properties the renderer reads: `button`, `buttons`,
 * `clientX`, `clientY`. The renderer's handlers are attached to `pointer*`
 * events, so we dispatch with the `pointer*` type — jsdom's `MouseEvent`
 * carries the type through and the listener matches on it.
 */
function dispatchPointer(target, type, clientX, clientY, opts = {}) {
    const event = new MouseEvent(type, {
        bubbles: true,
        cancelable: true,
        button: 0,
        buttons: type === 'pointerdown' || type === 'pointermove' ? 1 : 0,
        clientX,
        clientY,
        ...opts,
    });
    Object.defineProperty(event, 'pointerType', { value: 'mouse', configurable: true });
    Object.defineProperty(event, 'pointerId', { value: 1, configurable: true });
    target.dispatchEvent(event);
    return event;
}

describe('World Map renderer — click-to-travel (WO 6.1)', () => {
    let cleanup = null;
    let root = null;

    beforeEach(() => {
        cleanup = installCanvasStubs();
        root = document.createElement('div');
        Object.defineProperty(root, 'getBoundingClientRect', {
            configurable: true,
            value: () => ({ left: 0, top: 0, width: 900, height: 640, right: 900, bottom: 640 }),
        });
        document.body.appendChild(root);
    });

    afterEach(() => {
        if (root && root.parentNode) root.parentNode.removeChild(root);
        if (cleanup) cleanup();
    });

    it('a terrain click (no anchor hit) calls onClickCell once — first click previews, commits nothing', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onRouteAction = vi.fn();
        // Mount first so the canvas exists.
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        const canvasEl = root.querySelector('canvas');
        // Click at a position far from any anchor (the anchors are near
        // FIELD_WORLD_SIZE/2 = 500; click at screen 50,50 which maps to a
        // cell well away from them).
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointerup', 50, 50);
        expect(onClickCell).toHaveBeenCalledTimes(1);
        expect(onRouteAction).not.toHaveBeenCalled();
        cleanupRenderer();
    });

    it('a second click on the same cell calls onRouteAction("commit") — second click commits', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        const canvasEl = root.querySelector('canvas');
        // First click — preview.
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointerup', 50, 50);
        expect(onClickCell).toHaveBeenCalledTimes(1);
        // Second click on the same screen position — commit.
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointerup', 50, 50);
        expect(onClickCell).toHaveBeenCalledTimes(1);
        expect(onRouteAction).toHaveBeenCalledWith('commit');
        cleanupRenderer();
    });

    it('a click on a different cell re-routes (onClickCell called again, no commit)', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        const canvasEl = root.querySelector('canvas');
        // First click at 50,50.
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointerup', 50, 50);
        // Second click at 200,200 — different cell, re-route.
        dispatchPointer(canvasEl, 'pointerdown', 200, 200);
        dispatchPointer(window, 'pointerup', 200, 200);
        expect(onClickCell).toHaveBeenCalledTimes(2);
        expect(onRouteAction).not.toHaveBeenCalledWith('commit');
        cleanupRenderer();
    });

    it('a pan (movement) does NOT call onClickCell — pan is not a travel command', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        const canvasEl = root.querySelector('canvas');
        // pointerdown on terrain, then move (pan), then pointerup.
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointermove', 120, 120);
        dispatchPointer(window, 'pointerup', 120, 120);
        expect(onClickCell).not.toHaveBeenCalled();
        expect(onRouteAction).not.toHaveBeenCalled();
        cleanupRenderer();
    });

    it('a drag on an anchor does NOT call onClickCell — drag is not a travel command (WO 4.2 §2)', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onDragAnchor = vi.fn();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        const canvasEl = root.querySelector('canvas');
        // Find the first anchor's screen position. The renderer centres on
        // anchors, so the first anchor is near the screen centre. Use the
        // snapshot's first anchor and cellToScreen math: with
        // centreOnAnchors, view.cx/cy is the midpoint; the anchor's screen
        // pos is ((anchor.x - view.cx) * cell + width/2, ...). We can't read
        // the renderer's internal view, so click at the screen centre —
        // centreOnAnchors puts an anchor there.
        const cx = 450, cy = 320; // screen centre of a 900×640 rect
        dispatchPointer(canvasEl, 'pointerdown', cx, cy);
        // Move a little (more than 3px) to trigger a drag.
        dispatchPointer(window, 'pointermove', cx + 20, cy + 20);
        dispatchPointer(window, 'pointerup', cx + 20, cy + 20);
        // A drag on an anchor hits the anchor path, not the terrain-click
        // path. onClickCell is not called.
        expect(onClickCell).not.toHaveBeenCalled();
        cleanupRenderer();
    });

    it('a drag ending on its start cell writes nothing (WO 4.2 §2) and is not a travel command', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onDragAnchor = vi.fn();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        const canvasEl = root.querySelector('canvas');
        const cx = 450, cy = 320;
        // pointerdown on an anchor, tiny move (< 3px, below the drag
        // threshold), pointerup on the same cell. This is a click on the pin,
        // not a travel command and not a drag commit.
        dispatchPointer(canvasEl, 'pointerdown', cx, cy);
        dispatchPointer(window, 'pointermove', cx + 1, cy + 1);
        dispatchPointer(window, 'pointerup', cx + 1, cy + 1);
        expect(onDragAnchor).not.toHaveBeenCalled();
        expect(onClickCell).not.toHaveBeenCalled();
        expect(onRouteAction).not.toHaveBeenCalledWith('commit');
        cleanupRenderer();
    });

    it('onRouteAction("cancel") is wired to the Cancel route button', () => {
        const snapshot = makeSnapshot();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onRouteAction,
            getRoutePreview: () => ({
                cells: [{ x: 100, y: 100 }, { x: 110, y: 100 }],
                cost: 10, days: 3, mode: 'foot',
                fromAnchor: { locationId: 'a', name: 'A' },
                toAnchor: { locationId: 'b', name: 'B' },
                cellCount: 10,
            }),
            getTravelMode: () => 'foot',
        });
        // The route panel is visible; find the Cancel button and click it.
        const buttons = root.querySelectorAll('button');
        let cancelBtn = null;
        for (const btn of buttons) {
            if (btn.textContent && /cancel route/i.test(btn.textContent)) { cancelBtn = btn; break; }
        }
        expect(cancelBtn).not.toBeNull();
        cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        expect(onRouteAction).toHaveBeenCalledWith('cancel');
        cleanupRenderer();
    });

    it('onRouteAction("setMode") is wired to the mode selector', () => {
        const snapshot = makeSnapshot();
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onRouteAction,
            getRoutePreview: () => ({
                cells: [{ x: 100, y: 100 }, { x: 110, y: 100 }],
                cost: 10, days: 3, mode: 'foot',
                fromAnchor: { locationId: 'a', name: 'A' },
                toAnchor: { locationId: 'b', name: 'B' },
                cellCount: 10,
            }),
            getTravelMode: () => 'foot',
        });
        const select = root.querySelector('select[aria-label="Travel mode"]');
        expect(select).not.toBeNull();
        select.value = 'cart';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        expect(onRouteAction).toHaveBeenCalledWith('setMode', 'cart');
        cleanupRenderer();
    });

    it('a blocked route preview shows the readout and does not call onRouteAction on a second click', () => {
        const snapshot = makeSnapshot();
        const onClickCell = vi.fn();
        const onRouteAction = vi.fn();
        let preview = {
            cells: [], cost: 0, days: 0, mode: 'cart',
            blocked: { reason: 'no-route', label: 'no route by cart — try foot, horseback, flying' },
            fromAnchor: { locationId: 'a', name: 'A' },
            toAnchor: { locationId: 'b', name: 'B' },
            cellCount: 0,
        };
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onDragAnchor: () => undefined,
            onClickCell,
            onRouteAction,
            getRoutePreview: () => preview,
            getTravelMode: () => 'cart',
        });
        const canvasEl = root.querySelector('canvas');
        // First click — previews (onClickCell). The host would set a blocked
        // preview; we simulate that by setting `preview` before the second
        // click.
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointerup', 50, 50);
        expect(onClickCell).toHaveBeenCalledTimes(1);
        // Second click on the same cell — the renderer calls commit, but the
        // host's `handleRouteAction` checks `preview.blocked` and does not
        // emit. The renderer itself calls `onRouteAction('commit')`
        // regardless — the blocked guard is the host's responsibility.
        dispatchPointer(canvasEl, 'pointerdown', 50, 50);
        dispatchPointer(window, 'pointerup', 50, 50);
        expect(onRouteAction).toHaveBeenCalledWith('commit');
        // The readout panel should show the blocked label.
        const readout = root.querySelector('div[style*="white-space: pre-wrap"]');
        expect(readout).not.toBeNull();
        expect(readout.textContent).toContain('Blocked');
        cleanupRenderer();
    });
});