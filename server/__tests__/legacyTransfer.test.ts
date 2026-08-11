// Phase 8.5 — the two paths a campaign can arrive on that are not "it was
// already here": a transfer bundle, and a backup restore.
//
// Both are paths users treat as their safety net, and both were broken by the
// extraction in a way no error message would have mentioned. Export stopped
// reading the five enemy files when 8.2 deleted the routes, so a campaign that
// had not been adopted yet exported with its compendium silently missing; and a
// bundle written by a pre-extraction build carries keys (`enemies`,
// `enemyInstances`, …) that the post-extraction importer did not recognise and
// therefore dropped on the floor.
//
// The fix is one mechanism rather than two: the bundle keeps carrying the
// LEGACY keys, import writes the legacy FILES, and the ordinary adoption path
// picks them up on the first campaign open exactly as it would for a campaign
// that never moved.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

let tmpDir: string;
let campaignsDir: string;

const MONSTERS = [
    { id: 'a', name: 'Goblin', stats: [{ name: 'HP', value: '7' }] },
    { id: 'b', name: 'Owlbear', stats: [{ name: 'HP', value: '59' }] },
];
const COMBAT = { enabled: true, initiativeMode: 'd20', enemyDiscoveryEnabled: true };

/** The five tables the bundled `enemies` mod declares, with their adoptions. */
const ENEMY_MOD = {
    id: 'enemies',
    tables: [
        { name: 'compendium', recordShape: 'array', migrateFrom: '.enemies.json' },
        { name: 'instances', recordShape: 'array', migrateFrom: '.enemy-instances.json' },
        { name: 'encounters', recordShape: 'array', migrateFrom: '.enemy-encounters.json' },
        { name: 'resolutions', recordShape: 'array', migrateFrom: '.enemy-resolutions.json' },
        { name: 'config', recordShape: 'single-object', migrateFrom: '.enemy-combat.json' },
    ],
};

async function buildApp(withMod = true) {
    const { serverTableRegistry } = await import('../lib/tableRegistry.js');
    const { registerModTables } = await import('../lib/modTableRegistry.js');
    serverTableRegistry.clear();
    if (withMod) registerModTables(serverTableRegistry, [ENEMY_MOD]);

    const { createTransferRouter } = await import('../routes/transfer.js');
    const { createCampaignsRouter } = await import('../routes/campaigns.js');
    const { mountModTableRoutes } = await import('../lib/tableRegistry.js');
    const app = express();
    app.use(express.json({ limit: '50mb' }));
    app.use(createCampaignsRouter());
    app.use(createTransferRouter());
    app.use(mountModTableRoutes());
    return app;
}

function write(id: string, suffix: string, data: unknown) {
    fs.writeFileSync(path.join(campaignsDir, `${id}${suffix}`), JSON.stringify(data), 'utf-8');
}
function read(id: string, suffix: string) {
    const p = path.join(campaignsDir, `${id}${suffix}`);
    return fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf-8')) : undefined;
}

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-transfer-'));
    vi.resetModules();
    vi.stubEnv('DATA_DIR', tmpDir);
    vi.doMock('../lib/embedder.js', () => ({
        embedText: vi.fn(), buildArchiveText: vi.fn(), buildLoreText: vi.fn(), resolveIndexingSpeed: vi.fn(),
    }));
    vi.doMock('../lib/vectorStore.js', () => ({
        storeArchiveEmbedding: vi.fn(), storeLoreEmbedding: vi.fn(), deleteCampaignEmbeddings: vi.fn(),
        listArchiveSceneIds: vi.fn(() => []), deleteArchiveEmbedding: vi.fn(),
    }));
    vi.doMock('../lib/embedJobs.js', () => ({ startJob: vi.fn(), tickJob: vi.fn(), endJob: vi.fn() }));

    const store = await import('../lib/fileStore.js');
    campaignsDir = store.CAMPAIGNS_DIR;
    fs.mkdirSync(campaignsDir, { recursive: true });
});

