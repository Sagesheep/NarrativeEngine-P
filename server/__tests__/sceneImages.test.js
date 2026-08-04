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

    it('POST /api/scene-images/generate routes OpenRouter providers to /api/v1/images and decodes base64', async () => {
        // OpenRouter has no /images/generations route — the OpenAI shape 404s there.
        const settingsPath = path.join(tmpDir, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            activePresetId: 'preset_or',
            presets: [{ id: 'preset_or', imageAIProviderId: 'prov_or' }],
            providers: [{
                id: 'prov_or',
                endpoint: 'https://openrouter.ai/api/v1/images',
                apiKey: 'sk-or-v1-test',
                modelName: 'google/gemini-2.5-flash-image',
                apiFormat: 'openrouter',
            }],
        }));

        const pngBase64 = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString('base64');
        const seen = [];
        const fetchMock = vi.fn().mockImplementation((url, init) => {
            seen.push({ url, body: JSON.parse(init.body) });
            if (url === 'https://openrouter.ai/api/v1/images') {
                return Promise.resolve({
                    ok: true,
                    json: () => Promise.resolve({
                        created: 1748372400,
                        data: [{ b64_json: pngBase64, media_type: 'image/png' }],
                    }),
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

        // No path doubling, and OpenRouter's own field names.
        expect(seen).toHaveLength(1);
        expect(seen[0].url).toBe('https://openrouter.ai/api/v1/images');
        expect(seen[0].body.aspect_ratio).toBe('16:9');
        expect(seen[0].body.model).toBe('google/gemini-2.5-flash-image');
        expect(seen[0].body.size).toBeUndefined();
        expect(seen[0].body.negative_prompt).toBeUndefined();

        const filename = path.basename(res.body.attachment.imageUrl);
        const diskPath = path.join(tmpDir, 'campaigns', 'test_camp_123', 'scene-images', filename);
        expect(fs.existsSync(diskPath)).toBe(true);
    });

    it('POST /api/scene-images/generate routes ComfyUI providers, writes a campaign image, and keeps the attachment contract', async () => {
        // Resolve config from settings (not an override) so the route's apiFormat + comfyUi pass-through is exercised.
        const settingsPath = path.join(tmpDir, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            activePresetId: 'preset_comfy',
            presets: [{ id: 'preset_comfy', imageAIProviderId: 'prov_comfy' }],
            providers: [{
                id: 'prov_comfy',
                endpoint: 'http://127.0.0.1:8188',
                modelName: 'sd_xl_base_1.0.safetensors',
                apiFormat: 'comfyui',
                comfyUi: { steps: 12, cfgScale: 6, sampler: 'euler', scheduler: 'normal', denoisingStrength: 1 },
            }],
        }));

        const promptId = 'route_comfy_1';
        const pngBuffer = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        const fetchMock = vi.fn((url) => {
            if (url.endsWith('/prompt')) {
                return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve({ prompt_id: promptId }), text: () => Promise.resolve('') });
            }
            if (url.includes(`/history/${promptId}`)) {
                return Promise.resolve({
                    ok: true,
                    status: 200,
                    json: () => Promise.resolve({
                        [promptId]: {
                            outputs: { '9': { images: [{ filename: 'NarrativeEngine_00001_.png', subfolder: '', type: 'output' }] } },
                            status: { status_str: 'success', completed: true },
                        },
                    }),
                    text: () => Promise.resolve(''),
                });
            }
            if (url.includes('/view?')) {
                return Promise.resolve({ ok: true, status: 200, arrayBuffer: () => Promise.resolve(pngBuffer.buffer.slice(0)) });
            }
            return Promise.reject(new Error(`Unexpected fetch: ${url}`));
        });
        vi.stubGlobal('fetch', fetchMock);

        const res = await request(app)
            .post('/api/scene-images/generate')
            .send({
                campaignId: 'test_camp_comfy',
                sourceMessageId: 'msg_001',
                selectedText: 'The knight raised a glowing blade.',
                promptPackage: {
                    focus: 'Knight raising a glowing blade',
                    positivePrompt: 'A knight raising a glowing blade in a dark hall.',
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
        expect(res.body.attachment.imageUrl).toMatch(/^\/assets\/campaigns\/test_camp_comfy\/scene-images\/img_/);
        expect(res.body.attachment.promptPackage).toBeDefined();
        expect(res.body.attachment.generator).toBeDefined();

        // ComfyUI was actually driven: queued a prompt and pulled the image via /view.
        expect(fetchMock.mock.calls.some(([u]) => u.endsWith('/prompt'))).toBe(true);
        expect(fetchMock.mock.calls.some(([u]) => u.includes('/view?'))).toBe(true);

        const filename = path.basename(res.body.attachment.imageUrl);
        const diskPath = path.join(tmpDir, 'campaigns', 'test_camp_comfy', 'scene-images', filename);
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
