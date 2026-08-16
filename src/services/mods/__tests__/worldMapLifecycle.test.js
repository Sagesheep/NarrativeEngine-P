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
                pinned: false,
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
        expect(last.length).toBe(1);
        expect(last[0]).toMatchObject({ biome: expect.any(String) });
        expect(Number.isFinite(last[0].x)).toBe(true);
        expect(Number.isFinite(last[0].y)).toBe(true);
    });
});
