// Phase 8.5 — the campaign migration.
//
// This is the file that stands between a user and a lost compendium, so it
// tests the failure modes rather than the happy path. The happy path is one
// `it`; the other twenty are about what happens when the same campaign is
// opened four times, when the data is garbage, when the user deletes the mod's
// data, when a backup from before the extraction is restored on top, and when
// the mod is not installed at all.
//
// The invariant every test re-checks: **the legacy file is still there,
// byte-for-byte, afterwards.** Adoption is a copy. If everything else here is
// wrong, that one line means the user's data is where it has always been.

import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// `fileStore.js` resolves DATA_DIR once, at import time, and `legacyAdoption.js`
// imports it plainly — so a per-test cache-busted re-import would give the two
// modules two different campaign directories. Point DATA_DIR at a temp tree
// BEFORE the first import instead, and reuse one module graph for the file
// (vitest isolates the module registry per test file).
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'adoption-'));
process.env.DATA_DIR = tmpRoot;

const lib = {
    ...(await import('../lib/fileStore.js')),
    ...(await import('../lib/legacyTables.js')),
    ...(await import('../lib/legacyAdoption.js')),
};
const CAMPAIGNS_DIR = lib.CAMPAIGNS_DIR;
const ID = 'campaign1';

const COMPENDIUM = {
    name: 'mod.enemies.compendium',
    fileSuffix: '.mod-enemies-compendium.json',
    recordShape: 'array',
    migrateFrom: '.enemies.json',
};
const CONFIG = {
    name: 'mod.enemies.config',
    fileSuffix: '.mod-enemies-config.json',
    recordShape: 'single-object',
    migrateFrom: '.enemy-combat.json',
};

const MONSTERS = [
    { id: 'a', name: 'Goblin', stats: [{ name: 'HP', value: '7' }] },
    { id: 'b', name: 'Owlbear', stats: [{ name: 'HP', value: '59' }] },
];

function legacyPath(suffix) { return path.join(CAMPAIGNS_DIR, `${ID}${suffix}`); }

beforeEach(() => {
    fs.rmSync(CAMPAIGNS_DIR, { recursive: true, force: true });
    lib.ensureDirs();
    lib.writeJson(path.join(CAMPAIGNS_DIR, `${ID}.json`), { id: ID, name: 'Test' });
});

afterEach(() => {
    vi.restoreAllMocks();
});

describe('adoption — the happy path', () => {
    it('copies a retired file into the mod table and records the ledger', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);

        expect(lib.adoptLegacyTable(ID, COMPENDIUM)).toEqual({ status: 'adopted', records: 2 });

        expect(lib.readJson(legacyPath('.mod-enemies-compendium.json'))).toEqual(MONSTERS);
        // THE INVARIANT. Adoption is a copy; the legacy file is the rollback.
        expect(lib.readJson(legacyPath('.enemies.json'))).toEqual(MONSTERS);

        const ledger = lib.readMigrationLedger(ID);
        expect(ledger.adopted['mod.enemies.compendium'].from).toBe('.enemies.json');
        expect(ledger.adopted['mod.enemies.compendium'].records).toBe(2);
        expect(ledger.failures).toEqual({});
    });

    it('adopts a single-object table with a null record count', () => {
        lib.writeJson(legacyPath('.enemy-combat.json'), { enabled: true, initiativeMode: 'd20' });

        expect(lib.adoptLegacyTable(ID, CONFIG)).toEqual({ status: 'adopted', records: null });
        expect(lib.readJson(legacyPath('.mod-enemies-config.json'))).toEqual({ enabled: true, initiativeMode: 'd20' });
    });

    it('does nothing at all for a campaign with no retired files', () => {
        expect(lib.adoptLegacyTable(ID, COMPENDIUM)).toEqual({ status: 'skipped', reason: 'no-legacy-file' });
        // No ledger is created. A campaign born after the extraction never
        // grows one, so the file set of a new campaign is unchanged.
        expect(fs.existsSync(lib.migrationLedgerPath(ID))).toBe(false);
    });
});

