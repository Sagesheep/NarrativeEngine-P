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

        expect(response.body).toEqual(instances);
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

        expect(response.body).toEqual(encounters);
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

        expect(response.body).toEqual(config);
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

        expect(response.body).toEqual(resolutions);
    });
});
