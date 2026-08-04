// Phase 1.5 / MANIFEST.md §6.6 — the mod asset route.
//
// `GET /api/mods/:folder/*` serves files from a mod's own folder. The one
// security bug that still matters under the 0.3 trust model is path
// traversal: a request like `/api/mods/arc/../../server/vault.js` would read
// a file the user never installed. Containment re-applies the
// `realpathSync` + `path.relative` discipline from `modLoader.js` at request
// time, because a folder name in a URL is attacker-controlled input.
//
// Pins the done-when criteria from the work order:
//   • traversal attempt (`../../server/vault.js` in the entry path) rejected
//   • a valid file inside a mod's folder is served
//   • unknown mod folder → 404 (no enumeration)
//   • directory request → 404 (no listing)
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import supertest from 'supertest';
import { createModsRouter, serveModFile } from '../routes/mods.js';

let tmpRoot;
let modsDir;
let outsideFile;
let request;

const mountRouter = (modsDir) => {
    const app = express();
    app.use('/api/mods', createModsRouter({ modsDir, appVersion: '1.0.4' }));
    return supertest(app);
};

beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-assets-'));
    modsDir = path.join(tmpRoot, 'mods');
    fs.mkdirSync(modsDir, { recursive: true });
    // A file OUTSIDE the mods directory, to prove traversal cannot reach it.
    outsideFile = path.join(tmpRoot, 'secret.txt');
    fs.writeFileSync(outsideFile, 'vault-contents', 'utf-8');
    request = mountRouter(modsDir);
});

afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const writeMod = (folder, files) => {
    const modDir = path.join(modsDir, folder);
    fs.mkdirSync(modDir, { recursive: true });
    // A valid manifest must declare at least one of the recognised fields
    // (modLoader.js §2 "declares nothing" rejection). A single contribution
    // is the cheapest valid declaration; the asset route does not care about
    // the manifest's content beyond `folder`.
    fs.writeFileSync(path.join(modDir, 'manifest.json'), JSON.stringify({
        id: folder, name: folder, version: '1.0.0',
        contributions: [{ id: 'note', order: 100, text: 'fixture' }],
    }), 'utf-8');
    for (const [name, content] of Object.entries(files)) {
        const filePath = path.join(modDir, name);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf-8');
    }
    return modDir;
};

describe('serveModFile — containment', () => {
    it('returns the resolved absolute path for a file inside the mod folder', () => {
        const modDir = writeMod('arc', { 'index.js': 'export default 1;' });
        const resolved = serveModFile(modsDir, 'arc', 'index.js');
        expect(resolved).toBe(path.join(modDir, 'index.js'));
    });

    it('returns null for a missing file', () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        expect(serveModFile(modsDir, 'arc', 'missing.js')).toBeNull();
    });

    it('returns null for an unknown mod folder', () => {
        // Unknown folder must be 404-shaped (no exception) so an attacker
        // cannot enumerate mod folders from the response shape.
        expect(serveModFile(modsDir, 'does-not-exist', 'index.js')).toBeNull();
    });

    it('rejects a folder name with a path separator', () => {
        expect(() => serveModFile(modsDir, '..', 'index.js')).toThrow();
        expect(() => serveModFile(modsDir, 'a/b', 'index.js')).toThrow();
    });

    it('rejects a backslash in the relative path', () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        expect(() => serveModFile(modsDir, 'arc', 'sub\\..\\index.js')).toThrow();
    });

    it('rejects a `..` segment in the relative path', () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        expect(() => serveModFile(modsDir, 'arc', '../../server/vault.js')).toThrow();
        expect(() => serveModFile(modsDir, 'arc', 'sub/../../index.js')).toThrow();
    });

    it('rejects a symlink that escapes the mod folder', () => {
        const modDir = writeMod('arc', {});
        let symlinkCreated = false;
        try {
            fs.symlinkSync(outsideFile, path.join(modDir, 'escape.js'));
            symlinkCreated = true;
        } catch (err) {
            // Windows without admin privileges refuses to create symlinks
            // (EPERM). The containment check is still exercised by the
            // `..` segment tests above, which do not need symlink support.
            // Skip on EPERM rather than fail: the test asserts a property
            // of the containment check that is independently pinned.
            if (err.code === 'EPERM') {
                console.warn('[mod-assets] symlink test skipped: EPERM (no admin privileges)');
                return;
            }
            throw err;
        }
        // The symlink resolves outside the mod folder. `realpathSync` follows
        // it, then `path.relative` shows the resolved path starts with `..`,
        // and the containment check rejects.
        expect(() => serveModFile(modsDir, 'arc', 'escape.js')).toThrow();
    });

    it('rejects a request for the mod folder itself (directory)', () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        expect(serveModFile(modsDir, 'arc', '')).toBeNull();
    });

    it('returns null for a directory request (no listing)', () => {
        writeMod('arc', { 'sub/file.js': 'export default 1;' });
        // `sub` is a directory. `sendFile` would list it; the route's stat
        // check returns 404 instead.
        expect(serveModFile(modsDir, 'arc', 'sub')).toBeNull();
    });
});

describe('GET /api/mods/:folder/* — route', () => {
    it('serves a file inside a mod folder', async () => {
        writeMod('arc', { 'index.js': 'export function onActivate() {}' });
        const res = await request.get('/api/mods/arc/index.js');
        expect(res.status).toBe(200);
        expect(res.text).toBe('export function onActivate() {}');
        expect(res.headers['content-type']).toMatch(/javascript|text\/plain/);
    });

    it('serves a nested file inside a mod folder', async () => {
        writeMod('arc', { 'screens/editor.js': 'export default 1;' });
        const res = await request.get('/api/mods/arc/screens/editor.js');
        expect(res.status).toBe(200);
        expect(res.text).toBe('export default 1;');
    });

    it('returns 404 for a missing file', async () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        const res = await request.get('/api/mods/arc/missing.js');
        expect(res.status).toBe(404);
    });

    it('returns 404 for an unknown mod folder', async () => {
        const res = await request.get('/api/mods/does-not-exist/index.js');
        expect(res.status).toBe(404);
    });

    it('rejects a traversal attempt to the server vault', async () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        const res = await request.get('/api/mods/arc/../../server/vault.js');
        // Express normalises `/../` segments in the URL before the route
        // handler sees them, so the attack via raw URL path is already
        // neutralised by the path-to-regexp layer. The route's own
        // containment check is the second defence — exercised through the
        // `serveModFile` unit tests above, where `..` segments reach the
        // function directly.
        // The response here is 404 (the path collapses to something the
        // route does not match) or 403 (if the route matches with a folder
        // containing `..`). Both are non-2xx and not the file's contents.
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain('vault-contents');
    });

    it('rejects an encoded traversal attempt', async () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        // `%2e%2e` is `..`. The route's folder-name check rejects folder
        // names containing `..` before any filesystem call.
        const res = await request.get('/api/mods/arc/%2e%2e/%2e%2e/server/vault.js');
        expect(res.status).toBeGreaterThanOrEqual(400);
        expect(res.text).not.toContain('vault-contents');
    });

    it('still serves the listing endpoint at /', async () => {
        writeMod('arc', { 'index.js': 'export default 1;' });
        const res = await request.get('/api/mods');
        expect(res.status).toBe(200);
        expect(res.body.mods.map((m) => m.id)).toContain('arc');
    });
});