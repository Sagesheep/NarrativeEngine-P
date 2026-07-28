import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tmpDir;

describe('ability compendium campaign files', () => {
    beforeEach(() => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ability-compendium-'));
        vi.resetModules();
        vi.stubEnv('DATA_DIR', tmpDir);
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('is included in campaign backup discovery', async () => {
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.json'), '{}');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.abilities.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.abilities.json');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.known-abilities.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.known-abilities.json');
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'test.ability-runtime.json'), '[]');
        expect(store.campaignFiles('test')).toContain('test.ability-runtime.json');
    });

    it('validates and persists mutable ability runtime state', async () => {
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

        await request(app).put('/api/campaigns/test/ability-runtime').send([{
            characterAbilityId: 'known-1',
            cooldownRemaining: 2,
            cooldownMax: 4,
            chargesRemaining: 1,
            chargesMax: 3,
        }]).expect(200);

        const saved = await request(app).get('/api/campaigns/test/ability-runtime').expect(200);
        expect(saved.body[0]).toEqual(expect.objectContaining({
            characterAbilityId: 'known-1',
            cooldownRemaining: 2,
            chargesRemaining: 1,
        }));

        await request(app).put('/api/campaigns/test/ability-runtime')
            .send([{ cooldownRemaining: -1 }])
            .expect(400);
    });

    it('validates and persists character ownership separately from definitions', async () => {
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
        const ownership = [{
            abilityId: 'ash-step',
            ownerType: 'npc',
            ownerId: 'marcus',
            mastery: 'Adept',
            variantName: 'Cinder Passage',
        }];

        await request(app).put('/api/campaigns/test/known-abilities').send(ownership).expect(200);
        const response = await request(app).get('/api/campaigns/test/known-abilities').expect(200);
        expect(response.body[0]).toEqual(expect.objectContaining(ownership[0]));

        await request(app).put('/api/campaigns/test/known-abilities')
            .send([{ abilityId: 'ash-step', ownerType: 'npc' }])
            .expect(400);
    });

    it('validates, persists, and reads canonical definitions', async () => {
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

        await request(app).put('/api/campaigns/test/abilities').send([{
            name: 'Ash Step',
            category: 'active',
            costs: [{ resource: 'Aura', amount: '8' }],
            limitations: ['Requires an existing flame'],
        }]).expect(200);

        const saved = await request(app).get('/api/campaigns/test/abilities').expect(200);
        expect(saved.body[0]).toEqual(expect.objectContaining({
            name: 'Ash Step',
            category: 'active',
            costs: [{ resource: 'Aura', amount: '8', timing: '', condition: '' }],
            limitations: ['Requires an existing flame'],
        }));

        await request(app).put('/api/campaigns/test/abilities')
            .send([{ name: 'Broken', costs: 'Aura 8' }])
            .expect(400);
    });

    it('round-trips definitions through portable campaign transfer', async () => {
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            buildArchiveText: vi.fn(),
            buildLoreText: vi.fn(),
        }));
        vi.doMock('../lib/vectorStore.js', () => ({
            storeArchiveEmbedding: vi.fn(),
            storeLoreEmbedding: vi.fn(),
        }));
        const store = await import('../lib/fileStore.js?' + Date.now());
        fs.mkdirSync(store.CAMPAIGNS_DIR, { recursive: true });
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'source.json'), JSON.stringify({ id: 'source', name: 'Source' }));
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'source.abilities.json'), JSON.stringify([{ id: 'ash', name: 'Ash Step' }]));
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'source.known-abilities.json'), JSON.stringify([{ id: 'known', abilityId: 'ash', ownerType: 'pc', ownerId: 'hero' }]));
        fs.writeFileSync(path.join(store.CAMPAIGNS_DIR, 'source.ability-runtime.json'), JSON.stringify([{ id: 'runtime', characterAbilityId: 'known', cooldownRemaining: 2 }]));

        const { createTransferRouter } = await import('../routes/transfer.js?' + Date.now());
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        const exported = await request(app).get('/api/campaigns/source/export').expect(200);
        expect(exported.body.abilities).toEqual([{ id: 'ash', name: 'Ash Step' }]);
        expect(exported.body.characterAbilities).toEqual([{ id: 'known', abilityId: 'ash', ownerType: 'pc', ownerId: 'hero' }]);
        expect(exported.body.abilityRuntimeStates).toEqual([{ id: 'runtime', characterAbilityId: 'known', cooldownRemaining: 2 }]);

        exported.body.campaign.id = 'imported';
        await request(app).post('/api/campaigns/import').send(exported.body).expect(200);
        expect(JSON.parse(fs.readFileSync(path.join(store.CAMPAIGNS_DIR, 'imported.abilities.json'), 'utf8')))
            .toEqual([{ id: 'ash', name: 'Ash Step' }]);
        expect(JSON.parse(fs.readFileSync(path.join(store.CAMPAIGNS_DIR, 'imported.known-abilities.json'), 'utf8')))
            .toEqual([{ id: 'known', abilityId: 'ash', ownerType: 'pc', ownerId: 'hero' }]);
        expect(JSON.parse(fs.readFileSync(path.join(store.CAMPAIGNS_DIR, 'imported.ability-runtime.json'), 'utf8')))
            .toEqual([{ id: 'runtime', characterAbilityId: 'known', cooldownRemaining: 2 }]);
    });
});
