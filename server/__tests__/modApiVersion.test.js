// Phase 9.2 — the API freeze: `apiVersion` and the mismatch behaviour.
//
// The freeze is only a freeze if the version is enforced rather than described.
// This file is the enforcement half; `docs/MODDING.md` §"Compatibility and the
// frozen surface" and `COMPAT.md` are the promise half, and
// `src/services/mods/__tests__/frozenSurface.test.ts` pins the surface itself.
//
// The policy under test (PM ruling, 9.2): **the bump is the announcement, and
// mods follow the app.** So:
//
//   • a mod from the FUTURE is refused, naming both numbers;
//   • a mod from the PAST loads, flagged, with no shim and no apology;
//   • an undeclared manifest is generation 1, not "current".
//
// Real temp directories and the real `loadMods`, matching `modLoader.test.js` —
// a mocked loader would only re-assert the mock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMods } from '../lib/modLoader.js';
import { MOD_API_VERSION } from '@narrative/engine/mods/apiVersion';

let dir;

const write = (folderName, manifest) => {
    const modFolder = path.join(dir, folderName);
    fs.mkdirSync(modFolder, { recursive: true });
    fs.writeFileSync(
        path.join(modFolder, 'manifest.json'),
        typeof manifest === 'string' ? manifest : JSON.stringify(manifest, null, 2),
        'utf-8',
    );
};

const base = (over = {}) => ({
    id: 'sub',
    name: 'Subject',
    version: '1.0.0',
    contributions: [{ id: 'c', order: 100, text: 'hello' }],
    ...over,
});

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-api-version-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('Phase 9.2 — apiVersion, the mod API generation', () => {
    it('an undeclared manifest is generation 1, not the current generation', () => {
        // The whole mismatch check reads one signal. Promoting an undeclared
        // manifest to `MOD_API_VERSION` would erase it, and every mod written
        // before this field existed would silently claim to be current.
        write('sub', base());
        const { mods, faults } = loadMods(dir, '1.0.0');
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        expect(mods[0].apiVersion).toBe(1);
    });

    it('a mod declaring the current generation loads with no fault', () => {
        write('sub', base({ apiVersion: MOD_API_VERSION }));
        const { mods, faults } = loadMods(dir, '1.0.0');
        expect(faults).toEqual([]);
        expect(mods[0].apiVersion).toBe(MOD_API_VERSION);
        expect(mods[0].apiVersionStale).toBe(false);
    });

    it('a mod declaring a FUTURE generation is refused, naming both numbers', () => {
        // The 9.2 done-when, verbatim: "a mod declaring a future version fails
        // cleanly, with a message naming both versions — the existing
        // `appVersion` rejection already does this well; match its voice."
        write('sub', base({ apiVersion: MOD_API_VERSION + 1 }));
        const { mods, faults } = loadMods(dir, '1.0.0');
        expect(mods).toEqual([]);
        expect(faults).toHaveLength(1);
        expect(faults[0].reason).toContain(String(MOD_API_VERSION + 1));
        expect(faults[0].reason).toContain(String(MOD_API_VERSION));
        expect(faults[0].reason).toMatch(/requires mod API version \d+, but this app provides \d+/);
    });

    it("matches `appVersion`'s rejection voice", () => {
        // Same situation, same sentence shape: "requires X, but this app is/provides Y".
        write('future-app', base({ id: 'future-app', appVersion: '>=99.0.0' }));
        write('future-api', base({ id: 'future-api', apiVersion: MOD_API_VERSION + 1 }));
        const { faults } = loadMods(dir, '1.0.0');
        const reasons = faults.map((f) => f.reason).sort();
        expect(reasons).toEqual([
            expect.stringMatching(/^requires app version >=99\.0\.0, but this app is 1\.0\.0$/),
            expect.stringMatching(/^requires mod API version \d+, but this app provides \d+$/),
        ]);
    });

    it('a non-integer, zero, or negative apiVersion is rejected rather than coerced', () => {
        // "1" as a string is the mistake an author makes copying `appVersion`'s
        // grammar. Coercing it would mean the loader silently disagreed with
        // the manifest about what the mod claims.
        for (const bad of ['1', 1.5, 0, -1, true, null]) {
            fs.rmSync(dir, { recursive: true, force: true });
            fs.mkdirSync(dir, { recursive: true });
            write('sub', base({ apiVersion: bad }));
            const { mods, faults } = loadMods(dir, '1.0.0');
            // `null` is the documented "absent" spelling and is allowed.
            if (bad === null) {
                expect(mods).toHaveLength(1);
                continue;
            }
            expect(mods, `apiVersion ${JSON.stringify(bad)} should be refused`).toEqual([]);
            expect(faults[0].reason).toContain('apiVersion must be a positive integer');
        }
    });

    it('loadMods never throws on a hostile apiVersion', () => {
        write('sub', base({ apiVersion: Number.MAX_SAFE_INTEGER }));
        expect(() => loadMods(dir, '1.0.0')).not.toThrow();
    });
});

