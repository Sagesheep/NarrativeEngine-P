import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

let tmpDir;
let CAMPAIGNS_DIR;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'table-registry-'));
    process.env.DATA_DIR = tmpDir;
    const store = await import('../lib/fileStore.js?t=' + Date.now());
    CAMPAIGNS_DIR = store.CAMPAIGNS_DIR;
    fs.mkdirSync(CAMPAIGNS_DIR, { recursive: true });
});

afterEach(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * WO-P5-03 §5 Step 2.1: derived CAMPAIGN_FILE_SUFFIXES is set-equal to today's
 * hand-written 18 when the registry is empty. This is the default-as-plugin
 * gate: with no descriptors registered, the derived set must equal the
 * built-in list exactly.
 */
describe('WO-P5-03 Step 2.1 — derived suffixes', () => {
    it('is set-equal to the 18 built-in suffixes when the registry is empty', async () => {
        const { getCampaignFileSuffixes, BUILTIN_CAMPAIGN_FILE_SUFFIXES, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();

        const derived = getCampaignFileSuffixes();
        const builtin = [...BUILTIN_CAMPAIGN_FILE_SUFFIXES];

        // Set-equal: same members, regardless of order.
        expect(new Set(derived)).toEqual(new Set(builtin));
        // Same count (guards against a hidden duplicate).
        expect(derived.length).toBe(18);
        expect(builtin.length).toBe(18);
    });

    it('campaignFileNames produces the 18 filenames in built-in order with empty registry', async () => {
        const { campaignFileNames } = await import('../lib/fileStore.js?t=' + Date.now());
        const names = campaignFileNames('camp1');
        expect(names.length).toBe(18);
        expect(names[0]).toBe('camp1.json');
        expect(names).toContain('camp1.state.json');
        expect(names).toContain('camp1.divergence.json');
    });

    it('a registered descriptor suffix joins the derived set without losing built-ins', async () => {
        const { createTableRegistry, getCampaignFileSuffixes } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const reg = createTableRegistry();
        reg.register({ name: 'fixture', fileSuffix: '.fixture.json', recordShape: 'array' });

        const derived = getCampaignFileSuffixes(reg);
        expect(derived).toContain('.fixture.json');
        // All 18 built-ins still present.
        for (const s of ['.json', '.state.json', '.lore.json', '.divergence.json']) {
            expect(derived).toContain(s);
        }
        expect(derived.length).toBe(19);
    });
});

/**
 * WO-P5-03 §4: the derived positive filter replaces the two drifted negative
 * filters. A campaign metadata file is a .json whose name has no registered
 * campaign-file suffix.
 */
describe('WO-P5-03 Step 2.4 — isCampaignMetaFile positive filter', () => {
    it('accepts a bare {id}.json', async () => {
        const { isCampaignMetaFile, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        expect(isCampaignMetaFile('camp1.json')).toBe(true);
    });

    it('rejects every suffixed campaign file', async () => {
        const { isCampaignMetaFile, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        const suffixed = [
            'camp1.state.json', 'camp1.lore.json', 'camp1.npcs.json', 'camp1.enemies.json',
            'camp1.enemy-instances.json', 'camp1.enemy-encounters.json', 'camp1.enemy-resolutions.json',
            'camp1.enemy-combat.json', 'camp1.locations.json', 'camp1.archive.index.json',
            'camp1.archive.chapters.json', 'camp1.timeline.json', 'camp1.entities.json',
            'camp1.facts.json', 'camp1.overworld.json', 'camp1.divergence.json',
        ];
        for (const f of suffixed) {
            expect(isCampaignMetaFile(f), `${f} should NOT be a meta file`).toBe(false);
        }
    });

    it('rejects the markdown archive (not a .json)', async () => {
        const { isCampaignMetaFile } = await import('../lib/tableRegistry.js?t=' + Date.now());
        expect(isCampaignMetaFile('camp1.archive.md')).toBe(false);
    });

    it('a real metadata .json passes while suffixed and id-less files are excluded', async () => {
        // The data.id && data.name check stays in the route — this asserts the
        // filename filter alone, which is what WO-P5-03 §4 replaces.
        const { isCampaignMetaFile, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        expect(isCampaignMetaFile('real.json')).toBe(true);
        expect(isCampaignMetaFile('real.state.json')).toBe(false);
        expect(isCampaignMetaFile('stray.json')).toBe(true); // route's id/name check filters this further
    });
});

/**
 * WO-P5-03 §5 Step 2.2: the generic GET/PUT pair is opt-in. With no
 * descriptors it mounts nothing; a descriptor that declares serverRoutes gets
 * a round-trip pair.
 */
describe('WO-P5-03 Step 2.2 — generic GET/PUT pair', () => {
    it('mounts zero routes when no descriptors declare serverRoutes', async () => {
        const { mountGenericTableRoutes, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        const router = mountGenericTableRoutes();
        expect(router.stack).toHaveLength(0);
    });

    it('round-trips an array table through the generic pair', async () => {
        const { createTableRegistry, mountGenericTableRoutes } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const reg = createTableRegistry();
        reg.register({
            name: 'fixture',
            fileSuffix: '.fixture.json',
            recordShape: 'array',
            serverRoutes: { present: true, value: { get: true, put: true } },
        });

        const app = express();
        app.use(express.json());
        app.use(mountGenericTableRoutes(reg));
        const server = app.listen(0);
        const port = server.address().port;

        try {
            // GET on missing file → [] (array default).
            const getRes1 = await fetch(`http://localhost:${port}/api/campaigns/c1/fixture`);
            expect(getRes1.status).toBe(200);
            expect(await getRes1.json()).toEqual([]);

            // PUT writes the array.
            await fetch(`http://localhost:${port}/api/campaigns/c1/fixture`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ id: 'a' }]),
            });

            // GET reads it back.
            const getRes2 = await fetch(`http://localhost:${port}/api/campaigns/c1/fixture`);
            expect(await getRes2.json()).toEqual([{ id: 'a' }]);

            // File landed on disk at the right path.
            const onDisk = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, 'c1.fixture.json'), 'utf-8'));
            expect(onDisk).toEqual([{ id: 'a' }]);
        } finally {
            server.close();
        }
    });

    it('round-trips a single-object table with null default', async () => {
        const { createTableRegistry, mountGenericTableRoutes } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const reg = createTableRegistry();
        reg.register({
            name: 'cfg-thing',
            fileSuffix: '.cfg-thing.json',
            recordShape: 'single-object',
            serverRoutes: { present: true, value: { get: true, put: true } },
        });

        const app = express();
        app.use(express.json());
        app.use(mountGenericTableRoutes(reg));
        const server = app.listen(0);
        const port = server.address().port;

        try {
            const getRes1 = await fetch(`http://localhost:${port}/api/campaigns/c2/cfg-thing`);
            expect(await getRes1.json()).toBeNull();

            await fetch(`http://localhost:${port}/api/campaigns/c2/cfg-thing`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ enabled: true }),
            });

            const getRes2 = await fetch(`http://localhost:${port}/api/campaigns/c2/cfg-thing`);
            expect(await getRes2.json()).toEqual({ enabled: true });
        } finally {
            server.close();
        }
    });

    it('fires onBeforeWrite and onAfterWrite hooks when declared', async () => {
        const { createTableRegistry, mountGenericTableRoutes } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const calls = [];
        const reg = createTableRegistry();
        reg.register({
            name: 'hooked',
            fileSuffix: '.hooked.json',
            recordShape: 'array',
            serverRoutes: { present: true, value: { get: true, put: true } },
            hooks: {
                onBeforeWrite: ({ body }) => { calls.push('before'); return body.map(x => ({ ...x, stamped: true })); },
                onAfterWrite: () => { calls.push('after'); },
            },
        });

        const app = express();
        app.use(express.json());
        app.use(mountGenericTableRoutes(reg));
        const server = app.listen(0);
        const port = server.address().port;

        try {
            await fetch(`http://localhost:${port}/api/campaigns/c3/hooked`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ id: 'a' }]),
            });
            expect(calls).toEqual(['before', 'after']);
            const onDisk = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, 'c3.hooked.json'), 'utf-8'));
            expect(onDisk).toEqual([{ id: 'a', stamped: true }]);
        } finally {
            server.close();
        }
    });
});

/**
 * WO-P5-03 §5 Step 2.3 + §6: transfer is opt-in. Tables that do not declare it
 * stay out of the bundle.
 */
describe('WO-P5-03 Step 2.3 — transfer opt-in', () => {
    it('getTransferableTables is empty with no descriptors', async () => {
        const { getTransferableTables, serverTableRegistry } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        expect(getTransferableTables()).toEqual([]);
    });

    it('lists only descriptors that declare transfer, with their bundle key', async () => {
        const { createTableRegistry, getTransferableTables } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const reg = createTableRegistry();
        reg.register({ name: 'in', fileSuffix: '.in.json', recordShape: 'array', transfer: { present: true, value: { bundleKey: 'inBundle' } } });
        reg.register({ name: 'out', fileSuffix: '.out.json', recordShape: 'array' });

        const list = getTransferableTables(reg);
        expect(list.map((t) => t.name)).toEqual(['in']);
        expect(list[0].bundleKey).toBe('inBundle');
    });
});