describe('adoption — idempotence', () => {
    it('is identical after three runs: same data, same count, one ledger entry', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);

        const statuses = [1, 2, 3].map(() => lib.adoptLegacyTable(ID, COMPENDIUM).status);
        expect(statuses).toEqual(['adopted', 'skipped', 'skipped']);

        // Counts, not just presence — this app has a history of duplicate-record
        // bugs, and "the compendium is there" would pass with every monster
        // listed twice (9.9.2 §3).
        expect(lib.readJson(legacyPath('.mod-enemies-compendium.json'))).toHaveLength(2);
        expect(Object.keys(lib.readMigrationLedger(ID).adopted)).toEqual(['mod.enemies.compendium']);
    });

    it('never overwrites edits the mod made after adopting', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        lib.adoptLegacyTable(ID, COMPENDIUM);

        // The user renames a monster and adds one — the mod writes its table.
        const edited = [{ ...MONSTERS[0], name: 'Goblin Chief' }, MONSTERS[1], { id: 'c', name: 'Wyvern' }];
        lib.writeJson(legacyPath('.mod-enemies-compendium.json'), edited);

        expect(lib.adoptLegacyTable(ID, COMPENDIUM).status).toBe('skipped');
        expect(lib.readJson(legacyPath('.mod-enemies-compendium.json'))).toEqual(edited);
    });

    it('seals a table that already exists, so a later Delete data cannot resurrect it', () => {
        // The mod wrote its table before anything read it (an import, say), so
        // the copy never ran and there is no `adopted` entry to stop it later.
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        lib.writeJson(legacyPath('.mod-enemies-compendium.json'), [{ id: 'z', name: 'Only This' }]);

        expect(lib.adoptLegacyTable(ID, COMPENDIUM)).toEqual({ status: 'sealed' });
        expect(lib.readMigrationLedger(ID).adopted['mod.enemies.compendium'].sealed).toBe(true);

        // DATA_POLICY.md §3 — the user deletes the mod's data for this campaign.
        fs.rmSync(legacyPath('.mod-enemies-compendium.json'));

        // Reopening must NOT bring back what they just erased.
        expect(lib.adoptLegacyTable(ID, COMPENDIUM).status).toBe('skipped');
        expect(fs.existsSync(legacyPath('.mod-enemies-compendium.json'))).toBe(false);
    });

    it('adopts over an EMPTY table file rather than treating it as data', () => {
        // The shape that made this necessary: an import bundle carrying
        // `mod.enemies.compendium: []` for a campaign that had never adopted.
        // The empty file existed, so "the target exists" sealed the campaign
        // and its real compendium became unreachable while sitting on disk.
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        lib.writeJson(legacyPath('.mod-enemies-compendium.json'), []);

        expect(lib.adoptLegacyTable(ID, COMPENDIUM)).toEqual({ status: 'adopted', records: 2 });
        expect(lib.readJson(legacyPath('.mod-enemies-compendium.json'))).toEqual(MONSTERS);
    });

    it('adopts over a null single-object table file', () => {
        lib.writeJson(legacyPath('.enemy-combat.json'), { enabled: true });
        lib.writeJson(legacyPath('.mod-enemies-config.json'), null);

        expect(lib.adoptLegacyTable(ID, CONFIG).status).toBe('adopted');
        expect(lib.readJson(legacyPath('.mod-enemies-config.json'))).toEqual({ enabled: true });
    });

    it('does not re-adopt after Delete data removes an adopted table', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        lib.adoptLegacyTable(ID, COMPENDIUM);

        fs.rmSync(legacyPath('.mod-enemies-compendium.json'));

        expect(lib.adoptLegacyTable(ID, COMPENDIUM)).toEqual({ status: 'skipped', reason: 'already-adopted' });
        expect(fs.existsSync(legacyPath('.mod-enemies-compendium.json'))).toBe(false);
        // And the legacy file is STILL there — deleting the mod's data never
        // touches a host file (DATA_POLICY.md §2).
        expect(lib.readJson(legacyPath('.enemies.json'))).toEqual(MONSTERS);
    });
});