afterEach(async () => {
    const { serverTableRegistry } = await import('../lib/tableRegistry.js');
    serverTableRegistry.clear();
    vi.unstubAllEnvs();
    vi.doUnmock('../lib/embedder.js');
    vi.doUnmock('../lib/vectorStore.js');
    vi.doUnmock('../lib/embedJobs.js');
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('export carries retired campaign files', () => {
    it('exports an unadopted campaign under the PRE-extraction bundle keys', async () => {
        const id = 'unadopted';
        write(id, '.json', { id, name: 'Old Save' });
        write(id, '.enemies.json', MONSTERS);
        write(id, '.enemy-combat.json', COMBAT);

        const res = await request(await buildApp()).get(`/api/campaigns/${id}/export`).expect(200);

        // The keys are the ones a pre-8.2 build wrote and reads. Renaming one
        // would break every bundle already sitting in somebody's downloads.
        expect(res.body.enemies).toEqual(MONSTERS);
        expect(res.body.enemyCombatConfig).toEqual(COMBAT);
        // A file the campaign never had produces no key, rather than an empty one.
        expect(res.body).not.toHaveProperty('enemyInstances');
    });

    it('exports an adopted campaign with the mod tables AND the ledger', async () => {
        const id = 'adopted';
        write(id, '.json', { id, name: 'Migrated' });
        write(id, '.enemies.json', MONSTERS);
        const app = await buildApp();

        // Open it once — the hydrator's read is what performs the adoption.
        await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(200);

        const res = await request(app).get(`/api/campaigns/${id}/export`).expect(200);
        expect(res.body['mod.enemies.compendium']).toEqual(MONSTERS);
        expect(res.body.enemies).toEqual(MONSTERS);          // the rollback copy travels too
        expect(res.body.migrations.adopted['mod.enemies.compendium'].from).toBe('.enemies.json');
    });

    it('exports no migrations key for a campaign that has never adopted anything', async () => {
        const id = 'fresh';
        write(id, '.json', { id, name: 'New' });
        const res = await request(await buildApp()).get(`/api/campaigns/${id}/export`).expect(200);
        expect(res.body).not.toHaveProperty('migrations');
    });
});

describe('exported before the extraction, imported after', () => {
    it('lands the legacy files and adopts them on the first campaign open', async () => {
        // Exactly what a pre-8.2 build wrote: legacy keys, no mod tables, no
        // ledger. Constructed by hand rather than round-tripped, because the
        // build that produced it no longer exists to produce it.
        const bundle = {
            version: 1,
            exportedAt: Date.now(),
            campaign: { id: 'fromold', name: 'Pre-extraction Save' },
            state: null,
            enemies: MONSTERS,
            enemyInstances: [{ id: 'i1', templateId: 'a', displayName: 'Goblin #1' }],
            enemyEncounters: [],
            enemyResolutions: [],
            enemyCombatConfig: COMBAT,
        };

        const app = await buildApp();
        const imported = await request(app).post('/api/campaigns/import').send(bundle).expect(200);
        const id = imported.body.id;

        // The legacy files are on disk, under the app's own suffixes.
        expect(read(id, '.enemies.json')).toEqual(MONSTERS);
        expect(read(id, '.enemy-combat.json')).toEqual(COMBAT);
        // Empty arrays are not written — matching the pre-8.2 importer, which
        // wrote each file only when it had records.
        expect(read(id, '.enemy-encounters.json')).toBeUndefined();

        // Nothing has been adopted yet: import writes files, the campaign open
        // adopts them. One mechanism, and it is the same one a campaign that
        // never left this machine goes through.
        expect(read(id, '.mod-enemies-compendium.json')).toBeUndefined();

        const table = await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(200);
        expect(table.body).toEqual(MONSTERS);
        expect(read(id, '.mod-enemies-compendium.json')).toEqual(MONSTERS);

        const ledger = await request(app).get(`/api/campaigns/${id}/migrations`).expect(200);
        expect(ledger.body.adopted['mod.enemies.compendium'].records).toBe(2);
        expect(ledger.body.failures).toEqual({});
    });

    it('round-trips an unadopted campaign export → import → open with the data intact', async () => {
        const id = 'roundtrip';
        write(id, '.json', { id, name: 'Round Trip' });
        write(id, '.enemies.json', MONSTERS);
        const app = await buildApp();

        const exported = await request(app).get(`/api/campaigns/${id}/export`).expect(200);
        const imported = await request(app).post('/api/campaigns/import').send(exported.body).expect(200);
        const newId = imported.body.id;
        expect(newId).not.toBe(id); // id collision → new id, and the data follows it

        const table = await request(app).get(`/api/campaigns/${newId}/mod-tables/mod.enemies.compendium`).expect(200);
        expect(table.body).toEqual(MONSTERS);
    });

    it('does not re-adopt when the bundle already carried the ledger and the mod tables', async () => {
        const bundle = {
            version: 1,
            campaign: { id: 'alreadymigrated', name: 'Migrated Elsewhere' },
            // The legacy copy is stale: the user edited monsters after adopting.
            enemies: MONSTERS,
            'mod.enemies.compendium': [{ id: 'a', name: 'Goblin Chief' }],
            migrations: { version: 1, adopted: { 'mod.enemies.compendium': { from: '.enemies.json', at: 1, records: 2 } }, failures: {} },
        };

        const app = await buildApp();
        const imported = await request(app).post('/api/campaigns/import').send(bundle).expect(200);
        const id = imported.body.id;

        const table = await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(200);
        // The mod's table wins. Without the ledger travelling, the stale legacy
        // copy would overwrite the user's later edits on the far side.
        expect(table.body).toEqual([{ id: 'a', name: 'Goblin Chief' }]);
    });

    it('ignores a hostile migrations key rather than writing it verbatim', async () => {
        const bundle = {
            version: 1,
            campaign: { id: 'hostile', name: 'Hostile' },
            migrations: { adopted: 'not-an-object', failures: [1, 2, 3], somethingElse: { drop: 'me' } },
        };
        const app = await buildApp();
        const imported = await request(app).post('/api/campaigns/import').send(bundle).expect(200);

        const ledger = await request(app).get(`/api/campaigns/${imported.body.id}/migrations`).expect(200);
        expect(ledger.body).toEqual({ version: 1, adopted: {}, failures: {} });
        expect(ledger.body).not.toHaveProperty('somethingElse');
    });
});

describe('the mod is not installed', () => {
    it('leaves the legacy files dormant and still opens the campaign', async () => {
        const id = 'nomod';
        write(id, '.json', { id, name: 'No Mod' });
        write(id, '.enemies.json', MONSTERS);

        const app = await buildApp(false); // the mod folder is gone (Phase 8.6's gate)

        // No descriptor → 404 before any path is built. Nothing is adopted.
        await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(404);
        expect(read(id, '.mod-enemies-compendium.json')).toBeUndefined();
        expect(fs.existsSync(path.join(campaignsDir, `${id}.migrations.json`))).toBe(false);

        // Dormant, not destroyed — and export still carries it out.
        await request(app).get(`/api/campaigns/${id}`).expect(200);
        const res = await request(app).get(`/api/campaigns/${id}/export`).expect(200);
        expect(res.body.enemies).toEqual(MONSTERS);
    });
});

describe('backup and restore across the extraction', () => {
    it('restoring a pre-migration backup re-adopts on the next open', async () => {
        const id = 'restorable';
        write(id, '.json', { id, name: 'Restorable' });
        write(id, '.enemies.json', MONSTERS);

        const { createBackup, restoreBackup } = await import('../services/backup.js');
        // A backup taken before the extraction: legacy file, no mod table, no ledger.
        const backup = createBackup(id, { label: 'pre-extraction', trigger: 'manual' });

        const app = await buildApp();
        await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(200);
        // The user then edits their compendium through the mod.
        write(id, '.mod-enemies-compendium.json', [{ id: 'z', name: 'Something Else' }]);

        restoreBackup(id, String(backup.timestamp));

        // Restore replaces the campaign's file set: the mod table and the
        // ledger were not in the backup, so they are gone, and the campaign is
        // back at the state the backup captured.
        expect(read(id, '.mod-enemies-compendium.json')).toBeUndefined();
        expect(fs.existsSync(path.join(campaignsDir, `${id}.migrations.json`))).toBe(false);
        expect(read(id, '.enemies.json')).toEqual(MONSTERS);

        // And opening it adopts again, from the restored legacy file.
        const table = await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(200);
        expect(table.body).toEqual(MONSTERS);
    });

    it('backs up the mod tables and the ledger once a campaign has adopted', async () => {
        const id = 'backedup';
        write(id, '.json', { id, name: 'Backed Up' });
        write(id, '.enemies.json', MONSTERS);

        const app = await buildApp();
        await request(app).get(`/api/campaigns/${id}/mod-tables/mod.enemies.compendium`).expect(200);

        const { createBackup } = await import('../services/backup.js');
        const backup = createBackup(id, { label: 'post-migration', trigger: 'manual' });
        const files = fs.readdirSync(path.join(tmpDir, 'backups', id, String(backup.timestamp)));

        expect(files).toContain(`${id}.enemies.json`);
        expect(files).toContain(`${id}.mod-enemies-compendium.json`);
        expect(files).toContain(`${id}.migrations.json`);
    });
});

