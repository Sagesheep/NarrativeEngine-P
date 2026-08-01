import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

let tmpDir: string;
let campaignsDir: string;

describe('WO-P5-05 Step 5 — mod table transfer', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-table-transfer-'));
        vi.resetModules();
        vi.stubEnv('DATA_DIR', tmpDir);
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
        const { registerModTables } = await import('../lib/modTableRegistry.js');
        serverTableRegistry.clear();
        // Register a mod table so export includes it.
        registerModTables(serverTableRegistry, [{
            id: 'compendium',
            tables: [{ name: 'powers', recordShape: 'array' }],
        }]);
    });

    afterEach(async () => {
        const { serverTableRegistry } = await import('../lib/tableRegistry.js');
        serverTableRegistry.clear();
        vi.unstubAllEnvs();
        vi.doUnmock('../lib/embedder.js');
        vi.doUnmock('../lib/vectorStore.js');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exports a mod table and re-imports it when the mod is installed', async () => {
        const id = 'mod-export';
        const powers = [{ id: 'fireball', damage: '8d6' }, { id: 'shield', effect: 'absorb' }];
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'Mod Export' }));
        fs.writeFileSync(path.join(campaignsDir, `${id}.mod-compendium-powers.json`), JSON.stringify(powers));

        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        // Export the campaign.
        const exported = await request(app)
            .get(`/api/campaigns/${id}/export`)
            .expect(200);

        // The bundle includes the mod table under its bundle key.
        expect(exported.body['mod.compendium.powers']).toEqual(powers);

        // Import it back (the mod is still installed, so the key is known).
        const imported = await request(app)
            .post('/api/campaigns/import')
            .send(exported.body)
            .expect(200);

        // The mod table file was written for the new campaign id.
        const importedPath = path.join(campaignsDir, `${imported.body.id}.mod-compendium-powers.json`);
        expect(JSON.parse(fs.readFileSync(importedPath, 'utf-8'))).toEqual(powers);
    });

    it('preserves an unknown mod table key on import when the mod is NOT installed', async () => {
        // This is the §5 data-loss test: a user exports, uninstalls the mod,
        // and imports. The unknown bundle key must be preserved, not dropped.
        const id = 'unknown-export';
        const powers = [{ id: 'fireball' }];
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'Unknown Export' }));
        fs.writeFileSync(path.join(campaignsDir, `${id}.mod-compendium-powers.json`), JSON.stringify(powers));

        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        // Export with the mod installed.
        const exported = await request(app)
            .get(`/api/campaigns/${id}/export`)
            .expect(200);
        expect(exported.body['mod.compendium.powers']).toEqual(powers);

        // Now UNINSTALL the mod: clear the registry so the key is unknown.
        const { serverTableRegistry } = await import('../lib/tableRegistry.js');
        serverTableRegistry.clear();

        // Import with the mod NOT installed. The key must still be written.
        const imported = await request(app)
            .post('/api/campaigns/import')
            .send(exported.body)
            .expect(200);

        const importedPath = path.join(campaignsDir, `${imported.body.id}.mod-compendium-powers.json`);
        expect(fs.existsSync(importedPath)).toBe(true);
        expect(JSON.parse(fs.readFileSync(importedPath, 'utf-8'))).toEqual(powers);
    });

    it('does not invent a suffix for a non-mod-table unknown key', async () => {
        // A bundle key that does NOT match the mod.<modId>.<name> pattern must
        // not be written to disk — we do not invent a suffix for it.
        const id = 'weird-export';
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'Weird Export' }));

        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        const bundle = {
            version: 1,
            campaign: { id, name: 'Weird Export' },
            state: null,
            lore: [],
            npcs: [],
            enemies: [],
            enemyInstances: [],
            enemyEncounters: [],
            enemyResolutions: [],
            enemyCombatConfig: null,
            scenes: [],
            archiveIndex: [],
            chapters: [],
            facts: [],
            timeline: [],
            entities: [],
            // An unknown key that does NOT match the mod-table pattern.
            'someRandomKey': { data: 'should not be written' },
        };

        const imported = await request(app)
            .post('/api/campaigns/import')
            .send(bundle)
            .expect(200);

        // No file was created for the unknown key.
        expect(fs.existsSync(path.join(campaignsDir, `${imported.body.id}.someRandomKey.json`))).toBe(false);
    });
});