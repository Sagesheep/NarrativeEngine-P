import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Stub only the paint entry point — jsdom has no 2D canvas context. The rest
// of the renderer module is kept: `index.js` also imports
// `normaliseLayerSettings` from it, and a factory that omits it makes every
// solve after the first throw inside the solve queue's `.catch`.
vi.mock('../../../../public/bundled-mods/worldmap/renderer.js', async importOriginal => ({
    ...(await importOriginal()),
    mountMapRenderer: vi.fn((node, options) => {
        rendererOptions = options;
        return () => undefined;
    }),
}));

let rendererOptions = null;

const { onActivate, mapSnapshot } = await import('../../../../public/bundled-mods/worldmap/index.js');

/**
 * AT MOST ONE ROUTE IS ACTIVE AT A TIME.
 *
 * The renderer drew the committed journey and the route preview as separate
 * layers, on the belief — stated in a comment, enforced nowhere — that they
 * were mutually exclusive. They were not. A click on the map mid-journey
 * opened a second preview, and the player saw two polylines and two
 * independent sets of numbered camps stacked over each other.
 *
 * The second line was wrong twice over: mid-journey the current place is the
 * TRANSIT NODE, so the preview measured from the midpoint of the road rather
 * than from where the party actually stood, and reported a shorter journey
 * than the one already underway.
 *
 * These tests assert the observable result at the seam the player touches —
 * what `getRoutePreview()` hands the renderer after a click — rather than
 * that some internal flag was set.
 */
function place(id, name, connections = []) {
    return { id, name, aliases: '', connections, kind: 'place' };
}

// The world seed is minted randomly at install and then persisted, so a
// fixture that leaves the `settings` table empty gets a DIFFERENT PLANET on
// every test. That is correct product behaviour and a broken test: B landed
// on walkable ground in one test and in a lake in the next, and the failure
// looked like cross-test leakage. Pin the seed so all five tests share one
// world and the only variable is the travel state.
const FIXED_SETTINGS = { worldSeed: 'one-route-fixed-seed', climateGradient: 0.5 };

