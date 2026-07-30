// Project 2 / WO-P2-04 — `GET /api/mods`.
//
// Thin by design: the route's only job is to hand `loadMods` a directory and serialise the
// result. What is worth pinning is that faults travel WITH the good mods in a 200 response —
// a rejected mod file is information for the user, not a failed request.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import supertest from 'supertest';
import { createModsRouter } from '../routes/mods.js';

let dir;
let request;

const mount = (modsDir, appVersion) => {
    const app = express();
    app.use('/api/mods', createModsRouter({ modsDir, appVersion }));
    return supertest(app);
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mods-route-'));
    request = mount(dir, '1.0.4');
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('GET /api/mods', () => {
    it('returns an empty result for an empty mods folder', async () => {
        const res = await request.get('/api/mods');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ mods: [], faults: [] });
    });

    it('returns an empty result when the mods folder does not exist', async () => {
        const res = await mount(path.join(dir, 'nope'), '1.0.4').get('/api/mods');
        expect(res.status).toBe(200);
        expect(res.body).toEqual({ mods: [], faults: [] });
    });

    it('returns good mods and rejected files together, with 200', async () => {
        fs.writeFileSync(path.join(dir, 'a.mod.json'), JSON.stringify({
            id: 'grimdark',
            name: 'Grimdark',
            version: '1.0.0',
            contributions: [{ id: 'tone', order: 250, budget: 120, text: 'Tone: unforgiving.' }],
        }), 'utf-8');
        fs.writeFileSync(path.join(dir, 'b.mod.json'), '{ broken', 'utf-8');

        const res = await request.get('/api/mods');

        expect(res.status).toBe(200);
        expect(res.body.mods.map((m) => m.id)).toEqual(['grimdark']);
        expect(res.body.faults).toHaveLength(1);
        expect(res.body.faults[0].file).toBe('b.mod.json');
        expect(res.body.faults[0].reason).toMatch(/invalid JSON/i);
    });
});
