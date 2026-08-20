import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// Stub only the paint entry point — jsdom has no 2D canvas context. The rest
// of the renderer module is kept: `index.js` also imports
// `normaliseLayerSettings` from it, and a factory that omits it makes every
// solve after the first throw inside the queue's `.catch`, which looks
// exactly like the deadlock this file exists to catch.
vi.mock('../../../../public/bundled-mods/worldmap/renderer.js', async importOriginal => ({
    ...(await importOriginal()),
    mountMapRenderer: vi.fn((node, options) => {
        rendererOptions = options;
        return () => undefined;
    }),
}));

let rendererOptions = null;

const { onActivate, unpinAnchor, resetAllPins } = await import('../../../../public/bundled-mods/worldmap/index.js');

/**
 * The solve queue is ONE promise chain, and every map action rides it: the
 * initial solve, a lore change, a pin drag, unpin, reset, re-solve from lore,
 * and the re-route behind "connect on demand".
 *
 * `onDragAnchor` used to end its queued task with `.then(() => queueSolve(ctx))`.
 * That reassigns `solveQueue` to a promise derived from the very chain the
 * running task is awaited by, so the two adopt each other and the chain stays
 * pending forever. One pin drag killed every later solve in the session —
 * silently, because the queue's `.catch` never fires on a pending promise.
 *
 * The user-visible shape was three separate-looking bugs: "unpin doesn't work,
 * reset pins doesn't work, travelling doesn't work". They were one deadlock.
 *
 * These tests assert the OBSERVABLE result (WO 5.4 §4): after a drag, the next
 * action still completes and still changes the anchors table. Each await is
 * raced against a timer so a re-introduced deadlock fails the test in
 * milliseconds instead of hanging until the suite timeout.
 */
function settlesWithin(promise, ms = 2000) {
    return Promise.race([
        promise.then(value => ({ settled: true, value })),
        new Promise(resolve => setTimeout(() => resolve({ settled: false }), ms)),
    ]);
}

function place(id, name, connections = []) {
    return { id, name, aliases: '', connections, kind: 'place' };
}

function makeContext() {
    let settings = null;
    let anchors = [];
    let visited = [];
    const windowMounts = [];
    const windowHandle = { open: vi.fn(), close: vi.fn(), focus: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const ctx = {
        data: {
            campaignId: 'campaign-solve-queue',
            loreChunks: [],
            context: {},
            location: {
                currentPlaceId: null,
                currentFeature: null,
                ledger: [
                    place('a', 'A', [{ toId: 'b', band: 'regional' }]),
                    place('b', 'B', [{ toId: 'a', band: 'regional' }]),
                ],
            },
        },
        table: {
            read: vi.fn(async name => name === 'settings' ? settings : name === 'visited' ? visited : anchors),
            write: vi.fn(async (name, value) => {
                if (name === 'settings') settings = value;
                if (name === 'anchors') anchors = value;
                if (name === 'visited') visited = value;
            }),
            subscribe: vi.fn(() => () => undefined),
        },
        mounts: {
            window: vi.fn(options => { windowMounts.push(options); return windowHandle; }),
            header: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
        },
        events: { on: vi.fn(() => () => undefined), emit: vi.fn() },
        subscribe: vi.fn(() => () => undefined),
        write: {},
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
    };
    return { ctx, windowMounts, anchors: () => anchors };
}

async function mountMapPanel(fixture) {
    const options = fixture.windowMounts.find(mount => mount.id === 'map-canvas');
    expect(options, 'the mod registers a map window').toBeTruthy();
    const node = document.createElement('div');
    document.body.append(node);
    const cleanup = options.mount(node, fixture.ctx);
    // `mountMap` resolves its live context asynchronously before rendering.
    await new Promise(resolve => setTimeout(resolve, 0));
    return { node, cleanup };
}

describe('world map solve queue — re-entrancy', () => {
    let fixture;
    let cleanup;

    beforeEach(async () => {
        rendererOptions = null;
        fixture = makeContext();
        await onActivate(fixture.ctx);
        ({ cleanup } = await mountMapPanel(fixture));
    });

    afterEach(() => {
        cleanup?.();
        document.body.replaceChildren();
    });

    it('drags a pin without stalling the queue', async () => {
        expect(rendererOptions?.onDragAnchor, 'the map panel wires onDragAnchor').toBeTypeOf('function');

        const drag = await settlesWithin(rendererOptions.onDragAnchor('a', 400, 400));
        expect(drag.settled, 'the drag commit settles — it does not deadlock the queue').toBe(true);

        const pinned = fixture.anchors().find(anchor => anchor.locationId === 'a');
        expect(pinned).toMatchObject({ x: 400, y: 400, pinned: true, source: 'player' });
    });

    it('still unpins after a drag — the drag does not poison every later solve', async () => {
        await settlesWithin(rendererOptions.onDragAnchor('a', 400, 400));

        const unpin = await settlesWithin(unpinAnchor(fixture.ctx, 'campaign-solve-queue', 'a'));
        expect(unpin.settled, 'unpin settles after a drag').toBe(true);
        expect(unpin.value).toBe(true);

        const freed = fixture.anchors().find(anchor => anchor.locationId === 'a');
        expect(freed.pinned).toBe(false);
        expect(freed.source).toBe('solved');
    });

    it('still resets every pin after a drag', async () => {
        await settlesWithin(rendererOptions.onDragAnchor('a', 400, 400));
        await settlesWithin(rendererOptions.onDragAnchor('b', 420, 430));

        const reset = await settlesWithin(resetAllPins(fixture.ctx, 'campaign-solve-queue'));
        expect(reset.settled, 'reset settles after two drags').toBe(true);
        expect(reset.value).toBe(true);
        expect(fixture.anchors().some(anchor => anchor.pinned === true || anchor.source === 'player')).toBe(false);
    });

    it('re-solves rather than dying silently when the panel offers Unpin on a free row', async () => {
        // The Unpin control is drawn from the published report; the action
        // reads the anchors table. When they disagree the click used to write
        // nothing and repaint the same stale report — a dead control. It must
        // re-solve so one click converges the panel onto the table.
        const before = fixture.ctx.table.write.mock.calls.filter(([name]) => name === 'anchors').length;

        const unpin = await settlesWithin(unpinAnchor(fixture.ctx, 'campaign-solve-queue', 'a'));
        expect(unpin.settled).toBe(true);
        expect(unpin.value).toBe(false);

        const after = fixture.ctx.table.write.mock.calls.filter(([name]) => name === 'anchors').length;
        expect(after, 'a no-op unpin still re-solves so the panel catches up').toBeGreaterThan(before);
    });
});
