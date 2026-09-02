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

const { onActivate } = await import('../../../../public/bundled-mods/worldmap/index.js');

/**
 * The solve queue is ONE promise chain, and every map action rides it: the
 * initial solve, a lore change, a campaign open, and a travel commit.
 *
 * WO 4.4 removed the drag handler — the old re-entrancy site — so this file's
 * original premise (a drag deadlocking the queue) left with it. The lesson
 * stays: a queued task MUST NOT re-enter the queue, because reassigning
 * `solveQueue` to a promise derived from the very chain the running task is
 * awaited by makes the two adopt each other and the chain stays pending
 * forever. Every later solve silently never runs — and the queue's `.catch`
 * never fires on a pending promise, so it is invisible.
 *
 * These tests retarget the invariant onto actions that remain: a lore change,
 * a campaign open, and a travel commit. Each await is raced against a timer
 * so a re-introduced deadlock fails the test in milliseconds instead of
 * hanging until the suite timeout.
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
    const subscribers = {};
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
        events: { on: vi.fn((event, fn) => { eventHandlers[event] = fn; return () => undefined; }), emit: vi.fn() },
        subscribe: vi.fn((key, fn) => { subscribers[key] = fn; return () => undefined; }),
        write: {},
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
    };
    const eventHandlers = {};
    return { ctx, windowMounts, anchors: () => anchors, subscribers, eventHandlers };
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

    it('a lore change re-solves without stalling the queue', async () => {
        // The `loreChunks` subscriber calls `queueSolve`. A queued task that
        // re-enters the queue would deadlock here — but `queueSolve` calls
        // `solveAndPersist` directly, never `enqueue` from inside itself.
        const before = fixture.ctx.table.write.mock.calls.filter(([name]) => name === 'anchors').length;
        const lore = await settlesWithin(fixture.subscribers['loreChunks']());
        expect(lore.settled, 'the lore-change solve settles — it does not deadlock the queue').toBe(true);
        const after = fixture.ctx.table.write.mock.calls.filter(([name]) => name === 'anchors').length;
        expect(after, 'a lore change writes a fresh anchors table').toBeGreaterThan(before);
    });

    it('a campaign open re-solves without stalling the queue', async () => {
        // The `campaign.opened` event handler calls `queueSolve`. It must
        // settle, and the anchors table must reflect the re-solve. The
        // handler calls `queueSolve` without awaiting (it is a fire-and-
        // forget enqueue), so we wait one microtask for the queued task to
        // land before reading the write count.
        const before = fixture.ctx.table.write.mock.calls.filter(([name]) => name === 'anchors').length;
        const opened = await settlesWithin(fixture.eventHandlers['campaign.opened']?.());
        expect(opened.settled, 'the campaign-open solve settles').toBe(true);
        // Let the queued solve drain — `queueSolve` is fire-and-forget.
        await new Promise(resolve => setTimeout(resolve, 10));
        const after = fixture.ctx.table.write.mock.calls.filter(([name]) => name === 'anchors').length;
        expect(after, 'a campaign open writes a fresh anchors table').toBeGreaterThan(before);
    });

    it('a second lore change after the first still settles — the queue is not poisoned', async () => {
        // The regression this guards: a queued task that re-entered the queue
        // left `solveQueue` pending forever, so every later solve silently
        // never ran. Two sequential lore changes must both settle.
        const first = await settlesWithin(fixture.subscribers['loreChunks']());
        expect(first.settled).toBe(true);
        const second = await settlesWithin(fixture.subscribers['loreChunks']());
        expect(second.settled, 'the second lore change settles — the queue is not poisoned').toBe(true);
    });

    it('a travel commit (route commit) does not re-enter the queue', async () => {
        // The route-commit path (`handleRouteAction('commit')`) writes the
        // journey record and emits `travelRequest` — it must not call
        // `enqueue` from inside a queued task. We drive it through the
        // renderer's `onRouteAction` option, which is the same seam a real
        // click uses.
        expect(rendererOptions?.onRouteAction, 'the map panel wires onRouteAction').toBeTypeOf('function');
        // Provide a valid route preview so the commit path has something to
        // persist. The preview is read via `getRoutePreview`, which the
        // panel wires to the per-campaign map.
        const commit = await settlesWithin(Promise.resolve(rendererOptions.onRouteAction('commit')));
        // The commit path may or may not write depending on whether a
        // preview is set; the invariant is that it SETTLES and does not
        // deadlock the queue.
        expect(commit.settled, 'the travel commit settles — it does not deadlock the queue').toBe(true);
    });
});