// PUT /api/settings — no API key may reach data/settings.json.
//
// The file is plaintext. The strip used to know only the legacy per-preset
// sections (storyAI / imageAI / summarizerAI), so every key on the newer
// `settings.providers[]` model, plus utilityAI / auxiliaryAI / imageConfig,
// was written to disk in the clear. Pins: every apiKey string anywhere in the
// payload is blank on disk, everything else round-trips untouched.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import express from 'express';
import supertest from 'supertest';

let tmpDir;
let originalDataDir;
let request;
let settingsFile;
let stripApiKeys;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ne-settings-route-'));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = tmpDir;
    vi.resetModules();
    const fileStore = await import('../lib/fileStore.js');
    const routes = await import('../routes/settings.js');
    settingsFile = fileStore.SETTINGS_FILE;
    stripApiKeys = routes.stripApiKeys;
    const app = express();
    app.use(express.json());
    app.use(routes.createSettingsRouter());
    request = supertest(app);
});

afterEach(() => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const payload = () => ({
    activeCampaignId: 'c1',
    settings: {
        theme: 'dark',
        providers: [
            { id: 'p1', label: 'Ollama cloud', endpoint: 'https://ollama.com/v1', apiKey: 'sk-provider-secret', modelName: 'm' },
            { id: 'p2', label: 'Local', endpoint: 'http://localhost:11434/v1', apiKey: '', modelName: 'm2' },
        ],
        presets: [{
            id: 'preset-1', name: 'Default',
            storyAI: { endpoint: 'https://a', apiKey: 'story-secret', modelName: 'x' },
            utilityAI: { endpoint: 'https://b', apiKey: 'utility-secret', modelName: 'y' },
            auxiliaryAI: { endpoint: 'https://c', apiKey: 'aux-secret', modelName: 'z' },
        }],
        imageConfig: { endpoint: 'https://img', apiKey: 'image-secret', modelName: 'img' },
    },
});

function apiKeysIn(value, found = []) {
    if (Array.isArray(value)) value.forEach((v) => apiKeysIn(v, found));
    else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
            if (k === 'apiKey') found.push(v);
            else apiKeysIn(v, found);
        }
    }
    return found;
}

describe('stripApiKeys', () => {
    it('blanks every apiKey string at any depth and leaves the rest alone', () => {
        const stripped = stripApiKeys(payload());
        expect(apiKeysIn(stripped)).toEqual(['', '', '', '', '', '']);
        expect(stripped.settings.providers[0].endpoint).toBe('https://ollama.com/v1');
        expect(stripped.settings.presets[0].storyAI.modelName).toBe('x');
        expect(stripped.settings.theme).toBe('dark');
        expect(stripped.activeCampaignId).toBe('c1');
    });
    it('does not mutate its input', () => {
        const input = payload();
        stripApiKeys(input);
        expect(input.settings.providers[0].apiKey).toBe('sk-provider-secret');
    });
    it('passes non-objects through', () => {
        expect(stripApiKeys(null)).toBe(null);
        expect(stripApiKeys('x')).toBe('x');
    });
});

describe('PUT /api/settings', () => {
    it('writes the payload with every apiKey blanked', async () => {
        const res = await request.put('/api/settings').send(payload());
        expect(res.status).toBe(200);
        const raw = fs.readFileSync(settingsFile, 'utf-8');
        expect(raw).not.toContain('secret');
        const onDisk = JSON.parse(raw);
        expect(apiKeysIn(onDisk).every((k) => k === '')).toBe(true);
        expect(onDisk.settings.providers).toHaveLength(2);
        expect(onDisk.settings.providers[0].label).toBe('Ollama cloud');
    });
    it('round-trips through GET without keys', async () => {
        await request.put('/api/settings').send(payload());
        const res = await request.get('/api/settings');
        expect(res.status).toBe(200);
        expect(apiKeysIn(res.body).every((k) => k === '')).toBe(true);
        expect(res.body.settings.theme).toBe('dark');
    });
});

// The embedding model choice and what the vector tables hold are written only by
// the server. The client saves its whole settings object, which lacks them, and
// used to erase them on every save — a switched model would then read as "no
// record" and an old model's vectors would be kept.
describe('PUT /api/settings — server-owned embedding keys', () => {
    const serverOwned = { embeddingDims: 384, embeddingModelId: 'Xenova/multilingual-e5-small', embeddingModelKey: 'multilingual' };

    it('keeps the embedding keys across a client save that does not carry them', async () => {
        fs.writeFileSync(settingsFile, JSON.stringify({ settings: { theme: 'light', ...serverOwned } }), 'utf-8');
        await request.put('/api/settings').send(payload());
        const res = await request.get('/api/settings');
        expect(res.body.settings).toMatchObject(serverOwned);
        expect(res.body.settings.theme).toBe('dark');
    });

    it('ignores a client that tries to change them', async () => {
        fs.writeFileSync(settingsFile, JSON.stringify({ settings: serverOwned }), 'utf-8');
        const body = payload();
        body.settings.embeddingModelKey = 'english';
        body.settings.embeddingModelId = 'something-else';
        await request.put('/api/settings').send(body);
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        expect(onDisk.settings).toMatchObject(serverOwned);
    });

    it('does not invent them when the server never wrote them', async () => {
        const body = payload();
        body.settings.embeddingModelKey = 'multilingual';
        await request.put('/api/settings').send(body);
        const onDisk = JSON.parse(fs.readFileSync(settingsFile, 'utf-8'));
        expect(onDisk.settings.embeddingModelKey).toBeUndefined();
        expect(onDisk.settings.embeddingDims).toBeUndefined();
    });
});
