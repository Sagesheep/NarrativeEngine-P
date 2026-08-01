// WO-P5-05 Step 3 — mod table routes (dynamic GET/PUT pair).
//
// The contract under test is §2 defence #3: "the generic route must serve
// only registered table names. A request for a table that is not in the
// registry is a 404 before any path is built. Never interpolate a URL
// parameter into a filename."
//
// Mod tables are dynamic — installed/uninstalled without a server restart —
// so the route looks up the registry at request time, unlike built-in tables
// whose routes are mounted at startup.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import supertest from 'supertest';

let tmpDir;
let campaignsDir;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-table-routes-'));
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
    const store = await import('../lib/fileStore.js?t=' + Date.now());
    campaignsDir = store.CAMPAIGNS_DIR;
    fs.mkdirSync(campaignsDir, { recursive: true });
});

afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('WO-P5-05 Step 3 — mod table dynamic routes', () => {
    it('returns 404 for an unregistered table name before any path is built', async () => {
        const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const { BUILTIN_CAMPAIGN_FILE_SUFFIXES } = await import('../lib/fileStore.js?t=' + Date.now());
        serverTableRegistry.clear();

        const app = express();
        app.use(express.json());
        app.use(mountModTableRoutes(serverTableRegistry));
        const request = supertest(app);

        // GET an unregistered table — 404, no file touched.
        const getRes = await request.get('/api/campaigns/c1/mod-tables/mod.unknown.powers');
        expect(getRes.status).toBe(404);
        expect(getRes.body.error).toMatch(/Unknown mod table/);

        // No file was created on disk.
        for (const suffix of BUILTIN_CAMPAIGN_FILE_SUFFIXES) {
            expect(fs.existsSync(path.join(campaignsDir, `c1${suffix}`))).toBe(false);
        }

        // PUT to an unregistered table — 404, no file written.
        const putRes = await request.put('/api/campaigns/c1/mod-tables/mod.unknown.powers')
            .send([{ id: 'a' }]);
        expect(putRes.status).toBe(404);
        expect(fs.existsSync(path.join(campaignsDir, 'c1.mod-unknown-powers.json'))).toBe(false);
    });

    it('round-trips an array mod table through the dynamic pair', async () => {
        const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const { registerModTables } = await import('../lib/modTableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();

        // Register a mod table descriptor directly.
        registerModTables(serverTableRegistry, [{
            id: 'compendium',
            tables: [{ name: 'powers', recordShape: 'array' }],
        }]);

        const app = express();
        app.use(express.json());
        app.use(mountModTableRoutes(serverTableRegistry));
        const request = supertest(app);

        // GET on missing file → [] (array default).
        const getRes1 = await request.get('/api/campaigns/c1/mod-tables/mod.compendium.powers');
        expect(getRes1.status).toBe(200);
        expect(getRes1.body).toEqual([]);

        // PUT writes the array.
        await request.put('/api/campaigns/c1/mod-tables/mod.compendium.powers')
            .send([{ id: 'fireball', damage: '8d6' }]);

        // GET reads it back.
        const getRes2 = await request.get('/api/campaigns/c1/mod-tables/mod.compendium.powers');
        expect(getRes2.body).toEqual([{ id: 'fireball', damage: '8d6' }]);

        // File landed on disk at the computed suffix.
        const onDisk = JSON.parse(fs.readFileSync(path.join(campaignsDir, 'c1.mod-compendium-powers.json'), 'utf-8'));
        expect(onDisk).toEqual([{ id: 'fireball', damage: '8d6' }]);
    });

    it('round-trips a single-object mod table with null default', async () => {
        const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const { registerModTables } = await import('../lib/modTableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();

        registerModTables(serverTableRegistry, [{
            id: 'cfgmod',
            tables: [{ name: 'config', recordShape: 'single-object' }],
        }]);

        const app = express();
        app.use(express.json());
        app.use(mountModTableRoutes(serverTableRegistry));
        const request = supertest(app);

        const getRes1 = await request.get('/api/campaigns/c2/mod-tables/mod.cfgmod.config');
        expect(getRes1.status).toBe(200);
        expect(getRes1.body).toBeNull();

        await request.put('/api/campaigns/c2/mod-tables/mod.cfgmod.config')
            .send({ enabled: true });

        const getRes2 = await request.get('/api/campaigns/c2/mod-tables/mod.cfgmod.config');
        expect(getRes2.body).toEqual({ enabled: true });
    });

    it('a table that was registered then unregistered returns 404', async () => {
        const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const { registerModTables } = await import('../lib/modTableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();

        // First load: mod is present.
        registerModTables(serverTableRegistry, [{
            id: 'tempmod',
            tables: [{ name: 'data', recordShape: 'array' }],
        }]);

        const app = express();
        app.use(express.json());
        app.use(mountModTableRoutes(serverTableRegistry));
        const request = supertest(app);

        // Write data.
        await request.put('/api/campaigns/c1/mod-tables/mod.tempmod.data').send([{ id: 'x' }]);
        expect((await request.get('/api/campaigns/c1/mod-tables/mod.tempmod.data')).body).toEqual([{ id: 'x' }]);

        // Second load: mod is removed. The descriptor is unregistered.
        registerModTables(serverTableRegistry, []);

        // Now the route returns 404 — the table is no longer registered.
        const getRes = await request.get('/api/campaigns/c1/mod-tables/mod.tempmod.data');
        expect(getRes.status).toBe(404);
    });

    it('rejects an invalid campaign id', async () => {
        const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const { registerModTables } = await import('../lib/modTableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        registerModTables(serverTableRegistry, [{
            id: 'compendium',
            tables: [{ name: 'powers', recordShape: 'array' }],
        }]);

        const app = express();
        app.use(express.json());
        app.use(mountModTableRoutes(serverTableRegistry));
        const request = supertest(app);

        // An id with a slash is invalid (would traverse the filesystem).
        const res = await request.get('/api/campaigns/../etc/mod-tables/mod.compendium.powers');
        // Express treats /../etc as a path segment, so this becomes a 400 from
        // validateCampaignId or a 404. Either way, no file is read.
        expect(res.status).toBeGreaterThanOrEqual(400);
    });
});