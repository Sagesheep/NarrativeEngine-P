import { describe, expect, it, afterEach, beforeEach, vi } from 'vitest';
import { mountMapRenderer, journeyIsDrawable } from '../../../../public/bundled-mods/worldmap/renderer.js';
import {
    ChunkStore,
    buildWarpField,
} from '../../../../public/bundled-mods/worldmap/field.js';
import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';

/**
 * The map's route panel has two states.
 *
 * **Planning** — a preview is up: mode selector, distance readout, Travel /
 * Cancel route.
 *
 * **Travelling** — the party is on the road: which camp of how many, on what
 * day, and the journey's own two controls, Continue and Abandon. Advancing a
 * day by clicking a 32px cell is a fiddly way to spend a press, and the
 * composer's button is across the screen from the map the player is watching.
 *
 * The panel reuses one pair of buttons for both states, so what each button
 * *dispatches* is part of the contract, not just what it says.
 *
 * Also covered here: the road emphasis. `drawConnections` highlighted the road
 * the transit node sits on — WO 4.2 §3, written before the journey line
 * existed — in the same token `drawJourney` uses. Both ran at once, so the map
 * drew two purple lines a few pixels apart (a straight chord through the
 * waypoint, and the terrain staircase) and it read as two journeys.
 */

function location(id, name, connections = []) {
    return { id, name, aliases: '', connections };
}

/**
 * A canvas stub that records every stroke's colour and width. The emphasis
 * bug was invisible to a stub that discards them: both lines drew fine, they
 * just both drew.
 */
function makeStubContext(strokes) {
    const ctx = {
        fillStyle: '', strokeStyle: '', lineWidth: 1, globalAlpha: 1,
        font: '', textAlign: 'left', textBaseline: 'middle',
        imageSmoothingEnabled: true,
        setTransform() {}, save() {}, restore() {}, scale() {},
        beginPath() {}, moveTo() {}, lineTo() {}, arc() {}, fill() {},
        stroke() {
            if (strokes) strokes.push({ style: ctx.strokeStyle, width: ctx.lineWidth });
        },
        closePath() {},
        fillRect() {}, drawImage() {},
        createImageData(w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }; },
        putImageData() {},
        measureText(text) { return { width: String(text).length * 6 }; },
        fillText() {},
    };
    return ctx;
}

function makeOffscreenStub() {
    const proto = globalThis.OffscreenCanvas?.prototype || {};
    return Object.assign(Object.create(proto), {
        width: 256, height: 256, getContext: () => makeStubContext(null),
    });
}

function installCanvasStubs(strokes) {
    const stubs = [];
    const originalGetContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function () { return makeStubContext(strokes); };
    stubs.push(() => { HTMLCanvasElement.prototype.getContext = originalGetContext; });
    const originalOffscreen = globalThis.OffscreenCanvas;
    function FakeOffscreen(w, h) {
        const stub = makeOffscreenStub();
        stub.width = w; stub.height = h;
        return stub;
    }
    globalThis.OffscreenCanvas = FakeOffscreen;
    stubs.push(() => { globalThis.OffscreenCanvas = originalOffscreen; });
    const originalRAF = globalThis.requestAnimationFrame;
    globalThis.requestAnimationFrame = (cb) => {
        try { cb(performance.now()); } catch { /* paint errors are not this test's subject */ }
        return 1;
    };
    stubs.push(() => { globalThis.requestAnimationFrame = originalRAF; });
    const originalCancelRAF = globalThis.cancelAnimationFrame;
    globalThis.cancelAnimationFrame = () => undefined;
    stubs.push(() => { globalThis.cancelAnimationFrame = originalCancelRAF; });
    return () => { for (const restore of stubs) restore(); };
}

const SEED = 'journey-panel-seed';

