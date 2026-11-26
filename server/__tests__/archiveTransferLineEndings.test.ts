import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

let tmpDir: string;
let campaignsDir: string;

describe('campaign export reads CRLF archive scenes', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-crlf-'));
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
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.doUnmock('../lib/embedder.js');
        vi.doUnmock('../lib/vectorStore.js');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it.each([['LF', '\n'], ['CRLF', '\r\n']])('exports player and GM text from %s scenes', async (_label, eol) => {
        const id = 'crlf-export';
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'CRLF Export' }));
        const md = [
            '## SCENE 001', '*1/1/2025, 9:00:00 AM*', '',
            '**[USER]**', 'I enter the tavern.', '',
            '**[GM]**', 'The barkeep greets you.', '',
            '---', '',
        ].join(eol);
        fs.writeFileSync(path.join(campaignsDir, `${id}.archive.md`), md);
        fs.writeFileSync(path.join(campaignsDir, `${id}.archive.index.json`), JSON.stringify([{ sceneId: '001', timestamp: 1735722000000 }]));

        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json());
        app.use(createTransferRouter());

        const exported = await request(app).get(`/api/campaigns/${id}/export`).expect(200);

        expect(exported.body.scenes).toEqual([
            { sceneId: '001', userContent: 'I enter the tavern.', assistantContent: 'The barkeep greets you.', timestamp: 1735722000000 },
        ]);
    });
});

// GM replies use `---` themselves, most right under their status line. Export used to
// stop the GM text at the first one, keeping only the status line of 572 of 575 scenes.
describe('campaign export keeps GM replies that contain --- lines', () => {
    const GM_REPLY = [
        'Scene #001 | 📍 The Gilded Tankard | 👥 Barkeep',
        '',
        '---',
        '',
        '[SOCIAL: Normal: Success]',
        '',
        '---',
        '',
        'The barkeep pours a dark stout.',
        '',
        '| Item | Price |',
        '|---|---|',
        '| Stout | 2 cp |',
        '',
        'What do you do?',
    ].join('\n');

    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transfer-rules-'));
        vi.resetModules();
        vi.stubEnv('DATA_DIR', tmpDir);
        vi.doMock('../lib/embedder.js', () => ({
            embedText: vi.fn(),
            embedBatch: vi.fn(async () => []),
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
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.doUnmock('../lib/embedder.js');
        vi.doUnmock('../lib/vectorStore.js');
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('exports the whole GM reply, and an import writes it back unchanged', async () => {
        const id = 'rules-export';
        fs.writeFileSync(path.join(campaignsDir, `${id}.json`), JSON.stringify({ id, name: 'Rules Export' }));
        const md = [
            '## SCENE 001', '*1/1/2025, 9:00:00 AM*', '',
            '**[USER]**', 'I order a drink.', '',
            '**[GM]**', GM_REPLY, '',
            '---', '',
            '## SCENE 002', '*1/1/2025, 9:05:00 AM*', '',
            '**[USER]**', 'I pay.', '',
            '**[GM]**', 'He pockets the coins.', '',
            '---', '',
        ].join('\n');
        fs.writeFileSync(path.join(campaignsDir, `${id}.archive.md`), md);
        fs.writeFileSync(path.join(campaignsDir, `${id}.archive.index.json`), JSON.stringify([
            { sceneId: '001', timestamp: 1735722000000 }, { sceneId: '002', timestamp: 1735722300000 },
        ]));

        const { createTransferRouter } = await import('../routes/transfer.js');
        const app = express();
        app.use(express.json({ limit: '5mb' }));
        app.use(createTransferRouter());

        const exported = await request(app).get(`/api/campaigns/${id}/export`).expect(200);
        expect(exported.body.scenes.map((s: { assistantContent: string }) => s.assistantContent)).toEqual([GM_REPLY, 'He pockets the coins.']);

        const imported = await request(app).post('/api/campaigns/import').send(exported.body).expect(200);
        const { parseArchiveScenes } = await import('../lib/archiveScenes.js');
        const roundTrip = parseArchiveScenes(fs.readFileSync(path.join(campaignsDir, `${imported.body.id}.archive.md`), 'utf-8'));
        expect(roundTrip.map(s => [s.sceneId, s.userContent, s.assistantContent])).toEqual([
            ['001', 'I order a drink.', GM_REPLY],
            ['002', 'I pay.', 'He pockets the coins.'],
        ]);
    });
});
