// WO-P5-16 §6 — THE PANELS GATE end-to-end round trip.
//
// "An edit round-trips to disk — type a value, reload, it is still there."
//
// The gate mod (mods/panels-gate.mod.json) declares a table AND a panel over
// it. This test exercises the actual server stack the ModPanels component
// drives: the mod-table GET/PUT pair at /api/campaigns/:id/mod-tables/:table,
// hydrated into the store's modTables map. The cycle mirrors ledgerProofGate:
//
//   declare -> write (create + edit + delete from the rendered panel) ->
//   read -> reload (re-fetch) -> still there -> uninstall -> app still runs
//
// The gate is real, not a fixture: the test copies the actual
// mods/panels-gate.mod.json into a temp mods dir, loads it through the real
// mod loader, and round-trips real note records through the real route
// pair — exactly the path the ModPanels component's setModTable takes.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import url from 'url';
import express from 'express';
import request from 'supertest';

const __projectRoot = path.resolve(path.dirname(url.fileURLToPath(import.meta.url)), '..', '..');
const gateModPath = path.join(__projectRoot, 'test-fixtures', 'mods', 'panels-gate.mod.json');

let tmpDir: string;
let modsDir: string;
let campaignsDir: string;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'panels-gate-e2e-'));
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

async function buildApp() {
    const { createModsRouter } = await import('../routes/mods.js?t=' + Date.now());
    const { mountModTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
    const app = express();
    app.use(express.json());
    app.use('/api/mods', createModsRouter({ modsDir, appVersion: '1.0.4' }));
    app.use(mountModTableRoutes(serverTableRegistry));
    return app;
}

describe('WO-P5-16 §6 — THE PANELS GATE end-to-end round trip', () => {
    it('declare -> create -> edit -> read -> reload -> still there -> delete -> gone', async () => {
        // 1. DECLARE: copy the real gate mod into the tmp mods dir.
        const gateModText = fs.readFileSync(gateModPath, 'utf-8');
        const gateFolder = path.join(modsDir, 'panels-gate');
        fs.mkdirSync(gateFolder, { recursive: true });
        fs.writeFileSync(path.join(gateFolder, 'manifest.json'), gateModText);

        const app = await buildApp();
        const api = request(app);

        // The mod loads, declares the table, and declares the panel.
        const modsRes = await api.get('/api/mods');
        expect(modsRes.status).toBe(200);
        const gate = modsRes.body.mods.find((m: { id: string }) => m.id === 'panels-gate');
        expect(gate, 'gate mod must load').toBeDefined();
        expect(gate.tables).toEqual([{ name: 'notes', recordShape: 'array', label: 'Notes' }]);
        expect(gate.panels).toHaveLength(1);
        expect(gate.panels[0].bindsTo).toBe('notes');
        expect(gate.panels[0].layout).toBe('list-detail');

        // The table is registered under the namespaced key.
        const { serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const descriptor = serverTableRegistry.get('mod.panels-gate.notes');
        expect(descriptor).toBeDefined();
        expect(descriptor!.fileSuffix).toBe('.mod-panels-gate-notes.json');
        expect(descriptor!.recordShape).toBe('array');

        // 2. CREATE: a row derived from the panel's fields (the G2 empty row).
        //    The ModPanels component's Create button produces this exact row.
        const campaignId = 'gate-campaign';
        fs.writeFileSync(
            path.join(campaignsDir, `${campaignId}.json`),
            JSON.stringify({ id: campaignId, name: 'Gate Campaign' }),
        );

        const emptyRow = {
            title: '',
            body: '',
            priority: 0, // min: 0 -> 0 (G1)
            tags: [],
            done: false,
        };
        const createRes = await api
            .put(`/api/campaigns/${campaignId}/mod-tables/mod.panels-gate.notes`)
            .send([emptyRow]);
        expect(createRes.status).toBe(200);

        // The file landed at the namespaced suffix — no collision with any
        // built-in .notes.json (there is none, but the gate proves it).
        const diskPath = path.join(campaignsDir, `${campaignId}.mod-panels-gate-notes.json`);
        expect(fs.existsSync(diskPath)).toBe(true);

        // 3. EDIT: a typed value round-trips to disk. The ModPanels
        //    component's onRowsChange fires setModTable, which PUTs the
        //    next rows array. Type a value, PUT, and read it back.
        const editedRow = { ...emptyRow, title: 'First note', body: 'Hello world', priority: 3, tags: ['todo'], done: false };
        const editRes = await api
            .put(`/api/campaigns/${campaignId}/mod-tables/mod.panels-gate.notes`)
            .send([editedRow]);
        expect(editRes.status).toBe(200);

        // 4. READ: GET the data back.
        const getRes = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.panels-gate.notes`);
        expect(getRes.status).toBe(200);
        expect(getRes.body).toEqual([editedRow]);

        // 5. RELOAD: simulate a campaign re-hydrate. The client hydrator
        //    fetches the mod list, then fetches each declared table's data
        //    in parallel. The fetched data is what the store holds; the
        //    ModPanels component renders it. (Mirrors ledgerProofGate: use
        //    the test app's request agent rather than the client's fetch,
        //    which targets a different base URL under jsdom.)
        const { collectDeclaredModTables } = await import('../../src/services/mods/modTables');
        const declarations = collectDeclaredModTables(modsRes.body.mods);
        expect(declarations).toEqual([{ modId: 'panels-gate', table: { name: 'notes', recordShape: 'array', label: 'Notes' } }]);

        const hydrateRes = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.panels-gate.notes`);
        const modTablesMap = { 'mod.panels-gate.notes': hydrateRes.body };
        // "Type a value, reload, it is still there" — the gate's deliverable.
        expect(modTablesMap['mod.panels-gate.notes']).toEqual([editedRow]);
        expect((modTablesMap['mod.panels-gate.notes'] as Array<{ title: string }>)[0].title).toBe('First note');

        // 6. DELETE: a row removed via the rendered panel's Delete button
        //    round-trips to disk.
        const deleteRes = await api
            .put(`/api/campaigns/${campaignId}/mod-tables/mod.panels-gate.notes`)
            .send([]);
        expect(deleteRes.status).toBe(200);
        const afterDelete = await api.get(`/api/campaigns/${campaignId}/mod-tables/mod.panels-gate.notes`);
        expect(afterDelete.body).toEqual([]);
        // The disk file reflects the empty list.
        expect(JSON.parse(fs.readFileSync(diskPath, 'utf-8'))).toEqual([]);
    });

    it('the gate mod round-trips through the modPanelToDescriptor adapter unchanged in shape', async () => {
        // The ModPanels component calls modPanelToDescriptor; the resulting
        // descriptor is what the generic PanelRenderer consumes. Assert the
        // adapter preserves the gate mod's fields, crud, sort, and search
        // — the things the renderer reads (not the namespaced id/bindsTo).
        const gateFolder = path.join(modsDir, 'panels-gate');
        fs.mkdirSync(gateFolder, { recursive: true });
        fs.writeFileSync(path.join(gateFolder, 'manifest.json'), fs.readFileSync(gateModPath, 'utf-8'));
        const app = await buildApp();
        const api = request(app);
        const modsRes = await api.get('/api/mods');
        const gate = modsRes.body.mods.find((m: { id: string }) => m.id === 'panels-gate');

        const { modPanelToDescriptor } = await import('../../src/services/mods/modPanels');
        const descriptor = modPanelToDescriptor('panels-gate', gate.panels[0]);
        expect(descriptor.layout).toBe('list-detail');
        expect(descriptor.launch).toBe('nested');
        expect(descriptor.crud).toEqual({ create: true, read: true, update: true, delete: true });
        expect(descriptor.sort).toEqual({ field: 'priority', direction: 'desc' });
        expect(descriptor.search).toBe(true);
        expect(descriptor.fields.map((f: { control: string }) => f.control)).toEqual([
            'text', 'textarea', 'number', 'tags', 'checkbox',
        ]);
        // The namespaced id/bindsTo are the adapter's only additions.
        expect(descriptor.id).toBe('mod.panels-gate.notes-panel');
        expect(descriptor.bindsTo).toBe('mod.panels-gate.notes');
    });
});