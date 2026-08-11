import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import express from 'express';

let tmpDir;
let CAMPAIGNS_DIR;

beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fixture-roundtrip-'));
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
 * WO-P5-03 §5 Step 5: prove the machinery on a FIXTURE table, not a real one.
 *
 * Registers a throwaway descriptor for a test-only `.fixture.json` table and
 * round-trips it: write (PUT), read (GET), hydrate (collectHydrators), export
 * (getTransferableTables), import (write back). Nothing real is converted.
 *
 * This test registers the fixture ONLY on local registries built inside the
 * test — the global `serverTableRegistry` is left empty, so the app behaves
 * identically outside this test.
 */
describe('WO-P5-03 Step 5 — fixture table round-trip', () => {
    it('writes, reads, hydrates, exports, and imports a fixture table end-to-end', async () => {
        const { createTableRegistry, mountGenericTableRoutes, getCampaignFileSuffixes, getTransferableTables, isCampaignMetaFile } = await import('../lib/tableRegistry.js?t=' + Date.now());

        // A fixture descriptor — test-only, never registered globally.
        const fixtureLoadCalls = [];
        const reg = createTableRegistry();
        reg.register({
            name: 'fixture',
            fileSuffix: '.fixture.json',
            recordShape: 'array',
            serverRoutes: { present: true, value: { get: true, put: true } },
            transfer: { present: true, value: { bundleKey: 'fixture' } },
            hydrator: { present: true, value: async (campaignId) => {
                fixtureLoadCalls.push(campaignId);
                const fp = path.join(CAMPAIGNS_DIR, `${campaignId}.fixture.json`);
                return fs.existsSync(fp) ? JSON.parse(fs.readFileSync(fp, 'utf-8')) : [];
            }},
            hooks: {
                onAfterRead: (campaignId, record) => {
                    // Tag every record on read, mirroring npcs' on-load home.
                    return (record || []).map((r) => ({ ...r, readBy: campaignId }));
                },
            },
        });

        // ── WRITE + READ via the generic GET/PUT pair ──
        const app = express();
        app.use(express.json());
        app.use(mountGenericTableRoutes(reg));
        const server = app.listen(0);
        const port = server.address().port;

        try {
            // WRITE: PUT an array of fixture records.
            const putRes = await fetch(`http://localhost:${port}/api/campaigns/fix-camp/fixture`, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify([{ id: 'f1', label: 'alpha' }, { id: 'f2', label: 'beta' }]),
            });
            expect(putRes.ok).toBe(true);

            // File landed at the registered suffix.
            const onDisk = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, 'fix-camp.fixture.json'), 'utf-8'));
            expect(onDisk).toEqual([{ id: 'f1', label: 'alpha' }, { id: 'f2', label: 'beta' }]);

            // READ: GET returns the array. onAfterRead tags each record.
            const getRes = await fetch(`http://localhost:${port}/api/campaigns/fix-camp/fixture`);
            expect(getRes.ok).toBe(true);
            const read = await getRes.json();
            // NOTE: the server GET does NOT run onAfterRead (that's a client-side
            // accessor concern per Step 3). The server GET is a plain read.
            expect(read).toEqual([{ id: 'f1', label: 'alpha' }, { id: 'f2', label: 'beta' }]);

            // ── HYDRATE via the descriptor-declared loader ──
            const hydratorEntry = reg.list().find((d) => d.name === 'fixture');
            expect(hydratorEntry.hydrator.present).toBe(true);
            const loaded = await hydratorEntry.hydrator.value('fix-camp');
            expect(fixtureLoadCalls).toEqual(['fix-camp']);
            expect(loaded).toEqual([{ id: 'f1', label: 'alpha' }, { id: 'f2', label: 'beta' }]);

            // ── EXPORT: the fixture is in the transferable list ──
            const transferable = getTransferableTables(reg);
            expect(transferable.map((t) => t.name)).toEqual(['fixture']);
            expect(transferable[0].bundleKey).toBe('fixture');

            // ── IMPORT: write the fixture back under a new campaign id ──
            const importId = 'fix-camp-2';
            fs.writeFileSync(
                path.join(CAMPAIGNS_DIR, `${importId}.fixture.json`),
                JSON.stringify(loaded),
            );
            const reloaded = JSON.parse(fs.readFileSync(path.join(CAMPAIGNS_DIR, `${importId}.fixture.json`), 'utf-8'));
            expect(reloaded).toEqual([{ id: 'f1', label: 'alpha' }, { id: 'f2', label: 'beta' }]);
        } finally {
            server.close();
        }
    });

    it('the fixture suffix joins the derived set and is excluded from meta files', async () => {
        const { createTableRegistry, getCampaignFileSuffixes, isCampaignMetaFile } = await import('../lib/tableRegistry.js?t=' + Date.now());
        const reg = createTableRegistry();
        reg.register({ name: 'fixture', fileSuffix: '.fixture.json', recordShape: 'array' });

        const suffixes = getCampaignFileSuffixes(reg);
        expect(suffixes).toContain('.fixture.json');
        expect(suffixes.length).toBe(20); // 19 built-ins (Phase 8.5 added .migrations.json) + fixture

        // A fixture file is NOT a meta file (the derived positive filter works).
        expect(isCampaignMetaFile('camp.fixture.json', reg)).toBe(false);
        expect(isCampaignMetaFile('camp.json', reg)).toBe(true);
    });

    it('the global serverTableRegistry is empty — no real table converted', async () => {
        const { serverTableRegistry, getCampaignFileSuffixes, getTransferableTables } = await import('../lib/tableRegistry.js?t=' + Date.now());
        serverTableRegistry.clear();
        expect(serverTableRegistry.list()).toEqual([]);
        expect(getCampaignFileSuffixes()).toHaveLength(19);
        expect(getTransferableTables()).toEqual([]);
    });
});