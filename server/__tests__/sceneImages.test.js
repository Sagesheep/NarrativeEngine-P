import fs from 'fs';
import path from 'path';
import os from 'os';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

let tmpDir;
let originalDataDir;

describe('Scene Images Router & Services', () => {
    let app;

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-scene-img-test-'));
        originalDataDir = process.env.DATA_DIR;
        process.env.DATA_DIR = tmpDir;

        // Write mock settings so image generator endpoint is available
        const settingsPath = path.join(tmpDir, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            imageConfig: {
                endpoint: 'http://localhost:3001/v1',
                modelName: 'test-model',
            },
        }));

        // Reset modules so process.env.DATA_DIR takes effect
        vi.resetModules();

        const { createSceneImagesRouter } = await import('../routes/sceneImages.js');
        app = express();
        app.use(express.json());
        app.use(createSceneImagesRouter(null));
    });

    afterEach(() => {
        if (originalDataDir) {
            process.env.DATA_DIR = originalDataDir;
        } else {
            delete process.env.DATA_DIR;
        }
        if (tmpDir && fs.existsSync(tmpDir)) {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
        vi.restoreAllMocks();
    });

    it('POST /api/scene-images/compose rejects missing parameters', async () => {
        const res = await request(app)
            .post('/api/scene-images/compose')
            .send({});
        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Missing required parameters');
    });

    it('POST /api/scene-images/compose generates a prompt package', async () => {
        const res = await request(app)
            .post('/api/scene-images/compose')
            .send({
                campaignId: 'test_camp_123',
                contextInput: {
                    campaignId: 'test_camp_123',
                    sourceMessageId: 'msg_001',
                    selectedText: 'The hero drew his flaming sword atop the ancient tower.',
                    activeScene: { location: 'Ancient Tower' },
                    presentCharacters: ['Hero'],
                    recentNarrative: [],
                },
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.promptPackage).toBeDefined();
        expect(res.body.promptPackage.positivePrompt).toBeDefined();
        expect(res.body.promptPackage.aspectRatio).toBe('16:9');
    });

    it('POST /api/scene-images/generate creates image file and returns relative asset URL', async () => {
        const fakeArrayBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).buffer;
        const fetchMock = vi.fn().mockImplementation((url) => {
            if (url.includes('/images/generations')) {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        data: [{ url: 'https://example.com/generated_fake.png' }]
                    }),
                });
            }
            if (url.includes('generated_fake.png')) {
                return Promise.resolve({
                    ok: true,
                    arrayBuffer: () => Promise.resolve(fakeArrayBuffer),
                });
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/api/scene-images/generate')
            .send({
                campaignId: 'test_camp_123',
                sourceMessageId: 'msg_001',
                selectedText: 'The hero drew his flaming sword atop the ancient tower.',
                promptPackage: {
                    focus: 'Hero with flaming sword',
                    positivePrompt: 'Hero standing on ancient tower holding a flaming sword.',
                    negativePrompt: 'text, watermark',
                    style: 'Cinematic illustration',
                    framing: 'Wide scene',
                    aspectRatio: '16:9',
                },
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(res.body.attachment).toBeDefined();
        expect(res.body.attachment.kind).toBe('scene-image');
        expect(res.body.attachment.status).toBe('complete');
        expect(res.body.attachment.imageUrl).toMatch(/^\/assets\/campaigns\/test_camp_123\/scene-images\/img_/);

        // Verify disk file creation
        const filename = path.basename(res.body.attachment.imageUrl);
        const diskPath = path.join(tmpDir, 'campaigns', 'test_camp_123', 'scene-images', filename);
        expect(fs.existsSync(diskPath)).toBe(true);
    });

    it('DELETE /api/scene-images/attachment safely deletes target file within campaign dir', async () => {
        const campDir = path.join(tmpDir, 'campaigns', 'test_camp_123', 'scene-images');
        fs.mkdirSync(campDir, { recursive: true });
        const testFile = path.join(campDir, 'img_test_delete.png');
        fs.writeFileSync(testFile, Buffer.from('delete-me'));

        const imageUrl = '/assets/campaigns/test_camp_123/scene-images/img_test_delete.png';

        const res = await request(app)
            .delete('/api/scene-images/attachment')
            .send({
                campaignId: 'test_camp_123',
                attachmentId: 'att_001',
                imageUrl,
            });

        expect(res.status).toBe(200);
        expect(res.body.ok).toBe(true);
        expect(fs.existsSync(testFile)).toBe(false);
    });
});
