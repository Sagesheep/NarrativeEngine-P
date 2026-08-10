// Phase 7.3 — mod tier entry manifest validation. Mirrors the shape of
// validateTables / validatePanels: allow-listed keys, ID_REGEX on ids,
// reject with a ModFault rather than fail silently. A malformed entry
// rejects THIS mod, with a reason naming the mod, the entry and the
// problem. Other mods keep loading.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMods } from '../lib/modLoader.js';

let dir;

const write = (name, contents, siblingFiles = {}) => {
    let folderName = name;
    if (name.endsWith('.mod.json')) {
        folderName = name.slice(0, -'.mod.json'.length);
    } else if (name.endsWith('/manifest.json')) {
        folderName = name.slice(0, -'/manifest.json'.length);
    }
    const modFolder = path.join(dir, folderName);
    fs.mkdirSync(modFolder, { recursive: true });
    fs.writeFileSync(
        path.join(modFolder, 'manifest.json'),
        typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
        'utf-8',
    );
    for (const [fileName, fileContent] of Object.entries(siblingFiles)) {
        const filePath = path.join(modFolder, fileName);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, fileContent, 'utf-8');
    }
};

const validMod = (overrides = {}) => ({
    id: 'tier-mod',
    name: 'Tier Mod',
    version: '1.0.0',
    description: 'A mod declaring a tier entry.',
    contributions: [{ id: 'placeholder', order: 990, budget: 1, text: '.' }],
    ...overrides,
});

const validTierEntry = (overrides = {}) => ({
    id: 'beacon',
    name: 'Beacon Scanner',
    description: 'Scans for beacons.',
    toggleable: true,
    trigger: 'automatic',
    defaultEnabled: true,
    callsModel: true,
    matrix: { lite: false, pro: true, max: true },
    ...overrides,
});

/** Assert exactly one file was rejected, and return its reason. */
const soleFaultReason = (result) => {
    expect(result.mods).toHaveLength(0);
    expect(result.faults).toHaveLength(1);
    return result.faults[0].reason;
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-loader-tier-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadMods — tierEntries happy path', () => {
    it('loads a mod with a valid tier entry, preserving every field', () => {
        const result = loadMods(dir, '1.0.0');
        write('beacon-mod', validMod({
            contributions: undefined,
            tierEntries: [validTierEntry({
                cooldown: { pro: 5, max: 0 },
            })],
        }));
        const result2 = loadMods(dir, '1.0.0');

        expect(result2.faults).toHaveLength(0);
        expect(result2.mods).toHaveLength(1);
        const entries = result2.mods[0].tierEntries;
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            id: 'beacon',
            name: 'Beacon Scanner',
            description: 'Scans for beacons.',
            toggleable: true,
            trigger: 'automatic',
            defaultEnabled: true,
            callsModel: true,
            matrix: { lite: false, pro: true, max: true },
            cooldown: { pro: 5, max: 0 },
        });
    });

    it('tierEntries is optional (absent = [])', () => {
        write('plain-mod', validMod());
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(0);
        expect(result.mods[0].tierEntries).toEqual([]);
    });

    it('description defaults to empty string when absent', () => {
        write('no-desc', validMod({
            contributions: undefined,
            tierEntries: [validTierEntry({ description: undefined })],
        }));
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(0);
        expect(result.mods[0].tierEntries[0].description).toBe('');
    });

    it('callsModel is optional (absent = not stamped on the entry)', () => {
        write('no-calls', validMod({
            contributions: undefined,
            tierEntries: [validTierEntry({ callsModel: undefined })],
        }));
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(0);
        expect(result.mods[0].tierEntries[0].callsModel).toBeUndefined();
    });

    it('cooldown is optional (absent = undefined)', () => {
        write('no-cooldown', validMod({
            contributions: undefined,
            tierEntries: [validTierEntry()],
        }));
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(0);
        expect(result.mods[0].tierEntries[0].cooldown).toBeUndefined();
    });

    it('cooldown may be partial (only some tiers)', () => {
        write('partial-cooldown', validMod({
            contributions: undefined,
            tierEntries: [validTierEntry({ cooldown: { pro: 3 } })],
        }));
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(0);
        expect(result.mods[0].tierEntries[0].cooldown).toEqual({ pro: 3 });
    });

    it('a mod declaring only tierEntries (no contributions) loads', () => {
        write('tier-only', {
            id: 'tier-only',
            name: 'Tier Only',
            version: '1.0.0',
            tierEntries: [validTierEntry()],
        });
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(0);
        expect(result.mods).toHaveLength(1);
    });
});

describe('loadMods — tierEntries rejections', () => {
    it('rejects non-array tierEntries', () => {
        write('bad', validMod({ tierEntries: {} }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('tierEntries must be an array');
    });

    it('rejects a non-object entry', () => {
        write('bad', validMod({ tierEntries: ['not-an-object'] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('tierEntries[0] must be an object');
    });

    it('rejects an id that fails ID_REGEX', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ id: 'has.dots' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('may contain only letters');
    });

    it('rejects a duplicate id within the same mod', () => {
        write('bad', validMod({
            tierEntries: [validTierEntry({ id: 'a' }), validTierEntry({ id: 'a' })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('declared more than once');
    });

    it('rejects a missing name', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ name: undefined })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('name must be a non-empty string');
    });

    it('rejects a non-boolean toggleable', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ toggleable: 'yes' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('toggleable must be a boolean');
    });

    it('rejects an invalid trigger', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ trigger: 'sometimes' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('trigger "sometimes" must be one of');
    });

    it('rejects a non-boolean defaultEnabled', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ defaultEnabled: 1 })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('defaultEnabled must be a boolean');
    });

    it('rejects a non-boolean callsModel', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ callsModel: 'yes' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('callsModel must be a boolean');
    });

    it('rejects a missing matrix', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ matrix: undefined })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('matrix must be an object');
    });

    it('rejects a matrix missing a tier', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ matrix: { lite: false, pro: true } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('matrix.max must be a boolean');
    });

    it('rejects a matrix with a non-boolean tier value', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ matrix: { lite: 'no', pro: true, max: true } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('matrix.lite must be a boolean');
    });

    it('rejects a matrix with an unknown tier', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ matrix: { lite: false, pro: true, max: true, ultra: true } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('unknown tier "ultra"');
    });

    it('rejects a cooldown with a negative value', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ cooldown: { pro: -1 } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('cooldown.pro must be a non-negative');
    });

    it('rejects a cooldown with a non-number value', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ cooldown: { pro: 'five' } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('cooldown.pro must be a non-negative');
    });

    it('rejects an unknown field on a tier entry', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ extra: 'no' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('unknown field "extra"');
    });

    it('rejects a forbidden field (file)', () => {
        write('bad', validMod({ tierEntries: [validTierEntry({ file: 'index.js' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.0'))).toContain('file is not allowed on a tier entry');
    });

    it('a malformed tier entry rejects only its mod, not others', () => {
        write('good-mod', validMod({ id: 'good', tierEntries: [validTierEntry()] }));
        write('bad-mod', validMod({ id: 'bad', tierEntries: [validTierEntry({ id: 'has space' })] }));
        const result = loadMods(dir, '1.0.0');
        expect(result.faults).toHaveLength(1);
        expect(result.mods).toHaveLength(1);
        expect(result.mods[0].id).toBe('good');
    });
});
