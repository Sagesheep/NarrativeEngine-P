import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir;

describe('enemy compendium campaign files', () => {
    // Isolate file-store imports so DATA_DIR is resolved independently per test.
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'enemy-compendium-'));
        vi.resetModules();
    });

    // Remove only the temporary campaign directory created by this test.
    afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

    it('includes .enemies.json in campaign backup file discovery', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.enemies.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.enemies.json');
    });

    it('includes .enemy-instances.json in campaign backup file discovery', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.enemy-instances.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.enemy-instances.json');
    });

    it('includes .enemy-encounters.json in campaign backup file discovery', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.enemy-encounters.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.enemy-encounters.json');
    });

    it('includes .enemy-combat.json in campaign backup file discovery', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.enemy-combat.json'), '{}');
        expect(store.campaignFiles('test')).toContain('test.enemy-combat.json');
    });

    it('includes .enemy-resolutions.json in campaign backup file discovery', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.enemy-resolutions.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.enemy-resolutions.json');
    });

    it('normalizes nullable enemy fields and rejects malformed field shapes through the API', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createCampaignsRouter } = await import('../routes/campaigns.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createCampaignsRouter());

        await request(app).put('/api/campaigns/test/enemies').send([{
            name: 'Royal Duelist',
            tags: null,
            stats: null,
            actions: [{ name: 'Riposte', description: null }],
        }]).expect(200);
        const saved = await request(app).get('/api/campaigns/test/enemies').expect(200);
        expect(saved.body[0]).toEqual(expect.objectContaining({
            name: 'Royal Duelist',
            tags: [],
            stats: [],
            actions: [{ name: 'Riposte', description: '' }],
        }));

        const rejected = await request(app).put('/api/campaigns/test/enemies')
            .send([{ name: 'Broken Orc', tags: 'melee' }])
            .expect(400);
        expect(rejected.body.details).toContain('enemies[0].tags must be an array or null');
    });

    it('persists enemy instances through the campaign API', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createCampaignsRouter } = await import('../routes/campaigns.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createCampaignsRouter());
        const instances = [{ id: 'copy-1', displayName: 'Scout Gunner #1', currentHp: 45 }];

        await request(app).put('/api/campaigns/test/enemy-instances').send(instances).expect(200);
        const response = await request(app).get('/api/campaigns/test/enemy-instances').expect(200);

        // Validation backfills safe defaults (templateSnapshot, numeric fields, arrays).
        // A missing templateSnapshot backfills a default whose name mirrors the
        // instance's displayName so the combat UI shows a sensible label.
        expect(response.body).toHaveLength(1);
        expect(response.body[0]).toMatchObject({
            id: 'copy-1',
            displayName: 'Scout Gunner #1',
            currentHp: 45,
            maxHp: 0,
            currentBarrier: 0,
            maxBarrier: 0,
            defeated: false,
            actionsRemaining: 0,
            actionsPerTurn: 1,
            conditions: [],
            cooldowns: [],
            resources: [],
            temporaryModifiers: [],
        });
        expect(response.body[0].templateSnapshot).toMatchObject({ name: 'Scout Gunner #1' });
    });

    it('rejects malformed enemy instances through the campaign API', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createCampaignsRouter } = await import('../routes/campaigns.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createCampaignsRouter());

        const rejected = await request(app).put('/api/campaigns/test/enemy-instances')
            .send([{ currentHp: 'not-a-number' }])
            .expect(400);
        expect(rejected.body.details.some(d => d.includes('currentHp'))).toBe(true);
    });

    it('persists enemy encounters through the campaign API', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createCampaignsRouter } = await import('../routes/campaigns.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createCampaignsRouter());
        const encounters = [{ id: 'encounter-1', name: 'Tutorial', status: 'active', waves: [] }];

        await request(app).put('/api/campaigns/test/enemy-encounters').send(encounters).expect(200);
        const response = await request(app).get('/api/campaigns/test/enemy-encounters').expect(200);

        // Validation backfills safe defaults (activeWaveId, timestamps).
        expect(response.body).toHaveLength(1);
        expect(response.body[0]).toMatchObject({
            id: 'encounter-1',
            name: 'Tutorial',
            status: 'active',
            waves: [],
        });
    });

    it('persists enemy combat configuration through the campaign API', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createCampaignsRouter } = await import('../routes/campaigns.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createCampaignsRouter());
        const config = { enabled: true, initiativeMode: 'd20', actionsEnabled: true };

        await request(app).put('/api/campaigns/test/enemy-combat').send(config).expect(200);
        const response = await request(app).get('/api/campaigns/test/enemy-combat').expect(200);

        // Validation backfills safe defaults; enemyDiscoveryEnabled defaults to false.
        expect(response.body).toMatchObject({
            enabled: true,
            initiativeMode: 'd20',
            actionsEnabled: true,
            enemyDiscoveryEnabled: false,
            promptContextEnabled: true,
            barrierMode: 'absorb-first',
            autoDefeatAtZeroHp: true,
            weaknessMultiplier: 2,
            resistanceMultiplier: 0.5,
            defaultActionsPerTurn: 1,
            cooldownsEnabled: false,
            resourcesEnabled: false,
        });
    });

    it('persists enemy resolutions through the campaign API', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createCampaignsRouter } = await import('../routes/campaigns.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createCampaignsRouter());
        const resolutions = [{
            id: 'resolution-1',
            encounterId: 'encounter-1',
            outcome: 'victory',
            xpAwarded: 50,
        }];

        await request(app).put('/api/campaigns/test/enemy-resolutions').send(resolutions).expect(200);
        const response = await request(app).get('/api/campaigns/test/enemy-resolutions').expect(200);

        // Validation backfills safe defaults (encounterName, summary, arrays).
        expect(response.body).toHaveLength(1);
        expect(response.body[0]).toMatchObject({
            id: 'resolution-1',
            encounterId: 'encounter-1',
            outcome: 'victory',
            xpAwarded: 50,
            encounterName: 'Encounter',
            summary: 'Encounter ended.',
            lootAwarded: [],
            otherRewards: [],
            participantNames: [],
            instanceDisposition: 'archive',
            archivedInstances: [],
        });
    });

    it('full campaign transfer rejects malformed enemy data before persistence', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            buildArchiveText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeArchiveEmbedding: vi.fn(),
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createTransferRouter } = await import('../routes/transfer.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        // Malformed bundle: enemies contains a non-object, instances have a bad number.
        const malformedBundle = {
            version: 1,
            campaign: { id: 'transfer-bad', name: 'Bad Transfer' },
            enemies: ['not-an-object'],
            enemyInstances: [{ currentHp: 'oops' }],
        };

        const rejected = await request(app).post('/api/campaigns/import')
            .send(malformedBundle)
            .expect(400);
        expect(rejected.body.error).toContain('Malformed enemy data');
        expect(rejected.body.details.length).toBeGreaterThan(0);

        // No files were written for the rejected campaign.
        expect(fs.existsSync(path.join(tmpDir, 'campaigns', 'transfer-bad.json'))).toBe(false);
        expect(fs.existsSync(path.join(tmpDir, 'campaigns', 'transfer-bad.enemies.json'))).toBe(false);
    });

    it('full campaign transfer validates and persists clean enemy data', async () => {
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildLoreText: vi.fn(),
            buildArchiveText: vi.fn(),
            resolveIndexingSpeed: vi.fn(() => ({ batchSize: 1, delayMs: 0 })),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeArchiveEmbedding: vi.fn(),
            storeLoreEmbedding: vi.fn(),
            deleteCampaignEmbeddings: vi.fn(),
        }));
        vi.doMock('../lib/embedJobs.js', () => ({
            startJob: vi.fn(),
            tickJob: vi.fn(),
            endJob: vi.fn(),
        }));

        const { createTransferRouter } = await import('../routes/transfer.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        const cleanBundle = {
            version: 1,
            campaign: { id: 'transfer-good', name: 'Good Transfer' },
            enemies: [{ id: 'orc-1', name: 'Orc' }],
            enemyInstances: [{ id: 'inst-1', templateId: 'orc-1', displayName: 'Orc #1', currentHp: 20, maxHp: 20 }],
            enemyEncounters: [{ id: 'enc-1', name: 'Fight', status: 'active', waves: [] }],
            enemyResolutions: [{ id: 'res-1', encounterId: 'enc-1', outcome: 'victory', xpAwarded: 50 }],
            enemyCombatConfig: { enabled: true, enemyDiscoveryEnabled: false },
        };

        const accepted = await request(app).post('/api/campaigns/import')
            .send(cleanBundle)
            .expect(200);
        expect(accepted.body.ok).toBe(true);

        // Files were written with validated content.
        const enemies = JSON.parse(fs.readFileSync(path.join(tmpDir, 'campaigns', 'transfer-good.enemies.json'), 'utf-8'));
        expect(enemies[0]).toMatchObject({ id: 'orc-1', name: 'Orc', tags: [] });
    });
});
