import { it, expect, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import supertest from 'supertest';

it('ground checkpoints and trails survive backend disk save and fresh mod activation', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'worldmap-persistence-'));
    const oldDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = directory;
    vi.resetModules();
    try {
        const { mountModTableRoutes, createTableRegistry } = await import('../lib/tableRegistry.js');
        const { registerModTables } = await import('../lib/modTableRegistry.js');
        const manifest = JSON.parse(fs.readFileSync(path.resolve('public/bundled-mods/worldmap/manifest.json'), 'utf8'));
        const createServer = () => {
            const registry = createTableRegistry();
            registerModTables(registry, [manifest]);
            const app = express(); app.use(express.json()); app.use(mountModTableRoutes(registry));
            return supertest(app);
        };
        let request = createServer();
        const table = {
            read: async name => {
                const response = await request.get(`/api/campaigns/test-ground/mod-tables/mod.worldmap.${name}`);
                expect(response.status).toBe(200); return response.body;
            },
            write: async (name, value) => {
                const response = await request.put(`/api/campaigns/test-ground/mod-tables/mod.worldmap.${name}`)
                    .set('Content-Type', 'application/json').send(JSON.stringify(value));
                expect(response.status).toBe(200);
            },
            subscribe: () => () => {},
        };
        let mod = await import('../../public/bundled-mods/worldmap/index.js');
        const { findRoute } = await import('../../public/bundled-mods/worldmap/pathfinder.js');
        const { advance } = await import('../../src/services/turn/travelState.ts');
        const route = findRoute({ getCell: () => ({ biome: 'plains' }) }, { x: 0, y: 0 }, { x: 9, y: 0 }, 'foot');
        expect(route.days).toBe(3);
        const journey = { id: 'disk-ground', fromId: 'a', toId: 'b', mode: 'foot', cells: route.cells,
            checkpoints: [{ x: 3, y: 0, day: 1, kind: 'camp' }, { x: 6, y: 0, day: 2, kind: 'camp' }], totalLegs: 3, startedOnDay: 10 };
        const ledger = [{ id: 'a', name: 'A', connections: [{ toId: 'b', band: 'regional' }] },
            { id: 'b', name: 'B', connections: [{ toId: 'a', band: 'regional' }] }];
        let location = { ledger, currentPlaceId: 'camp', worldDay: 11,
            travel: { fromId: 'a', toId: 'b', transitId: 'camp', mode: 'foot', leg: 1, totalLegs: 3 } };
        let listeners = [];
        const ctx = {
            get data() { return { campaignId: 'test-ground', location, loreChunks: [], context: {} }; },
            refresh: async () => ctx, table,
            subscribe: (name, callback) => { if (name === 'location') listeners.push(callback); return () => {}; },
            events: { on: () => () => {} },
            mounts: { window: () => ({ open() {} }), header: () => ({}) },
        };
        await table.write('journey', journey);
        await mod.onActivate(ctx);
        for (const listener of listeners) listener();
        await vi.waitFor(async () => expect((await table.read('trails'))?.edges).toHaveLength(3));
        expect(await table.read('position')).toEqual({ x: 3, y: 0, placeId: 'camp' });
        const next = advance(location.travel, location.worldDay);
        location = { ...location, ...next.contextPatch };
        for (const listener of listeners) listener();
        await vi.waitFor(async () => expect((await table.read('trails'))?.edges).toHaveLength(6));
        // Abandon, save, recreate the server registry and all mod caches.
        location = { ...location, travel: null };
        for (const listener of listeners) listener();
        await mod.clearJourney(ctx);
        const diskTrails = await table.read('trails');
        const namedSite = { id: 'disk-site', x: 6, y: 0, type: 'shrine', biome: 'plains',
            name: 'The Quiet Bell', description: 'A cracked bell hangs above the door.' };
        await table.write('discoveries', { sites: [namedSite], surveyed: [] });

        await vi.waitFor(async () => expect((await table.read('encounters'))?.records.some(row => row.key === '12:6:0')).toBe(true));
        const diskEncounters = await table.read('encounters');
        request = createServer();
        vi.resetModules(); listeners = [];
        mod = await import('../../public/bundled-mods/worldmap/index.js');
        await mod.onActivate(ctx);
        expect(mod.mapSnapshot(ctx).party).toEqual({ x: 6, y: 0 });
        expect(await table.read('encounters')).toEqual(diskEncounters);
        expect(mod.mapSnapshot(ctx).discoveries.find(site => site.id === namedSite.id)).toEqual(namedSite);
        const { promoteSite } = await import('../../public/bundled-mods/worldmap/siteTravel.js');
        location = { ...location, ledger: promoteSite(namedSite, location.ledger, 'a') };
        await mod.solveAndPersist(ctx);
        expect((await table.read('anchors')).find(anchor => anchor.locationId === namedSite.id))
            .toMatchObject({ x: namedSite.x, y: namedSite.y, name: namedSite.name });

        expect(await table.read('trails')).toEqual(diskTrails);
        const { readTrails } = await import('../../public/bundled-mods/worldmap/trails.js');
        const retraced = findRoute({ getCell: () => ({ biome: 'plains' }) }, { x: 6, y: 0 }, { x: 0, y: 0 }, 'foot', { trails: readTrails(diskTrails) });
        expect(retraced.cost).toBeCloseTo(5.4);
        expect((await table.read('trails')).edges.every(edge => edge.passes === 1)).toBe(true);
        // Resume the saved trip's final day: arrival must record its last
        // three segments, even with no map window mounted to watch the exit.
        await mod.writeJourney(ctx, journey);
        location = { ...location, ...advance(next.travel, 12).contextPatch };
        for (const listener of listeners) listener();
        await vi.waitFor(async () => expect((await table.read('trails'))?.edges).toHaveLength(9));
        await vi.waitFor(async () => expect(await table.read('journey')).toEqual({}));
        expect(location.worldDay).toBe(13);
        expect(location.currentPlaceId).toBe('b');
        expect(mod.mapSnapshot(ctx).party).toBeNull();

    } finally {
        if (oldDataDir === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = oldDataDir;
        fs.rmSync(directory, { recursive: true, force: true });
    }
});
