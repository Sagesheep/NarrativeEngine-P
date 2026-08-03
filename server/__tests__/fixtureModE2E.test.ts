// WO-P5-05 Step 6 — fixture mod end-to-end round trip.
//
// This is the proof of the work order's Definition of Done: a throwaway
// .mod.json declaring one table, round-tripped end to end through the real
// server pipeline (loadMods → registerModTables → mod-table routes →
// transfer export/import), including the unknown-key preservation case (§5).
//
// The fixture mod declares a `powers` table (recordShape: array). The test:
//   1. DECLARE: writes the .mod.json to disk
//   2. WRITE: PUTs data through the /mod-tables/ route
//   3. READ: GETs it back through the same route
//   4. HYDRATE: simulates client hydration (collectDeclaredModTables + fetch)
//   5. EXPORT: GET /api/campaigns/:id/export
//   6. IMPORT: POST /api/campaigns/import — with the mod uninstalled (unknown key)
//
// The fixture mod is NOT a real feature; that is work order 2.4.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

let tmpDir: string;
let modsDir: string;
let campaignsDir: string;

/** The fixture mod: declares one `powers` table. Throwaway; not a real mod. */
const fixtureMod = {
    id: 'fixture-compendium',
    name: 'Fixture Compendium',
    version: '0.1.0',
    description: 'Throwaway fixture mod for WO-P5-05 end-to-end testing.',
    contributions: [{ id: 'tone', order: 250, text: 'Fixture tone.' }],
    tables: [{ name: 'powers', recordShape: 'array', label: 'Powers' }],
};

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-fixture-e2e-'));
    modsDir = path.join(tmpDir, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    process.env.DATA_DIR = tmpDir;
    process.env.MODS_DIR = modsDir;
    vi.resetModules();
    vi.doMock('../lib/embedder.js', () => ({
        embedText: vi.fn(),
        buildArchiveText: vi.fn(),
        buildLoreText: vi.fn(),
    }));
    vi.doMock('../lib/vectorStore.js', () => ({
        storeArchiveEmbedding: vi.fn(),
        storeLoreEmbedding: vi.fn(),
    }));
    const store = await import('../lib/fileStore.js');
    campaignsDir = store.CAMPAIGNS_DIR;
    fs.mkdirSync(campaignsDir, { recursive: true });
    const { serverTableRegistry } = await import('../lib/tableRegistry.js');
    serverTableRegistry.clear();
});

