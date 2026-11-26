import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';
import request from 'supertest';

/**
 * Phase 6.4 / `DATA_POLICY.md` §3 — the host half of the clean action.
 *
 * `DELETE /api/campaigns/:id/mod-data/:modId` removes the mod's provisioned
 * tables and NOTHING else. Every case here is a rule from the policy, and a
 * failure in any of them is a data-policy violation, not a routing bug.
 */
let tmpDir: string;
let campaignsDir: string;
let app: express.Express;

const write = (filename: string, body: unknown) =>
    fs.writeFileSync(path.join(campaignsDir, filename), JSON.stringify(body));

const exists = (filename: string) => fs.existsSync(path.join(campaignsDir, filename));

describe('Phase 6.4 — clean removes a mod\'s tables and nothing else', () => {
    beforeEach(async () => {
        tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-data-clean-'));
        vi.resetModules();
        vi.stubEnv('DATA_DIR', tmpDir);

        const store = await import('../lib/fileStore.js');
        campaignsDir = store.CAMPAIGNS_DIR;
        fs.mkdirSync(campaignsDir, { recursive: true });

        const { serverTableRegistry, mountModTableRoutes } = await import('../lib/tableRegistry.js');
        const { registerModTables } = await import('../lib/modTableRegistry.js');
        serverTableRegistry.clear();
        registerModTables(serverTableRegistry, [
            { id: 'compendium', tables: [{ name: 'powers', recordShape: 'array' }] },
        ]);

        app = express();
        app.use(express.json());
        app.use(mountModTableRoutes(serverTableRegistry));
    });

    afterEach(async () => {
        const { serverTableRegistry } = await import('../lib/tableRegistry.js');
        serverTableRegistry.clear();
        vi.unstubAllEnvs();
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('removes the mod\'s own tables and returns their namespaced names', async () => {
        write('c1.json', { id: 'c1', name: 'C1' });
        write('c1.mod-compendium-powers.json', [{ id: 'fireball' }]);
        write('c1.mod-compendium-notes.json', [{ id: 'note' }]);

        const res = await request(app).delete('/api/campaigns/c1/mod-data/compendium').expect(200);

        expect(res.body.ok).toBe(true);
        expect([...res.body.removed].sort()).toEqual(['mod.compendium.notes', 'mod.compendium.powers']);
        expect(exists('c1.mod-compendium-powers.json')).toBe(false);
        // §3: prefix-matched, not declaration-matched. `notes` is not declared
        // by the registered mod and still goes — it has no other owner.
        expect(exists('c1.mod-compendium-notes.json')).toBe(false);
    });

    it('leaves the story, the host records and other mods alone', async () => {
        write('c1.json', { id: 'c1', name: 'C1' });
        write('c1.state.json', { scene: 12 });
        write('c1.archiveIndex.json', [{ sceneId: '001' }]);
        write('c1.npcs.json', [{ name: 'Innkeeper' }]);
        write('c1.mod-compendium-powers.json', [{ id: 'fireball' }]);
        write('c1.mod-arc-arcs.json', [{ id: 'arc-1' }]);
        fs.writeFileSync(path.join(campaignsDir, 'c1.archive.md'), '## SCENE 001\n');

        await request(app).delete('/api/campaigns/c1/mod-data/compendium').expect(200);

        // §2 — everything except the mod's own tables stays.
        expect(exists('c1.json')).toBe(true);
        expect(exists('c1.state.json')).toBe(true);
        expect(exists('c1.archiveIndex.json')).toBe(true);
        expect(exists('c1.npcs.json')).toBe(true);
        expect(exists('c1.archive.md')).toBe(true);
        expect(exists('c1.mod-arc-arcs.json')).toBe(true);
        expect(exists('c1.mod-compendium-powers.json')).toBe(false);
    });

    it('does not touch another campaign\'s copy of the same mod table', async () => {
        write('c1.mod-compendium-powers.json', [{ id: 'fireball' }]);
        write('c2.mod-compendium-powers.json', [{ id: 'shield' }]);

        await request(app).delete('/api/campaigns/c1/mod-data/compendium').expect(200);

        // §3 — per campaign. Another save is never touched by an action taken
        // inside this one.
        expect(exists('c1.mod-compendium-powers.json')).toBe(false);
        expect(exists('c2.mod-compendium-powers.json')).toBe(true);
    });

    it('does not take a longer-named installed mod\'s table with it', async () => {
        const { serverTableRegistry } = await import('../lib/tableRegistry.js');
        const { registerModTables } = await import('../lib/modTableRegistry.js');
        registerModTables(serverTableRegistry, [
            { id: 'my', tables: [{ name: 'notes', recordShape: 'array' }] },
            { id: 'my-mod', tables: [{ name: 'powers', recordShape: 'array' }] },
        ]);
        write('c1.mod-my-notes.json', [{ id: 'note' }]);
        write('c1.mod-my-mod-powers.json', [{ id: 'fireball' }]);

        const res = await request(app).delete('/api/campaigns/c1/mod-data/my').expect(200);

        // §3 — `mod-my-mod-powers` prefix-matches `mod-my-`, but it is a
        // registered suffix of a different mod, so it survives.
        expect(res.body.removed).toEqual(['mod.my.notes']);
        expect(exists('c1.mod-my-notes.json')).toBe(false);
        expect(exists('c1.mod-my-mod-powers.json')).toBe(true);
    });

    it('clears a mod that declares no tables at all — the route consults no mod code', async () => {
        // §3 — a declarative or sandboxed-only mod cannot declare hooks, and a
        // mod may have left files behind for tables it no longer declares. The
        // host still clears completely: nothing here reads a manifest.
        write('c1.mod-ghost-leftovers.json', [{ id: 'x' }]);

        const res = await request(app).delete('/api/campaigns/c1/mod-data/ghost').expect(200);

        expect(res.body.removed).toEqual(['mod.ghost.leftovers']);
        expect(exists('c1.mod-ghost-leftovers.json')).toBe(false);
    });

    it('is a no-op, not an error, when the mod has no data in this campaign', async () => {
        write('c1.json', { id: 'c1', name: 'C1' });
        const res = await request(app).delete('/api/campaigns/c1/mod-data/compendium').expect(200);
        expect(res.body.removed).toEqual([]);
        expect(exists('c1.json')).toBe(true);
    });

    it('rejects a mod id that is not a bare id, before touching the filesystem', async () => {
        write('c1.state.json', { scene: 12 });
        // A traversal attempt in the id. Express normalises `..` in paths, so
        // the reachable hostile shapes are the ones with a separator or a dot
        // that survives routing — all rejected by the id character set.
        await request(app).delete('/api/campaigns/c1/mod-data/not.an.id').expect(400);
        await request(app).delete('/api/campaigns/c1/mod-data/has%20space').expect(400);
        expect(exists('c1.state.json')).toBe(true);
    });

    it('has no GET or PUT counterpart on the mod-data path', async () => {
        // §3 / `MANIFEST.md` §7.2 — clean is one explicit destructive verb.
        // There is deliberately no "clear via write" shape here.
        await request(app).get('/api/campaigns/c1/mod-data/compendium').expect(404);
        await request(app).put('/api/campaigns/c1/mod-data/compendium').send({}).expect(404);
    });
});
