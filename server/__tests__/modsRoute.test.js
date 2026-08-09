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
        const aFolder = path.join(dir, 'a');
        fs.mkdirSync(aFolder, { recursive: true });
        fs.writeFileSync(path.join(aFolder, 'manifest.json'), JSON.stringify({
            id: 'grimdark',
            name: 'Grimdark',
            version: '1.0.0',
            contributions: [{ id: 'tone', order: 250, budget: 120, text: 'Tone: unforgiving.' }],
        }), 'utf-8');

        const bFolder = path.join(dir, 'b');
        fs.mkdirSync(bFolder, { recursive: true });
        fs.writeFileSync(path.join(bFolder, 'manifest.json'), '{ broken', 'utf-8');

        const res = await request.get('/api/mods');

        expect(res.status).toBe(200);
        expect(res.body.mods.map((m) => m.id)).toEqual(['grimdark']);
        expect(res.body.faults).toHaveLength(1);
        expect(res.body.faults[0].file).toBe('b/manifest.json');
        expect(res.body.faults[0].reason).toMatch(/invalid JSON/i);
    });
});

// Phase 6.2 — the `?order=id1,id2,id3` query param carries the user's
// chosen load order from `settings.modLoadOrder`. The server applies it
// as the primary tiebreak in the topological sort. The route parses the
// param and passes it to `loadMods`; the sort behaviour itself is tested
// in `modLoader.test.js` under "Phase 6.2 user load-order override".
describe('GET /api/mods?order= — Phase 6.2 user load-order override', () => {
    const writeMod = (id, loadOrder = 0) => {
        const folder = path.join(dir, id);
        fs.mkdirSync(folder, { recursive: true });
        fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify({
            id,
            name: id,
            version: '1.0.0',
            loadOrder,
            contributions: [{ id: 'c', order: 100, text: 'x' }],
        }), 'utf-8');
    };

    it('without ?order, uses the manifest loadOrder default', async () => {
        writeMod('alpha', 100);
        writeMod('beta', -5);
        const res = await request.get('/api/mods');
        expect(res.body.mods.map((m) => m.id)).toEqual(['beta', 'alpha']);
    });

    it('with ?order=, overrides the manifest loadOrder', async () => {
        writeMod('alpha', 100);
        writeMod('beta', -5);
        const res = await request.get('/api/mods?order=alpha,beta');
        expect(res.body.mods.map((m) => m.id)).toEqual(['alpha', 'beta']);
    });

    it('with an empty ?order=, falls back to the manifest default', async () => {
        writeMod('alpha', 100);
        writeMod('beta', -5);
        const res = await request.get('/api/mods?order=');
        expect(res.body.mods.map((m) => m.id)).toEqual(['beta', 'alpha']);
    });

    it('with ?order= listing one mod, lists it first and the rest by loadOrder', async () => {
        writeMod('a', 0);
        writeMod('b', 10);
        writeMod('c', 5);
        const res = await request.get('/api/mods?order=c');
        expect(res.body.mods.map((m) => m.id)).toEqual(['c', 'a', 'b']);
    });

    it('?order= ids not installed are ignored', async () => {
        writeMod('a', 0);
        const res = await request.get('/api/mods?order=ghost,a');
        expect(res.body.mods.map((m) => m.id)).toEqual(['a']);
    });

    it('whitespace in ?order= is trimmed', async () => {
        writeMod('alpha', 100);
        writeMod('beta', -5);
        const res = await request.get('/api/mods?order=%20alpha%20%2C%20beta%20');
        expect(res.body.mods.map((m) => m.id)).toEqual(['alpha', 'beta']);
    });
});