afterEach(async () => {
    const { serverTableRegistry } = await import('../lib/tableRegistry.js');
    serverTableRegistry.clear();
    delete process.env.DATA_DIR;
    delete process.env.MODS_DIR;
    vi.unstubAllEnvs();
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Build the full server app: mods router (which registers mod tables on
 * request), mod-table dynamic routes, and transfer router. Mirrors the
 * mounting order in server.js.
 */
async function buildApp() {
    const { createModsRouter } = await import('../routes/mods.js?t=' + Date.now());
    const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
    const { createTransferRouter } = await import('../routes/transfer.js?t=' + Date.now());
    const app = express();
    app.use(express.json());
    // The mods router registers mod tables into serverTableRegistry on each
    // request, so the mod-table routes (which look up the registry at request
    // time) see them after the first /api/mods hit.
    app.use('/api/mods', createModsRouter({ modsDir, appVersion: '1.0.4' }));
    app.use(mountModTableRoutes(serverTableRegistry));
    app.use(createTransferRouter());
    return app;
}

describe('WO-P5-05 Step 6 — fixture mod end-to-end round trip', () => {
    it('declare → write → read → hydrate → export → import (unknown key preserved)', async () => {
        // 1. DECLARE: write the fixture mod to disk.
        const fixtureFolder = path.join(modsDir, 'fixture-compendium');
        fs.mkdirSync(fixtureFolder, { recursive: true });
        fs.writeFileSync(path.join(fixtureFolder, 'manifest.json'), JSON.stringify(fixtureMod, null, 2));

        const app = await buildApp();
        const api = request(app);

        // Hit /api/mods so the mod table gets registered. The loader validates
        // the tables array; the route calls registerModTables.
        const modsRes = await api.get('/api/mods');
        expect(modsRes.status).toBe(200);
        expect(modsRes.body.mods).toHaveLength(1);
        expect(modsRes.body.mods[0].tables).toEqual([{ name: 'powers', recordShape: 'array', label: 'Powers' }]);
        expect(modsRes.body.faults).toEqual([]);

        // 2. WRITE: PUT data through the /mod-tables/ route.
        const campaignId = 'fixture-campaign';
        const powers = [
            { id: 'fireball', damage: '8d6', level: 3 },
            { id: 'magic-missile', damage: '1d4+1', level: 1 },
        ];
        fs.writeFileSync(path.join(campaignsDir, `${campaignId}.json`), JSON.stringify({ id: campaignId, name: 'Fixture Campaign' }));

        const putRes = await api.put(`/api/campaigns/${campaignId}/mod-tables/mod.fixture-compendium.powers`)
            .send(powers);
        expect(putRes.status).toBe(200);

        // The file landed on disk at the computed suffix.
        const diskPath = path.join(campaignsDir, `${campaignId}.mod-fixture-compendium-powers.json`);
        expect(JSON.parse(fs.readFileSync(diskPath, 'utf-8'))).toEqual(powers);

        // 3. READ: GET the data back through the same route.
        const getRes = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.fixture-compendium.powers`);
        expect(getRes.status).toBe(200);
        expect(getRes.body).toEqual(powers);

        // 4. HYDRATE: simulate client hydration. The client fetches the mod
        // list, then fetches each declared table's data in parallel.
        const { collectDeclaredModTables } = await import('../../src/services/mods/modTables');
        const declarations = collectDeclaredModTables(modsRes.body.mods);
        expect(declarations).toEqual([{ modId: 'fixture-compendium', table: { name: 'powers', recordShape: 'array', label: 'Powers' } }]);

        // Fetch the table data through the route (as the client would).
        const hydrateRes = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.fixture-compendium.powers`);
        const modTablesMap = { 'mod.fixture-compendium.powers': hydrateRes.body };
        expect(modTablesMap['mod.fixture-compendium.powers']).toEqual(powers);

        // 5. EXPORT: GET /api/campaigns/:id/export. The bundle includes the
        // mod table under its bundle key.
        const exportRes = await api.get(`/api/campaigns/${campaignId}/export`);
        expect(exportRes.status).toBe(200);
        expect(exportRes.body['mod.fixture-compendium.powers']).toEqual(powers);

        // 6. IMPORT (unknown key preserved): clear the registry so the mod is
        // "not installed", then import. The unknown bundle key must be written.
        const { serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();

        const importRes = await api.post('/api/campaigns/import').send(exportRes.body);
        expect(importRes.status).toBe(200);
        const newId = importRes.body.id;

        // The mod table file was written even though the mod is not installed.
        const importedPath = path.join(campaignsDir, `${newId}.mod-fixture-compendium-powers.json`);
        expect(fs.existsSync(importedPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(importedPath, 'utf-8'))).toEqual(powers);
    });

    it('an unregistered table name is a 404 with no file written', async () => {
        const app = await buildApp();
        const api = request(app);

        // No mod installed → no tables registered.
        const getRes = await api.get('/api/campaigns/c1/mod-tables/mod.unknown.table');
        expect(getRes.status).toBe(404);
        expect(getRes.body.error).toMatch(/Unknown mod table/);

        const putRes = await api.put('/api/campaigns/c1/mod-tables/mod.unknown.table').send([{ id: 'x' }]);
        expect(putRes.status).toBe(404);
        expect(fs.existsSync(path.join(campaignsDir, 'c1.mod-unknown-table.json'))).toBe(false);
    });

    it('serverSchema/clientSchema are absent on the mod table descriptor', async () => {
        // §2 Definition of Done: assert in a test that the mod descriptor never
        // carries serverSchema/clientSchema.
        const fixtureFolder = path.join(modsDir, 'fixture-compendium');
        fs.mkdirSync(fixtureFolder, { recursive: true });
        fs.writeFileSync(path.join(fixtureFolder, 'manifest.json'), JSON.stringify(fixtureMod));
        const app = await buildApp();
        await request(app).get('/api/mods');

        const { serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const descriptor = serverTableRegistry.get('mod.fixture-compendium.powers');
        expect(descriptor).toBeDefined();
        expect(descriptor!.serverSchema).toBeUndefined();
        expect(descriptor!.clientSchema).toBeUndefined();
        expect(descriptor!.hooks).toBeUndefined();
    });
});