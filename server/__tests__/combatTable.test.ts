import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

let tmpDir: string;
let campaignsDir: string;

describe('core combat table', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'combat-table-'));
        vi.resetModules();
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildScenePassages: vi.fn(() => []),
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
        const { registerLocationTable } = await import('../lib/locationTable.js');
        const { registerCombatTable } = await import('../lib/combatTable.js');
        serverTableRegistry.clear();
        registerLocationTable(serverTableRegistry);
        registerCombatTable(serverTableRegistry);
        registerCombatTable(serverTableRegistry);
    });

    afterEach(async () => {
        const { serverTableRegistry } = await import('../lib/tableRegistry.js');
        serverTableRegistry.clear();
        vi.unstubAllEnvs();
        vi.doUnmock('../lib/embedder.js');
        vi.doUnmock('../lib/vectorStore.js');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('registers once as a single-object table with routes and transfer', async () => {
        const { serverTableRegistry, getCampaignFileSuffixes, isCampaignMetaFile, getTransferableTables } = await import('../lib/tableRegistry.js');
        const descriptor = serverTableRegistry.get('combat');
        expect(descriptor).toMatchObject({ fileSuffix: '.combat.json', recordShape: 'single-object' });
        expect(serverTableRegistry.list().filter((d: { name: string }) => d.name === 'combat')).toHaveLength(1);
        expect(getCampaignFileSuffixes()).toContain('.combat.json');
        expect(isCampaignMetaFile('abc.combat.json')).toBe(false);
        expect(getTransferableTables()).toContainEqual({
            bundleKey: 'combat', fileSuffix: '.combat.json', recordShape: 'single-object', name: 'combat',
        });
    });

    it('serves null when absent and round-trips a PUT', async () => {
        const { mountGenericTableRoutes } = await import('../lib/tableRegistry.js');
        const app = express();
        app.use(express.json());
        app.use(mountGenericTableRoutes());

        const empty = await request(app).get('/api/campaigns/c1/combat').expect(200);
        expect(empty.body).toBeNull();

        const record = { session: { id: 'fight-1', status: 'active' } };
        await request(app).put('/api/campaigns/c1/combat').send(record).expect(200);
        expect(JSON.parse(fs.readFileSync(path.join(campaignsDir, 'c1.combat.json'), 'utf-8'))).toEqual(record);

        const read = await request(app).get('/api/campaigns/c1/combat').expect(200);
        expect(read.body).toEqual(record);
    });

    it('round-trips combatSheet, combatConfig and the empty combat table through export and import', async () => {
        const id = 'combat-export';
        const context = {
            combatModeActive: true,
            combatConfig: {
                partyControl: 'solo', defeatMode: 'hardcore', narrationCadence: 'round',
                confirmStart: false, offerOnDangerous: true, resourceLabel: 'RAM',
                maxChainLength: 6, maxEquippedAbilities: 6, maxSummons: 2,
            },
            combatSheet: {
                abilities: { STR: 15, DEX: 14, CON: 14, INT: 8, WIS: 12, CHA: 10 },
                budget: 'NORMAL', archetype: 'skirmisher', level: 3, needsAllocation: false,
            },
        };
        const emptyTable = { session: null };
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'Combat Export' }));
        fs.writeFileSync(path.join(campaignsDir, `${id}.state.json`), JSON.stringify({ context, messages: [] }));
        fs.writeFileSync(path.join(campaignsDir, `${id}.combat.json`), JSON.stringify(emptyTable));

        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        const exported = await request(app).get(`/api/campaigns/${id}/export`).expect(200);
        expect(exported.body.combat).toEqual(emptyTable);
        expect(exported.body.state.context.combatSheet).toEqual(context.combatSheet);
        expect(exported.body.state.context.combatConfig).toEqual(context.combatConfig);

        const imported = await request(app).post('/api/campaigns/import').send(exported.body).expect(200);
        const newId = imported.body.id;
        expect(newId).toBeTruthy();

        const state = JSON.parse(fs.readFileSync(path.join(campaignsDir, `${newId}.state.json`), 'utf-8'));
        expect(state.context.combatSheet).toEqual(context.combatSheet);
        expect(state.context.combatConfig).toEqual(context.combatConfig);
        expect(state.context.combatModeActive).toBe(true);
        expect(JSON.parse(fs.readFileSync(path.join(campaignsDir, `${newId}.combat.json`), 'utf-8'))).toEqual(emptyTable);
    });

    it('exports no combat key for a campaign without a combat file', async () => {
        const id = 'no-combat';
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'No Combat' }));
        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());
        const exported = await request(app).get(`/api/campaigns/${id}/export`).expect(200);
        expect(exported.body).not.toHaveProperty('combat');
    });
});