function makeSnapshot(overrides = {}) {
    const result = solveWorldMap({
        locations: [
            location('a', 'Aethelgard', [{ toId: 'b', band: 'regional' }]),
            location('b', 'Briarwatch', [{ toId: 'a', band: 'regional' }]),
        ],
        loreChunks: [],
        worldSeed: SEED,
    });
    const controls = buildWarpField(result.transects);
    const chunkStore = new ChunkStore(SEED, 0.65, controls, new Map());
    return {
        anchors: result.anchors.map(a => ({ ...a, name: a.locationId })),
        transects: result.transects || [],
        connections: result.connections || [],
        waypoints: result.waypoints || [],
        settings: { worldSeed: SEED, climateGradient: 0.65 },
        hardened: new Map(),
        locationId: 'a',
        worldVersion: 1,
        travel: null,
        worldDay: 12,
        chunkStore,
        controls,
        ...overrides,
    };
}

/** The travel summary the mod puts on the snapshot from the host's state. */
function travelling(overrides = {}) {
    return { toId: 'b', toName: 'Briarwatch', leg: 1, totalLegs: 8, ...overrides };
}

/** A committed journey record — a diagonal walk with a camp on it. */
function journeyRecord(anchors) {
    const from = anchors.find(a => a.locationId === 'a');
    const to = anchors.find(a => a.locationId === 'b');
    const cells = [];
    const steps = 8;
    for (let i = 0; i <= steps; i += 1) {
        cells.push({
            x: Math.round(from.x + ((to.x - from.x) * i) / steps),
            y: Math.round(from.y + ((to.y - from.y) * i) / steps),
            cost: i,
        });
    }
    return {
        fromId: 'a',
        toId: 'b',
        mode: 'foot',
        cells,
        checkpoints: cells.slice(1, -1).map((c, i) => ({ x: c.x, y: c.y, day: i + 1, kind: 'camp' })),
        totalLegs: 9,
        startedOnDay: 12,
    };
}

function panelButtons(root) {
    return [...root.querySelectorAll('button')];
}

/**
 * Find a button by its EXACT label. A substring match picked up the context
 * menu's "Travel here" instead of the panel's "Travel" and the test failed
 * with an empty mock, which reads like the wiring is broken when it is the
 * test's aim that is.
 */
function buttonNamed(root, text) {
    const all = panelButtons(root);
    const found = all.find(b => (b.textContent || '').trim() === text);
    expect(
        found,
        'a button labelled "' + text + '" (saw: '
            + all.map(b => JSON.stringify((b.textContent || '').trim())).join(', ') + ')',
    ).toBeTruthy();
    return found;
}

