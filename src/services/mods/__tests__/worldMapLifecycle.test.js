import { describe, expect, it, vi } from 'vitest';
import { onActivate, onInstall } from '../../../../public/bundled-mods/worldmap/index.js';

function makeContext() {
    let settings = null;
    let anchors = [];
    let visited = [];
    const tableWrites = [];
    const windowHandle = { open: vi.fn(), close: vi.fn(), focus: vi.fn(), update: vi.fn(), remove: vi.fn() };
    const ctx = {
        data: {
            campaignId: 'campaign-worldmap',
            loreChunks: [],
            location: {
                currentPlaceId: null,
                currentFeature: null,
                ledger: [{ id: 'frosthold', name: 'Frosthold', aliases: '', connections: [] }],
            },
        },
        table: {
            read: vi.fn(async name => name === 'settings' ? settings : name === 'visited' ? visited : anchors),
            write: vi.fn(async (name, value) => {
                tableWrites.push({ name, value });
                if (name === 'settings') settings = value;
                if (name === 'anchors') anchors = value;
                if (name === 'visited') visited = value;
            }),
            subscribe: vi.fn(() => () => undefined),
        },
        mounts: {
            window: vi.fn(() => windowHandle),
            header: vi.fn(() => ({ update: vi.fn(), remove: vi.fn() })),
        },
        events: { on: vi.fn(() => () => undefined) },
        subscribe: vi.fn(() => () => undefined),
        refresh: vi.fn(async () => ctx),
        log: vi.fn(),
    };
    return {
        ctx,
        tableWrites,
        settings: () => settings,
        anchors: () => anchors,
        visited: () => visited,
    };
}

describe('World Map bundled mod — lifecycle', () => {
    it('creates one seed, mounts the report and map windows, solves, and only writes mod tables', async () => {
        const fixture = makeContext();

        await onInstall(fixture.ctx);
        const installedSeed = fixture.settings().worldSeed;
        await onInstall(fixture.ctx);
        await onActivate(fixture.ctx);

        expect(installedSeed).toMatch(/^(?:[0-9a-f]{32}|fallback-[0-9a-f]{8})$/);
        expect(fixture.tableWrites.filter(write => write.name === 'settings')).toHaveLength(1);
        expect(fixture.ctx.mounts.window).toHaveBeenCalledWith(expect.objectContaining({
            id: 'solve-report',
            title: 'World Map · Solve Report',
            mount: expect.any(Function),
        }));
        expect(fixture.ctx.mounts.window).toHaveBeenCalledWith(expect.objectContaining({
            id: 'map-canvas',
            title: 'World Map',
            mount: expect.any(Function),
        }));
        expect(fixture.ctx.mounts.header).toHaveBeenCalledWith(expect.objectContaining({
            id: 'open-report',
            icon: 'MapPinned',
        }));
        expect(fixture.ctx.mounts.header).toHaveBeenCalledWith(expect.objectContaining({
            id: 'open-map',
            icon: 'Map',
        }));
        expect(fixture.anchors()).toEqual([
            expect.objectContaining({
                locationId: 'frosthold',
                source: 'solved',
            }),
        ]);
        expect(fixture.ctx.write).toBeUndefined();
    });

    it('hardens the cell under the current location on activate and persists it to the visited table', async () => {
        const fixture = makeContext();
        fixture.ctx.data.location.currentPlaceId = 'frosthold';

        await onInstall(fixture.ctx);
        await onActivate(fixture.ctx);

        const visitedWrites = fixture.tableWrites.filter(w => w.name === 'visited');
        expect(visitedWrites.length).toBeGreaterThanOrEqual(1);
        const last = visitedWrites[visitedWrites.length - 1].value;
        expect(Array.isArray(last)).toBe(true);
        const anchor = fixture.anchors().find(row => row.locationId === 'frosthold');
        expect(last).toEqual(expect.arrayContaining([expect.objectContaining({ x: anchor.x, y: anchor.y, biome: expect.any(String) })]));
        expect(last[0]).toMatchObject({ biome: expect.any(String) });
        expect(Number.isFinite(last[0].x)).toBe(true);
        expect(Number.isFinite(last[0].y)).toBe(true);
    });
});
it('returns placement context through the active mod without revealing the requested destination', async () => {
    const fixture = makeContext();
    fixture.ctx.data.location.currentPlaceId = 'frosthold';
    fixture.ctx.data.location.ledger[0].coordinates = { x: 120, y: 130 };
    fixture.ctx.events.emit = vi.fn();
    await onActivate(fixture.ctx);
    const handler = fixture.ctx.events.on.mock.calls.find(([event]) => event === 'mod.worldmap.placementContext')[1];
    await handler({ requestId: 'request', campaignId: 'campaign-worldmap' });
    const [event, response] = fixture.ctx.events.emit.mock.calls.at(-1);
    expect(event).toBe('placementContextResult');
    expect(response.requestId).toBe('request');
    const context = JSON.parse(response.contextJson);
    expect(context.player).toMatchObject({ x: 120, y: 130, placeId: 'frosthold' });
    expect(typeof context.player.biome).toBe('string');
    expect(context.exploredBounds).toEqual({ north: 128, south: 132, west: 118, east: 122 });
    expect(context.fullyExplored).toBe(false);
    const writes = fixture.tableWrites.length;
    await handler({ requestId: 'wrong-campaign', campaignId: 'other' });
    expect(fixture.tableWrites.length).toBe(writes);
});