describe('Phase 9.2 — the stale-generation path (mods follow the app)', () => {
    // These assertions are written against generation 1, which cannot be stale.
    // They exist so the FIRST bump is a one-line change here rather than a
    // discovery in production — the branch is unreachable today by arithmetic,
    // not by absence.
    it('the stale flag is derived, always present, and false at the current generation', () => {
        write('sub', base({ apiVersion: MOD_API_VERSION }));
        const { mods } = loadMods(dir, '1.0.0');
        // Always stamped, so no consumer re-applies the absent-means-1 rule.
        expect(mods[0]).toHaveProperty('apiVersionStale');
        expect(mods[0].apiVersionStale).toBe(mods[0].apiVersion < MOD_API_VERSION);
    });

    it('a generation older than the host would LOAD, not be refused', () => {
        // The policy, asserted as an invariant rather than as a value: nothing
        // in the loader turns a low `apiVersion` into a rejection. At
        // generation 1 the lowest legal declaration IS the current one, so the
        // assertion is that the only refusing branch is the future one.
        write('sub', base({ apiVersion: 1 }));
        const { mods, faults } = loadMods(dir, '1.0.0');
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
    });
});

describe('Phase 9.2 — the qualified macro slot (6.9.2 awkward moment #3)', () => {
    // The bug this closes: every doc said a mod references its own macro as
    // `{{mod.<id>.<name>}}`, the implementation expects the bare `{{name}}`,
    // and the mismatch shipped the literal braces to the model with no fault
    // anywhere. Two mods in this repo were doing it.
    it('rejects the qualified spelling and names the bare one', () => {
        write('sub', base({
            id: 'anno-mark',
            contributions: [{ id: 'c', order: 100, text: '{{mod.anno-mark.markedContent}}' }],
        }));
        const { mods, faults } = loadMods(dir, '1.0.0');
        expect(mods).toEqual([]);
        expect(faults).toHaveLength(1);
        expect(faults[0].reason).toContain('{{mod.anno-mark.markedContent}}');
        expect(faults[0].reason).toContain('{{markedContent}}');
    });

    it('accepts the bare spelling, and leaves other slots alone', () => {
        write('sub', base({
            contributions: [
                { id: 'a', order: 100, text: 'Marked: {{markedContent}}' },
                { id: 'b', order: 200, text: 'In {{location}} with {{npcs}}' },
                { id: 'c', order: 300, text: 'A {{typo}} is still left verbatim, not rejected' },
            ],
        }));
        const { mods, faults } = loadMods(dir, '1.0.0');
        expect(faults).toEqual([]);
        expect(mods[0].contributions).toHaveLength(3);
    });

    it('catches the spelling anywhere in the text, not only when it is the whole string', () => {
        write('sub', base({
            contributions: [{ id: 'c', order: 100, text: 'Notes so far: {{mod.sub.notes}} — end.' }],
        }));
        const { faults } = loadMods(dir, '1.0.0');
        expect(faults[0].reason).toContain('{{notes}}');
    });

    it('every shipped manifest in mods/ uses the bare spelling', () => {
        // The regression guard for the two mods this phase fixed. `template-mod`
        // is the folder 9.1 tells every author to copy, so a broken slot there
        // propagates into every mod written from it.
        const modsRoot = path.join(process.cwd(), 'mods');
        const folders = fs.readdirSync(modsRoot, { withFileTypes: true })
            .filter((e) => e.isDirectory());
        const offenders = [];
        for (const folder of folders) {
            const manifestPath = path.join(modsRoot, folder.name, 'manifest.json');
            if (!fs.existsSync(manifestPath)) continue;
            const raw = fs.readFileSync(manifestPath, 'utf-8');
            if (/\{\{\s*mod\./.test(raw)) offenders.push(folder.name);
        }
        expect(offenders).toEqual([]);
    });
});
