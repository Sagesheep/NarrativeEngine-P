// /assets/campaigns — scene images only.
//
// This prefix was `express.static` over the whole campaign data directory, so
// every campaign's state, archive, ledgers and mod tables were a plain GET
// away. Scene images are the only URLs the app generates under it; these pin
// that images still load at their existing URLs and that nothing else does.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const PNG_BYTES = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
    'base64',
);

let tmpDir;
let savedDataDir;
let request;

beforeAll(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-campaign-assets-'));
    savedDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();

    const { CAMPAIGNS_DIR } = await import('../lib/fileStore.js');
    fs.mkdirSync(path.join(CAMPAIGNS_DIR, 'camp1', 'scene-images'), { recursive: true });
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, 'camp1', 'scene-images', 'img_001.png'), PNG_BYTES);
    // The files that used to be reachable through this prefix.
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, 'camp1.state.json'), '{"secret":"state"}');
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, 'camp1.archive.md'), '## SCENE 001');
    fs.writeFileSync(path.join(CAMPAIGNS_DIR, 'camp1', 'scene-images', '.hidden.png'), PNG_BYTES);

    const { createCampaignAssetsRouter } = await import('../routes/campaignAssets.js');
    const app = express();
    app.use(createCampaignAssetsRouter());
    request = supertest(app);
});

afterAll(() => {
    process.env.DATA_DIR = savedDataDir;
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
});

describe('campaign assets route', () => {
    it('serves a scene image at its existing URL', async () => {
        const res = await request.get('/assets/campaigns/camp1/scene-images/img_001.png');
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toMatch(/image\/png/);
        expect(Buffer.from(res.body)).toEqual(PNG_BYTES);
    });

    it('404s a scene image that does not exist', async () => {
        const res = await request.get('/assets/campaigns/camp1/scene-images/missing.png');
        expect(res.status).toBe(404);
    });

    it.each([
        '/assets/campaigns/camp1.state.json',
        '/assets/campaigns/camp1.archive.md',
        '/assets/campaigns/camp1/../camp1.state.json',
        '/assets/campaigns/camp1/scene-images/..%2F..%2Fcamp1.state.json',
        '/assets/campaigns/camp1/scene-images/.hidden.png',
        '/assets/campaigns/camp1/scene-images/img_001.png.json',
        '/assets/campaigns/..%2Fcamp1/scene-images/img_001.png',
    ])('does not serve %s', async (url) => {
        const res = await request.get(url);
        expect(res.status).toBe(404);
        expect(res.text ?? '').not.toContain('secret');
        expect(res.text ?? '').not.toContain('SCENE');
    });
});