describe('World Map — the route panel becomes the journey panel', () => {
    let cleanup = null;
    let root = null;
    let strokes = null;

    beforeEach(() => {
        strokes = [];
        cleanup = installCanvasStubs(strokes);
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

    it('shows the journey, its progress, and a Continue button while travelling', () => {
        const snapshot = makeSnapshot({ travel: travelling(), locationId: 'transit-a-b' });
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onClickCell: () => undefined,
            onRouteAction: () => undefined,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });

        // The player has to be able to see where they are without counting
        // dots on the map.
        expect(root.textContent).toContain('Briarwatch');
        expect(root.textContent).toContain('camp 1 of 8');
        expect(root.textContent).toContain('day 12');

        const cont = buttonNamed(root, 'Continue →');
        expect(cont.title).toContain('camp 2 of 8');
        buttonNamed(root, 'Abandon');
        cleanupRenderer();
    });

    it('Continue and Abandon dispatch the journey actions, not the planning ones', () => {
        // The panel reuses the Travel/Cancel buttons for both states, so the
        // action each one dispatches is the part that can silently go wrong.
        const snapshot = makeSnapshot({ travel: travelling(), locationId: 'transit-a-b' });
        const onRouteAction = vi.fn();
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onClickCell: () => undefined,
            onRouteAction,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });

        buttonNamed(root, 'Continue →').click();
        buttonNamed(root, 'Abandon').click();

        const actions = onRouteAction.mock.calls.map(call => call[0]);
        expect(actions).toEqual(['continue', 'abandon']);
        // Committing a route the player is already walking, or cancelling a
        // preview that is not there, are the two ways this could go wrong.
        expect(actions).not.toContain('commit');
        expect(actions).not.toContain('cancel');
        cleanupRenderer();
    });

    it('reads Arrive on the last leg', () => {
        const snapshot = makeSnapshot({
            travel: travelling({ leg: 8, totalLegs: 8 }),
            locationId: 'transit-a-b',
        });
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onClickCell: () => undefined,
            onRouteAction: () => undefined,
            getRoutePreview: () => null,
            getTravelMode: () => 'foot',
        });
        buttonNamed(root, 'Arrive at Briarwatch');
        expect(panelButtons(root).some(b => (b.textContent || '').includes('Continue'))).toBe(false);
        cleanupRenderer();
    });

    it('answers a refused mid-journey click instead of swallowing it', () => {
        // One route at a time means a click on another place is refused. A
        // click that changes nothing on screen is how three of this map's
        // bugs presented, so the refusal is shown in the journey panel.
        const snapshot = makeSnapshot({ travel: travelling(), locationId: 'transit-a-b' });
        const cleanupRenderer = mountMapRenderer(root, {
            getSnapshot: () => snapshot,
            onClickCell: () => undefined,
            onRouteAction: () => undefined,
            getRoutePreview: () => ({
                blocked: true,
                reason: 'journey-active',
                label: 'Already on the road to Briarwatch',
            }),
            getTravelMode: () => 'foot',
        });
        expect(root.textContent).toContain('Abandon to plan a new route');
        cleanupRenderer();
    });

    it('goes back to planning when the journey ends', () => {
        // The panel state is derived from the travel state, so there is no
        // second flag to reset — but that is the claim, so it gets a test.
        // A repaint remounts the renderer, which is how the mod pushes a new
        // snapshot, so that is what the test does.
        const onRouteAction = vi.fn();
        const options = snapshot => ({
            getSnapshot: () => snapshot,
            onClickCell: () => undefined,
            onRouteAction,
            getRoutePreview: () => (snapshot.travel ? null : {
                cells: [{ x: 1, y: 1 }, { x: 2, y: 2 }],
                cellCount: 2, days: 1, mode: 'foot',
                toAnchor: { locationId: 'b', name: 'Briarwatch' },
            }),
            getTravelMode: () => 'foot',
        });

        let cleanupRenderer = mountMapRenderer(root, options(
            makeSnapshot({ travel: travelling(), locationId: 'transit-a-b' }),
        ));
        buttonNamed(root, 'Continue →');
        cleanupRenderer();
        root.replaceChildren();

        cleanupRenderer = mountMapRenderer(root, options(
            makeSnapshot({ travel: null, locationId: 'b' }),
        ));
        buttonNamed(root, 'Travel').click();
        expect(onRouteAction.mock.calls.map(c => c[0])).toEqual(['commit']);
        cleanupRenderer();
    });

    it('the road emphasis stands down while the journey line is drawn', () => {
        // `drawConnections` emphasised the road the transit node sits on — WO
        // 4.2 §3, written before the journey line existed — in the SAME token
        // `drawJourney` uses. Both ran at once, so the map drew a straight
        // chord through the waypoint and a terrain staircase a few pixels
        // apart, in the same purple. That is what read as two journeys.
        //
        // Asserted as the decision the two draw passes share, not as canvas
        // stroke widths: jsdom has no real 2D context, so a pixel-shaped test
        // here would be measuring the stub.
        const journey = journeyRecord(makeSnapshot().anchors);

        expect(journeyIsDrawable({ journey, journeyLeg: 1 })).toBe(true);

        // The degrade path — a Places-panel or composer departure carries no
        // route geometry, so the road emphasis is the only thing that can
        // show the journey. It must survive there, or this trades one silence
        // for another.
        expect(journeyIsDrawable({ journey: null, journeyLeg: null })).toBe(false);
        expect(journeyIsDrawable({ journey: { ...journey, cells: [] }, journeyLeg: 1 })).toBe(false);

        // A journey record with no leg is a half-written state, not a journey.
        expect(journeyIsDrawable({ journey, journeyLeg: null })).toBe(false);
        expect(journeyIsDrawable({})).toBe(false);
    });
});