describe('adoption — failure leaves the campaign openable', () => {
    it('records a failure and touches nothing when the legacy file is not JSON', () => {
        fs.writeFileSync(legacyPath('.enemies.json'), '{ this is not json', 'utf-8');
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});

        const result = lib.adoptLegacyTable(ID, COMPENDIUM);
        expect(result.status).toBe('failed');
        expect(result.reason).toMatch(/not readable JSON/);

        // No half-written target, and the corrupt original is untouched for a
        // human to look at.
        expect(fs.existsSync(legacyPath('.mod-enemies-compendium.json'))).toBe(false);
        expect(fs.readFileSync(legacyPath('.enemies.json'), 'utf-8')).toBe('{ this is not json');

        const ledger = lib.readMigrationLedger(ID);
        expect(ledger.failures['mod.enemies.compendium'].error).toMatch(/not readable JSON/);
        expect(ledger.adopted).toEqual({});
        expect(error).toHaveBeenCalled();
        warn.mockRestore();
    });

    it('retries a failure on the next open rather than latching it', () => {
        fs.writeFileSync(legacyPath('.enemies.json'), 'garbage', 'utf-8');
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
        expect(lib.adoptLegacyTable(ID, COMPENDIUM).status).toBe('failed');

        // Someone fixes the file by hand.
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);

        expect(lib.adoptLegacyTable(ID, COMPENDIUM).status).toBe('adopted');
        const ledger = lib.readMigrationLedger(ID);
        expect(ledger.failures).toEqual({});
        expect(ledger.adopted['mod.enemies.compendium'].records).toBe(2);
    });

    it('never throws when the target cannot be written', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        vi.spyOn(console, 'error').mockImplementation(() => {});
        // A directory where the file should go: the write fails, nothing else does.
        fs.mkdirSync(legacyPath('.mod-enemies-compendium.json'));

        expect(() => lib.adoptLegacyTable(ID, COMPENDIUM)).not.toThrow();
        expect(lib.readJson(legacyPath('.enemies.json'))).toEqual(MONSTERS);
    });

    it('treats a mangled ledger as empty rather than failing the open', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        fs.writeFileSync(lib.migrationLedgerPath(ID), '[]', 'utf-8');

        expect(lib.readMigrationLedger(ID)).toEqual({ version: 1, adopted: {}, failures: {} });
        expect(lib.adoptLegacyTable(ID, COMPENDIUM).status).toBe('adopted');
    });
});

describe('adoption — what it refuses to do', () => {
    it('ignores a table that declares no migrateFrom', () => {
        lib.writeJson(legacyPath('.enemies.json'), MONSTERS);
        const noDeclaration = { ...COMPENDIUM, migrateFrom: undefined };
        expect(lib.adoptLegacyTable(ID, noDeclaration)).toEqual({ status: 'skipped', reason: 'no-declaration' });
        expect(fs.existsSync(legacyPath('.mod-enemies-compendium.json'))).toBe(false);
    });

    it('refuses a suffix that is not in the retired registry, even in a descriptor', () => {
        // The loader rejects this at manifest validation; this is the second
        // defence, at the line that turns a string into a filesystem read.
        // Without it, a descriptor built by any other path could read the
        // campaign record into a table the mod can then read back.
        const stealCampaign = { ...COMPENDIUM, migrateFrom: '.json' };
        expect(lib.adoptLegacyTable(ID, stealCampaign)).toEqual({ status: 'skipped', reason: 'not-a-retired-file' });
        expect(fs.existsSync(legacyPath('.mod-enemies-compendium.json'))).toBe(false);
    });

    it('keeps every retired suffix in the campaign file set, so backups still carry them', async () => {
        // A retired file is still user data. Dropping it from the file set
        // would quietly stop backing it up — and it is the rollback path.
        const names = lib.campaignFileNames(ID);
        for (const { fileSuffix } of lib.RETIRED_CAMPAIGN_TABLES) {
            expect(names).toContain(`${ID}${fileSuffix}`);
        }
        expect(names).toContain(`${ID}.migrations.json`);
    });
});