function makeContext() {
    let settings = { ...FIXED_SETTINGS };
    let anchors = [];
    let visited = [];
    let journey = null;
    const windowMounts = [];
    const windowHandle = { open: vi.fn(), close: vi.fn(), focus: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const subscribers = {};
    const ctx = {
        data: {
            campaignId: 'campaign-one-route',
            loreChunks: [],
            context: {},
            location: {
                currentPlaceId: 'a',
                currentFeature: null,
                worldDay: 1,
                travel: null,
                ledger: [
                    place('a', 'A', [{ toId: 'b', band: 'regional' }]),
                    place('b', 'B', [{ toId: 'a', band: 'regional' }]),
                ],
            },
        },
        table: {
            read: vi.fn(async name => {
                if (name === 'settings') return settings;
                if (name === 'visited') return visited;
                if (name === 'journey') return journey;
                return anchors;
            }),
            write: vi.fn(async (name, value) => {
                if (name === 'settings') settings = value;
                if (name === 'anchors') anchors = value;
                if (name === 'visited') visited = value;
                if (name === 'journey') journey = value;
            }),
            subscribe: vi.fn(() => () => undefined),
        },
        mounts: {
            window: vi.fn(options => { windowMounts.push(options); return windowHandle; }),
            header: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
        },
        events: { on: vi.fn(() => () => undefined), emit: vi.fn() },
        subscribe: vi.fn((key, fn) => { subscribers[key] = fn; return () => undefined; }),
        write: {},
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
    };
    return { ctx, windowMounts, subscribers };
}

async function mountMapPanel(fixture) {
    const options = fixture.windowMounts.find(mount => mount.id === 'map-canvas');
    expect(options, 'the mod registers a map window').toBeTruthy();
    const node = document.createElement('div');
    document.body.append(node);
    const cleanup = options.mount(node, fixture.ctx);
    await new Promise(resolve => setTimeout(resolve, 0));
    return cleanup;
}

/** The solved cell of a place, as the map placed it. */
function anchorCell(ctx, locationId) {
    const snapshot = mapSnapshot(ctx);
    expect(snapshot, 'the map has solved').toBeTruthy();
    const anchor = (snapshot.anchors || []).find(a => a.locationId === locationId);
    expect(anchor, locationId + ' has an anchor').toBeTruthy();
    return anchor;
}

/** Put the party on the road to B, the way `depart()` leaves the context. */
function departToB(ctx) {
    ctx.data.location.travel = {
        fromId: 'a', toId: 'b', transitId: 'transit-a-b',
        mode: 'foot', leg: 1, totalLegs: 4, agency: 'free',
    };
}

describe('world map — at most one route is active at a time', () => {
    let fixture;
    let cleanup;

    beforeEach(async () => {
        rendererOptions = null;
        fixture = makeContext();
        await onActivate(fixture.ctx);
        cleanup = await mountMapPanel(fixture);
    });

    afterEach(() => {
        cleanup?.();
        document.body.replaceChildren();
    });

    it('a click on a place opens a route preview when the party is settled', () => {
        // The control. Without this, a test that only asserts the refusal
        // passes just as well against a map that refuses everything.
        const b = anchorCell(fixture.ctx, 'b');
        rendererOptions.onClickCell(b.x, b.y);
        const preview = rendererOptions.getRoutePreview();
        expect(preview).toBeTruthy();
        expect(preview.blocked).toBeFalsy();
        expect(preview.toAnchor?.locationId).toBe('b');
        expect(preview.cells.length).toBeGreaterThan(0);
    });

    it('a click mid-journey refuses instead of opening a second route', () => {
        departToB(fixture.ctx);
        const b = anchorCell(fixture.ctx, 'b');
        rendererOptions.onClickCell(b.x, b.y);
        const preview = rendererOptions.getRoutePreview();
        expect(preview).toBeTruthy();
        expect(preview.blocked).toBe(true);
        expect(preview.reason).toBe('journey-active');
        // The refusal names the road the party is already on, so the player
        // knows which of the two destinations won.
        expect(preview.label).toContain('B');
        // No cells means the renderer draws no second polyline and no second
        // set of numbered camps — that is the whole point of the cap.
        expect(preview.cells).toBeUndefined();
    });

    it('the mode selector cannot re-route around the cap mid-journey', () => {
        // `setMode` re-runs the preview for the last clicked cell. It is a
        // second door into the same room, so it has to be locked too.
        const b = anchorCell(fixture.ctx, 'b');
        rendererOptions.onClickCell(b.x, b.y);
        expect(rendererOptions.getRoutePreview().blocked).toBeFalsy();
        departToB(fixture.ctx);
        rendererOptions.onRouteAction('setMode', 'horse');
        expect(rendererOptions.getRoutePreview().reason).toBe('journey-active');
    });

    it('a preview opened just before departure does not survive the departure', async () => {
        // The Places panel and the composer TRAVEL button depart without
        // touching the map's own commit path — the one that clears the
        // preview — so a standing preview would otherwise be left drawn
        // beside the journey it became.
        const b = anchorCell(fixture.ctx, 'b');
        rendererOptions.onClickCell(b.x, b.y);
        expect(rendererOptions.getRoutePreview()).toBeTruthy();

        departToB(fixture.ctx);
        await fixture.subscribers.location();

        expect(rendererOptions.getRoutePreview()).toBeNull();
    });

    it('the panel’s Continue and Abandon ask the host, which owns travel', () => {
        // The mod owns route geometry and nothing else. Advancing a day and
        // abandoning are travel-state changes, so they are requests — the
        // same shape as `travelRequest`, landing on the same bridge, which
        // runs the same functions the composer strip’s buttons run.
        departToB(fixture.ctx);
        fixture.ctx.events.emit.mockClear();

        rendererOptions.onRouteAction('continue');
        rendererOptions.onRouteAction('abandon');

        expect(fixture.ctx.events.emit.mock.calls.map(call => call[0]))
            .toEqual(['travelAdvance', 'travelAbandon']);
    });

    it('arriving lets the player plan the next journey again', async () => {
        departToB(fixture.ctx);
        await fixture.subscribers.location();
        const b = anchorCell(fixture.ctx, 'b');
        rendererOptions.onClickCell(b.x, b.y);
        expect(rendererOptions.getRoutePreview().reason).toBe('journey-active');

        // `arrive()` clears `travel` and moves the current place. The cap is
        // on the travel state, so it lifts on its own — no second flag to
        // reset, and nothing to leak into the next journey.
        fixture.ctx.data.location.travel = null;
        fixture.ctx.data.location.currentPlaceId = 'b';
        await fixture.subscribers.location();

        const a = anchorCell(fixture.ctx, 'a');
        rendererOptions.onClickCell(a.x, a.y);
        const preview = rendererOptions.getRoutePreview();
        expect(preview.blocked).toBeFalsy();
        expect(preview.toAnchor?.locationId).toBe('a');
    });
});
