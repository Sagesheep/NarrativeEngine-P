// WO-P5-06 — THE TABLES GATE — proof mod round trip with real location records.
//
// This is the gate's first deliverable: a real table of ours (the Location
// Ledger's storage) re-expressed as a mod-declared table, round-tripped end
// to end with REAL location records (not {a:1}). The cycle is exactly the
// work order's §3:
//
//   declare -> write -> read -> hydrate -> export -> uninstall -> import
//
// The proof mod is `mods/ledger-proof.mod.json` — it declares one table
// `locations` (recordShape: array). The built-in Location Ledger stays
// exactly as it is; this mod's table lands at
// `.mod-ledger-proof-locations.json` — a different file, a different bundle
// key (`mod.ledger-proof.locations`), no collision (the `mod-` prefix
// guarantees it).
//
// The location records are real `LocationEntry` objects taken from a real
// campaign on disk (data/campaigns/*.locations.json), so the test exercises
// the actual shape the built-in ledger stores — not a toy.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';
import express from 'express';
import request from 'supertest';

const __projectRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const proofModPath = path.join(__projectRoot, 'test-fixtures', 'mods', 'ledger-proof.mod.json');

let tmpDir: string;
let modsDir: string;
let campaignsDir: string;

/** Two real LocationEntry records, taken from a real campaign on disk. */
const realLocations = [
    {
        id: 'loc_1784610556018_ztn5s',
        name: 'An unnamed village',
        aliases: '',
        broadLocation: 'Taihang foothills, Qing Province',
        features: ['central well', 'large house with oil lamp', 'packed-earth lane between rows of mud-walled houses', 'Taihang foothills'],
        connections: [],
        description: 'A small farming village at the foot of the Taihang hills in Qing Province, with mud-and-timber houses, a central well, and a dirt lane under a summer night sky.',
        firstSeenScene: '1784610556018',
        lastSeenScene: '1784613157115',
        source: 'llm',
    },
    {
        id: 'loc_1784684120805_olt5p',
        name: 'Streets of Ye',
        aliases: '',
        broadLocation: 'Ye, Wei Commandery',
        features: ['street', 'north gate', 'market'],
        connections: [],
        description: 'The dusty, packed-earth streets of Ye wind through mud-walled buildings and vendor stalls, bustling at dawn as the city wakes to the smell of sesame and sewage. The north gate looms at the end of the main thoroughfare, flanked by timber and iron.',
        firstSeenScene: '1784684120805',
        lastSeenScene: '1784684120805',
        source: 'llm',
    },
];

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-table-gate-'));
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
 * each request), mod-table dynamic routes, and transfer router. Mirrors the
 * mounting order in server.js. The built-in Location Ledger is NOT
 * registered here — the gate is about the mod path only, and the built-in
 * stays untouched (WO-P5-06 §3 "Do NOT delete, replace, or unregister the
 * built-in Location Ledger").
 */
async function buildApp() {
    const { createModsRouter } = await import('../routes/mods.js?t=' + Date.now());
    const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
    const { createTransferRouter } = await import('../routes/transfer.js?t=' + Date.now());
    const app = express();
    app.use(express.json());
    app.use('/api/mods', createModsRouter({ modsDir, appVersion: '1.0.4' }));
    app.use(mountModTableRoutes(serverTableRegistry));
    app.use(createTransferRouter());
    return app;
}

describe('WO-P5-06 — THE TABLES GATE — proof mod round trip', () => {
    it('declare -> write -> read -> hydrate -> export -> uninstall -> import (real location records)', async () => {
        // 1. DECLARE: copy the real proof mod from mods/ledger-proof.mod.json
        //    into the tmp mods dir. The test exercises the actual shipped file.
        const proofModText = fs.readFileSync(proofModPath, 'utf-8');
        const proofFolder = path.join(modsDir, 'ledger-proof');
        fs.mkdirSync(proofFolder, { recursive: true });
        fs.writeFileSync(path.join(proofFolder, 'manifest.json'), proofModText);

        const app = await buildApp();
        const api = request(app);

        // Hit /api/mods so the mod table gets registered. The loader validates
        // the tables array; the route calls registerModTables.
        const modsRes = await api.get('/api/mods');
        expect(modsRes.status).toBe(200);
        expect(modsRes.body.mods).toHaveLength(1);
        expect(modsRes.body.mods[0].id).toBe('ledger-proof');
        expect(modsRes.body.mods[0].tables).toEqual([
            { name: 'locations', recordShape: 'array', label: 'Locations (mod)' },
        ]);
        expect(modsRes.body.faults).toEqual([]);

        // The descriptor is registered under the namespaced name, with the
        // computed suffix `.mod-ledger-proof-locations.json`.
        const { serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const descriptor = serverTableRegistry.get('mod.ledger-proof.locations');
        expect(descriptor).toBeDefined();
        expect(descriptor!.fileSuffix).toBe('.mod-ledger-proof-locations.json');
        expect(descriptor!.recordShape).toBe('array');
        // §2 "Also non-negotiable": a mod table supplies no functions.
        expect(descriptor!.serverSchema).toBeUndefined();
        expect(descriptor!.clientSchema).toBeUndefined();
        expect(descriptor!.hooks).toBeUndefined();

        // 2. WRITE: PUT real location records through the /mod-tables/ route.
        const campaignId = 'gate-campaign';
        fs.writeFileSync(
            path.join(campaignsDir, `${campaignId}.json`),
            JSON.stringify({ id: campaignId, name: 'Gate Campaign' }),
        );

        const putRes = await api
            .put(`/api/campaigns/${campaignId}/mod-tables/mod.ledger-proof.locations`)
            .send(realLocations);
        expect(putRes.status).toBe(200);

        // The file landed on disk at the computed suffix — NOT .locations.json
        // (the built-in) but .mod-ledger-proof-locations.json. No collision.
        const diskPath = path.join(campaignsDir, `${campaignId}.mod-ledger-proof-locations.json`);
        expect(fs.existsSync(diskPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(diskPath, 'utf-8'))).toEqual(realLocations);

        // The built-in .locations.json was NOT touched.
        expect(fs.existsSync(path.join(campaignsDir, `${campaignId}.locations.json`))).toBe(false);

        // 3. READ: GET the data back through the same route.
        const getRes = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.ledger-proof.locations`);
        expect(getRes.status).toBe(200);
        expect(getRes.body).toEqual(realLocations);

        // 4. HYDRATE: simulate client hydration. The client fetches the mod
        //    list, then fetches each declared table's data in parallel.
        const { collectDeclaredModTables } = await import('../../src/services/mods/modTables');
        const declarations = collectDeclaredModTables(modsRes.body.mods);
        expect(declarations).toEqual([
            { modId: 'ledger-proof', table: { name: 'locations', recordShape: 'array', label: 'Locations (mod)' } },
        ]);

        const hydrateRes = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.ledger-proof.locations`);
        const modTablesMap = { 'mod.ledger-proof.locations': hydrateRes.body };
        expect(modTablesMap['mod.ledger-proof.locations']).toEqual(realLocations);

        // 5. EXPORT: GET /api/campaigns/:id/export. The bundle includes the
        //    mod table under its bundle key (`mod.ledger-proof.locations`).
        const exportRes = await api.get(`/api/campaigns/${campaignId}/export`);
        expect(exportRes.status).toBe(200);
        expect(exportRes.body['mod.ledger-proof.locations']).toEqual(realLocations);

        // 6. UNINSTALL: clear the registry so the mod is "not installed".
        //    Then 7. IMPORT: the unknown bundle key must be preserved (§5).
        serverTableRegistry.clear();

        const importRes = await api.post('/api/campaigns/import').send(exportRes.body);
        expect(importRes.status).toBe(200);
        const newId = importRes.body.id;

        // The mod table file was written even though the mod is not installed.
        // Data survived export -> uninstall -> import.
        const importedPath = path.join(campaignsDir, `${newId}.mod-ledger-proof-locations.json`);
        expect(fs.existsSync(importedPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(importedPath, 'utf-8'))).toEqual(realLocations);
    });

    it('the proof mod and the built-in locations table do not collide on disk', async () => {
        // Belt-and-braces for §3's "no collision" guarantee. The mod- prefix
        // makes this unreachable by construction; we assert it anyway because
        // a collision here is a data-loss bug in 2.3 (WO-P5-06 §7 stop
        // condition).
        const proofModText = fs.readFileSync(proofModPath, 'utf-8');
        const proofFolder = path.join(modsDir, 'ledger-proof');
        fs.mkdirSync(proofFolder, { recursive: true });
        fs.writeFileSync(path.join(proofFolder, 'manifest.json'), proofModText);

        const app = await buildApp();
        await request(app).get('/api/mods');

        const { serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const modDescriptor = serverTableRegistry.get('mod.ledger-proof.locations');
        expect(modDescriptor).toBeDefined();
        expect(modDescriptor!.fileSuffix).toBe('.mod-ledger-proof-locations.json');

        // The built-in suffix is `.locations.json`. The mod suffix is
        // `.mod-ledger-proof-locations.json`. They are string-distinct.
        expect(modDescriptor!.fileSuffix).not.toBe('.locations.json');
        // And the mod suffix carries the mod- prefix.
        expect(modDescriptor!.fileSuffix.startsWith('.mod-')).toBe(true);
    });

    it('with the proof mod removed, no mod tables are registered', async () => {
        // §6 gate: "With the proof mod removed: 18 suffixes, and the app is
        // byte-identical to today." This test confirms the registry side: with
        // no mod files in the mods dir, no mod tables register. The 18-suffix
        // assertion lives in the existing tableRegistry test suite.
        const app = await buildApp();
        const modsRes = await request(app).get('/api/mods');
        expect(modsRes.status).toBe(200);
        expect(modsRes.body.mods).toEqual([]);
        expect(modsRes.body.faults).toEqual([]);

        const { serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        expect(serverTableRegistry.list()).toEqual([]);
    });
});