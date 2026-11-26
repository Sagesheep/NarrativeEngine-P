import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir;
let CAMPAIGNS_DIR;
let createChaptersRouter;
let request;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'chapters-wo06-'));
    process.env.DATA_DIR = tmpDir;

    const store = await import('../lib/fileStore.js');
    CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });

    const mod = await import('../routes/chapters.js');
    createChaptersRouter = mod.createChaptersRouter;

    const express = (await import('express')).default;
    const { serverError } = await import('../lib/serverError.js');
    const supertest = (await import('supertest')).default;
    const app = express();
    app.use(express.json());
    app.use('/', createChaptersRouter());
    app.use((err, _req, res, _next) => serverError(res, err, 'ChaptersWO06Test'));
    request = supertest(app);
});

afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

const ID = 'camp-chapters-wo06';

function seedChapters() {
    const chapters = [
        {
            chapterId: 'CH01',
            title: 'Open Chapter',
            sceneRange: ['001', '001'],
            sceneIds: ['001'],
            summary: '',
            keywords: [],
            npcs: [],
            majorEvents: [],
            unresolvedThreads: [],
            tone: '',
            themes: [],
            sceneCount: 1,
        },
    ];
    fs.writeFileSync(
        path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`),
        JSON.stringify(chapters)
    );
    return chapters;
}

function readChapters() {
    return JSON.parse(
        fs.readFileSync(path.join(CAMPAIGNS_DIR, `${ID}.archive.chapters.json`), 'utf-8')
    );
}

describe('PATCH /api/campaigns/:id/archive/chapters/:chapterId — WO-06 allowlist', () => {
    it('accepts synopsis, abstractTitle, literalTitle', async () => {
        seedChapters();

        const res = await request
            .patch(`/api/campaigns/${ID}/archive/chapters/CH01`)
            .send({
                synopsis: 'The party fought bandits at Locust Town and won.',
                abstractTitle: 'Old Wounds',
                literalTitle: 'The Battle at Locust Town',
            });

        expect(res.status).toBe(200);
        expect(res.body.synopsis).toBe('The party fought bandits at Locust Town and won.');
        expect(res.body.abstractTitle).toBe('Old Wounds');
        expect(res.body.literalTitle).toBe('The Battle at Locust Town');

        const persisted = readChapters();
        expect(persisted[0].synopsis).toBe('The party fought bandits at Locust Town and won.');
        expect(persisted[0].abstractTitle).toBe('Old Wounds');
        expect(persisted[0].literalTitle).toBe('The Battle at Locust Town');
    });

    it('still ignores unknown fields', async () => {
        seedChapters();

        const res = await request
            .patch(`/api/campaigns/${ID}/archive/chapters/CH01`)
            .send({
                synopsis: 'A synopsis.',
                unknownField: 'should be ignored',
                sealedAt: 999,
            });

        expect(res.status).toBe(200);
        expect(res.body.synopsis).toBe('A synopsis.');
        // Unknown field dropped — not present on the persisted chapter
        expect(res.body.unknownField).toBeUndefined();
        // sealedAt is NOT in the allowlist; existing value preserved (was undefined)
        expect(res.body.sealedAt).toBeUndefined();
        const persisted = readChapters();
        expect(persisted[0].unknownField).toBeUndefined();
        expect(persisted[0].sealedAt).toBeUndefined();
    });

    it('existing allowlisted fields still patch (regression check)', async () => {
        seedChapters();

        const res = await request
            .patch(`/api/campaigns/${ID}/archive/chapters/CH01`)
            .send({
                title: 'Sealed: The Battle at Locust Town',
                summary: 'A narrative summary.',
                themes: ['courage', 'loss'],
                synopsis: 'A synopsis.',
            });

        expect(res.status).toBe(200);
        expect(res.body.title).toBe('Sealed: The Battle at Locust Town');
        expect(res.body.summary).toBe('A narrative summary.');
        expect(res.body.themes).toEqual(['courage', 'loss']);
        expect(res.body.synopsis).toBe('A synopsis.');
    });

    it('returns 404 for an unknown chapterId', async () => {
        seedChapters();

        const res = await request
            .patch(`/api/campaigns/${ID}/archive/chapters/CH999`)
            .send({ synopsis: 'x' });

        expect(res.status).toBe(404);
    });
});