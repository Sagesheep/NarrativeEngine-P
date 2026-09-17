// /api/assets/upload and /download — only raster image extensions are written.
//
// The portraits folder is served statically on the API origin with a
// Content-Type chosen from the extension, so a "portrait" saved as `x.html`
// became a page with same-origin access to every /api route. Pins: png/jpg/
// webp… are written, html/svg/js/extension-less names are refused, and the
// existing basename + containment behaviour is unchanged.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

const PNG_1x1 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

let tmpDir;
let saved;
let request;
let portraitsDir;
let safeImageFilename;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-assets-route-'));
    saved = { DATA_DIR: process.env.DATA_DIR, NODE_ENV: process.env.NODE_ENV };
    // In production the portraits dir lives under DATA_DIR; that keeps the
    // test out of the real public/assets/portraits folder.
    process.env.DATA_DIR = tmpDir;
    process.env.NODE_ENV = 'production';
    vi.resetModules();
    const fileStore = await import('../lib/fileStore.js');
    const routes = await import('../routes/assets.js');
    portraitsDir = fileStore.PUBLIC_ASSETS_DIR;
    fs.mkdirSync(portraitsDir, { recursive: true });
    safeImageFilename = routes.safeImageFilename;
    const app = express();
    app.use(express.json({ limit: '5mb' }));
    app.use(routes.createAssetsRouter());
    request = supertest(app);
});

afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
    }
    vi.unstubAllGlobals();
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('safeImageFilename', () => {
    it('accepts raster image extensions, case-insensitively', () => {
        expect(safeImageFilename('bob_123.png')).toBe('bob_123.png');
        expect(safeImageFilename('bob.JPG')).toBe('bob.JPG');
        expect(safeImageFilename('bob.webp')).toBe('bob.webp');
    });
    it('reduces a path to its basename first', () => {
        expect(safeImageFilename('../../evil.png')).toBe('evil.png');
    });
    it('refuses document, script, svg, dot and extension-less names', () => {
        for (const bad of ['x.html', 'x.svg', 'x.js', '.png', 'noext', 'x.', 'x.png.html', '']) {
            expect(safeImageFilename(bad)).toBe(null);
        }
        expect(safeImageFilename(undefined)).toBe(null);
    });
});

describe('POST /api/assets/upload', () => {
    it('writes a png and returns its served path', async () => {
        const res = await request.post('/api/assets/upload').send({ dataUrl: PNG_1x1, filename: 'hero_1.png' });
        expect(res.status).toBe(200);
        expect(res.body.path).toBe('/assets/portraits/hero_1.png');
        expect(fs.existsSync(path.join(portraitsDir, 'hero_1.png'))).toBe(true);
    });
    it('refuses an html filename even with an image data URL', async () => {
        const res = await request.post('/api/assets/upload').send({ dataUrl: PNG_1x1, filename: 'page.html' });
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/image extension/);
        expect(fs.readdirSync(portraitsDir)).toEqual([]);
    });
    it('still rejects a non-image data URL', async () => {
        const res = await request.post('/api/assets/upload').send({ dataUrl: 'data:text/html;base64,PGI+', filename: 'x.png' });
        expect(res.status).toBe(400);
    });
});

describe('POST /api/assets/download', () => {
    it('refuses a non-image filename before fetching anything', async () => {
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);
        const res = await request.post('/api/assets/download').send({ url: 'http://example.test/a', filename: 'x.svg' });
        expect(res.status).toBe(400);
        expect(fetchMock).not.toHaveBeenCalled();
    });
    it('writes a fetched image under an allowed extension', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true, status: 200,
            arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
        })));
        const res = await request.post('/api/assets/download').send({ url: 'http://example.test/a.png', filename: 'npc_9.png' });
        expect(res.status).toBe(200);
        expect(fs.readFileSync(path.join(portraitsDir, 'npc_9.png')).length).toBe(3);
    });
});
