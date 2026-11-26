// Project 2 / WO-P2-04 — mod file loader + validator.
//
// The contract under test is fail-safe first: `loadMods` must NEVER throw, whatever is on disk.
// A third-party file is untrusted input, and the failure mode this suite exists to prevent is a
// bad mod file taking down a campaign (Project 2 acceptance criterion 5).
//
// Everything runs against a real temp directory rather than a mocked `fs`: the interesting
// failures here (missing folder, unparsable JSON, duplicate ids across files, ordering) are
// filesystem behaviours, and a mock would only re-assert the mock.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMods, PROTECTED_SUPPRESSION_IDS } from '../lib/modLoader.js';

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

const writeRawFile = (name, contents) => {
    const filePath = path.join(dir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(
        filePath,
        typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
        'utf-8',
    );
};

/** A minimal valid mod; spread-override whatever a case needs to break. */
const validMod = (overrides = {}) => ({
    id: 'grimdark-tone',
    name: 'Grimdark Tone',
    version: '1.0.0',
    description: 'Harsher consequences, lasting wounds.',
    contributions: [{ id: 'tone', order: 250, budget: 120, text: 'Tone: unforgiving.' }],
    ...overrides,
});

/** Assert exactly one file was rejected, and return its reason. */
const soleFaultReason = (result) => {
    expect(result.mods).toHaveLength(0);
    expect(result.faults).toHaveLength(1);
    return result.faults[0].reason;
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-loader-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadMods — happy path', () => {
    it('loads a valid mod with every field preserved', () => {
        write('grimdark', validMod({
            appVersion: '>=0.9.0',
            contributions: [{
                id: 'tone',
                order: 250,
                budget: 120,
                text: 'Tone: unforgiving. {{location}} remembers.',
                when: { npcPresent: ['Kira'], location: 'Tavern', inCombat: true, sceneTag: ['tense'] },
                suppresses: ['gm.reminder'],
            }],
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        expect(mods[0]).toMatchObject({
            id: 'grimdark-tone',
            name: 'Grimdark Tone',
            version: '1.0.0',
            appVersion: '>=0.9.0',
            description: 'Harsher consequences, lasting wounds.',
            file: 'grimdark/manifest.json',
        });
        expect(mods[0].contributions[0]).toEqual({
            id: 'tone',
            order: 250,
            budget: 120,
            text: 'Tone: unforgiving. {{location}} remembers.',
            when: { npcPresent: ['Kira'], location: 'Tavern', inCombat: true, sceneTag: ['tense'] },
            suppresses: ['gm.reminder'],
        });
    });

    it('accepts a contribution with no budget — the registry supplies the default', () => {
        write('a', validMod({ contributions: [{ id: 'tone', order: 250, text: 'x' }] }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].budget).toBeUndefined();
    });

    it('normalises a missing description to an empty string', () => {
        write('a', validMod({ description: undefined }));
        expect(loadMods(dir, '1.0.4').mods[0].description).toBe('');
    });

    it('ignores non-mod files and reports stray flat mod files', () => {
        write('grimdark', validMod());
        writeRawFile('notes.json', { id: 'x' });
        writeRawFile('README.md', '# not a mod');

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(mods.map((m) => m.id)).toEqual(['grimdark-tone']);
        expect(faults).toEqual([]);
    });

    it('reports flat mod file deprecation fault', () => {
        writeRawFile('stray.mod.json', validMod());
        const { faults } = loadMods(dir, '1.0.4');
        expect(faults).toHaveLength(1);
        expect(faults[0].reason).toMatch(/flat mod files are no longer supported/);
    });

    // Phase 1.3 / MANIFEST.md §6.3 — resolved order is topological over
    // `dependencies` with `loadOrder` ascending then `id` ascending as the
    // tie-break. With no dependencies and equal `loadOrder` (default 0), mods
    // sort by `id` ascending. This replaces the old folder-name sort; the
    // folder is a path only, and the manifest `id` is authoritative (§6.1).
    it('loads several mods and sorts them by id ascending when loadOrder is equal', () => {
        write('b', validMod({ id: 'beta' }));
        write('a', validMod({ id: 'alpha' }));
        write('c', validMod({ id: 'gamma' }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id)).toEqual(['alpha', 'beta', 'gamma']);
    });

    it('sorts by id ascending even when folder order would give a different result', () => {
        // Folder order is a-good, c-good, b-good. Id-ascending order is
        // alsogood, good, zeta. The old folder sort returned good, zeta,
        // alsogood; §6.3 returns alsogood, good, zeta.
        write('a-good', validMod({ id: 'good' }));
        write('c-good', validMod({ id: 'zeta' }));
        write('b-good', validMod({ id: 'alsogood' }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id)).toEqual(['alsogood', 'good', 'zeta']);
    });
});

describe('loadMods — fail-safe', () => {
    it('returns empty for a missing mods directory, and does not create it', () => {
        const missing = path.join(dir, 'does-not-exist');

        expect(loadMods(missing, '1.0.4')).toEqual({ mods: [], faults: [] });
        expect(fs.existsSync(missing)).toBe(false);
    });

    it('turns malformed JSON into a fault instead of throwing', () => {
        write('broken', '{ "id": "broken", ');

        const result = loadMods(dir, '1.0.4');

        expect(result.faults[0].file).toBe('broken/manifest.json');
        expect(result.faults[0].reason).toMatch(/invalid JSON/i);
    });

    it('keeps loading the good mods when one file is bad', () => {
        write('a-good', validMod({ id: 'good' }));
        write('b-bad', '{ "id": "bad", ');
        write('c-good', validMod({ id: 'alsogood' }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        // §6.3: survivors sort by id ascending, not folder name. The old
        // folder sort returned ['good', 'alsogood']; the resolved order is
        // ['alsogood', 'good'].
        expect(mods.map((m) => m.id)).toEqual(['alsogood', 'good']);
        expect(faults.map((f) => f.file)).toEqual(['b-bad/manifest.json']);
    });

    it.each([
        ['a JSON array', '[]'],
        ['a JSON string', '"hello"'],
        ['JSON null', 'null'],
        ['a JSON number', '42'],
    ])('rejects %s at the root without throwing', (_label, body) => {
        write('x.mod.json', body);
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/JSON object/i);
    });
});

describe('loadMods — mod-level validation', () => {
    it.each([
        ['id', /^id must be a non-empty string$/],
        ['name', /^name must be a non-empty string$/],
        ['version', /^version must be a non-empty string$/],
    ])('rejects a missing %s', (field, expected) => {
        write('x.mod.json', validMod({ [field]: undefined }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it.each([
        ['a number', 7],
        ['an empty string', '   '],
        ['an object', {}],
    ])('rejects an id that is %s', (_label, value) => {
        write('x.mod.json', validMod({ id: value }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/^id must be a non-empty string$/);
    });

    it('rejects an id containing a dot, which would forge a namespace', () => {
        write('x.mod.json', validMod({ id: 'grimdark.tone' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/may contain only letters/i);
    });

    it('rejects a non-string description', () => {
        write('x.mod.json', validMod({ description: 12 }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/description must be a string/i);
    });

    it.each([
        ['not an array', { id: 'tone' }],
        ['empty', []],
    ])('rejects contributions that are %s', (_label, value) => {
        write('x.mod.json', validMod({ contributions: value }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/contributions must be a non-empty array/i);
    });

    // Phase 1.3 / MANIFEST.md §7.5 — `contributions` is now OPTIONAL. A mod
    // with no contributions and no other declarations hits the "declares
    // nothing" rule (§2), which replaces the old required-non-empty-array
    // rule's accidental typo detection. A mod with no contributions but WITH
    // other declarations (tables, panels, screens, compute, native, i18n) is
    // valid — a native-only mod contributes no prompt text.
    it('rejects a mod that declares nothing (contributions absent, no other declarations)', () => {
        write('x.mod.json', { id: 'x', name: 'X', version: '1.0.0' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/manifest declares nothing — a mod must declare at least one of contributions, tables, panels, screens, compute, native, i18n/i);
    });

    it('accepts a mod with no contributions but a declared table (contributions is optional)', () => {
        write('x', { id: 'x', name: 'X', version: '1.0.0', tables: [{ name: 'things', recordShape: 'array' }] });
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions).toEqual([]);
    });

    it('rejects the later file when two mods claim the same id, keeping the first', () => {
        write('a.mod.json', validMod({ id: 'twin', name: 'First' }));
        write('b.mod.json', validMod({ id: 'twin', name: 'Second' }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(mods).toHaveLength(1);
        expect(mods[0].name).toBe('First');
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('b/manifest.json');
        expect(faults[0].reason).toMatch(/duplicate mod id "twin" \(already declared by a\/manifest\.json\)/);
    });
});

describe('loadMods — contribution validation', () => {
    const withContribution = (contribution) => validMod({ contributions: [contribution] });

    it.each([
        ['a missing id', { order: 1, text: 'x' }, /contributions\[0\]\.id must be a non-empty string/],
        ['a dotted id', { id: 'a.b', order: 1, text: 'x' }, /contributions\[0\]\.id .* may contain only letters/],
        ['a missing order', { id: 'a', text: 'x' }, /contributions\[0\]\.order must be a finite number/],
        ['a string order', { id: 'a', order: '250', text: 'x' }, /order must be a finite number/],
        ['a NaN order', { id: 'a', order: Number.NaN, text: 'x' }, /order must be a finite number/],
        ['a missing text', { id: 'a', order: 1 }, /contributions\[0\]\.text must be a non-empty string/],
        ['an empty text', { id: 'a', order: 1, text: '   ' }, /text must be a non-empty string/],
        ['a zero budget', { id: 'a', order: 1, text: 'x', budget: 0 }, /budget must be a positive finite number/],
        ['a negative budget', { id: 'a', order: 1, text: 'x', budget: -5 }, /budget must be a positive/],
        ['a string budget', { id: 'a', order: 1, text: 'x', budget: '120' }, /budget must be a positive/],
        ['a non-object', 'just a string', /contributions\[0\] must be an object/],
    ])('rejects %s', (_label, contribution, expected) => {
        write('x', withContribution(contribution));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('rejects two contributions sharing an id', () => {
        write('x', validMod({
            contributions: [
                { id: 'tone', order: 1, text: 'a' },
                { id: 'tone', order: 2, text: 'b' },
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/duplicate contribution id "tone"/);
    });

    it('rejects the whole file when a single contribution is bad', () => {
        write('x', validMod({
            contributions: [
                { id: 'good', order: 1, text: 'fine' },
                { id: 'bad', order: 'nope', text: 'also fine' },
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/contributions\[1\]\.order/);
    });
});

describe('loadMods — `when` validation', () => {
    const withWhen = (when) => validMod({ contributions: [{ id: 'a', order: 1, text: 'x', when }] });

    it.each([
        ['a non-object when', 'tense', /when must be an object/],
        ['an unknown key', { sceneTags: ['tense'] }, /unknown key "sceneTags"/],
        ['a non-boolean inCombat', { inCombat: 'yes' }, /when\.inCombat must be a boolean/],
        ['an empty npcPresent array', { npcPresent: [] }, /must not be an empty array/],
        ['a numeric location', { location: 3 }, /when\.location must be a non-empty string/],
        ['an array with a blank entry', { sceneTag: ['tense', ''] }, /when\.sceneTag must be a non-empty string/],
    ])('rejects %s', (_label, when, expected) => {
        write('x', withWhen(when));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('accepts an empty when object (always active)', () => {
        write('x', withWhen({}));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].when).toEqual({});
    });

    it('accepts scalar and array forms of the string keys', () => {
        write('x', withWhen({ npcPresent: 'Kira', sceneTag: ['tense', 'night'] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].when).toEqual({ npcPresent: 'Kira', sceneTag: ['tense', 'night'] });
    });
});

describe('loadMods — suppression guard', () => {
    const suppressing = (suppresses) =>
        validMod({ contributions: [{ id: 'a', order: 1, text: 'x', suppresses }] });

    it.each(PROTECTED_SUPPRESSION_IDS)('rejects a mod that suppresses the structural built-in %s', (id) => {
        write('x', suppressing([id]));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(new RegExp(`may not target the structural built-in "${id.replace('.', '\\.')}"`));
    });

    it('rejects a protected id however it is cased or padded', () => {
        write('x', suppressing([' User.Message ']));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/may not target the structural built-in/);
    });

    it('rejects the file when ANY entry is protected', () => {
        write('x', suppressing(['gm.reminder', 'absolute.command']));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/absolute\.command/);
    });

    it('allows suppressing non-structural built-ins verbatim', () => {
        write('x', suppressing(['gm.reminder', 'watchdog.nudge', 'director.brief']));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].suppresses).toEqual(['gm.reminder', 'watchdog.nudge', 'director.brief']);
    });

    it.each([
        ['a non-array', 'gm.reminder', /suppresses must be an array/],
        ['a blank entry', ['gm.reminder', ' '], /suppresses must contain only non-empty/],
        ['a numeric entry', [7], /suppresses must contain only non-empty/],
    ])('rejects suppresses given as %s', (_label, suppresses, expected) => {
        write('x', suppressing(suppresses));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });
});

describe('loadMods — appVersion compatibility', () => {
    const withAppVersion = (appVersion) => validMod({ appVersion });

    it.each([
        ['absent', undefined],
        ['a wildcard', '*'],
        ['a satisfied floor', '>=0.9.0'],
        ['an exactly-met floor', '>=1.0.4'],
        ['a two-part floor', '>=0.9'],
        ['a spaced floor', '>= 1.0.0'],
    ])('accepts %s', (_label, appVersion) => {
        write('x', withAppVersion(appVersion));
        expect(loadMods(dir, '1.0.4').faults).toEqual([]);
    });

    it('rejects a mod that needs a newer app', () => {
        write('x', withAppVersion('>=2.0.0'));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toBe('requires app version >=2.0.0, but this app is 1.0.4');
    });

    it('compares minor and patch, not just major', () => {
        write('x', withAppVersion('>=1.0.5'));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/requires app version >=1\.0\.5/);
    });

    it.each([
        ['a caret range', '^1.0.0'],
        ['a tilde range', '~1.0.0'],
        ['a bare version', '1.0.0'],
        ['an upper bound', '<2.0.0'],
        ['a compound range', '>=1.0.0 <2.0.0'],
    ])('rejects %s as unsupported', (_label, appVersion) => {
        write('x', withAppVersion(appVersion));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/unsupported appVersion/);
    });

    it('rejects a non-string appVersion', () => {
        write('x', withAppVersion(1));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/appVersion must be a non-empty string/);
    });

    it('skips the check when the host version is unknown rather than rejecting', () => {
        write('x', withAppVersion('>=99.0.0'));
        expect(loadMods(dir, undefined).faults).toEqual([]);
    });
});

describe('loadMods — compute mods', () => {
    it('loads compute metadata and carries the sibling source as text', () => {
        write('arc', validMod({
            id: 'arc',
            tables: [{ name: 'arcs', recordShape: 'array' }],
            compute: {
                file: 'compute.js',
                hook: 'postTurn',
                capabilities: ['write:updateContext', 'table:read:mod.arc.arcs'],
            },
        }), { 'compute.js': 'export default async function () { return { ok: true }; }' });

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(faults).toEqual([]);
        expect(mods[0].compute).toEqual({
            file: 'compute.js',
            hook: 'postTurn',
            capabilities: ['write:updateContext', 'table:read:mod.arc.arcs'],
        });
        expect(mods[0].computeSource).toBe('export default async function () { return { ok: true }; }');
    });

    it('leaves data-only mods without compute metadata or source', () => {
        write('data', validMod());

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(faults).toEqual([]);
        expect(mods[0].compute).toBeUndefined();
        expect(mods[0].computeSource).toBeUndefined();
    });

    it.each([
        ['a non-object compute block', 'bad', /compute must be an object/],
        ['a missing source file', { hook: 'postTurn', capabilities: [] }, /compute\.file must be a non-empty string/],
        ['a non-postTurn hook', { file: 'x.js', hook: 'beforeTurn', capabilities: [] }, /compute\.hook must be "postTurn"/],
        ['a non-array capability list', { file: 'x.js', hook: 'postTurn', capabilities: 'write:updateContext' }, /compute\.capabilities must be an array/],
        ['a malformed capability', { file: 'x.js', hook: 'postTurn', capabilities: ['write'] }, /must be write:<name>/],
        ['an unknown model role', { file: 'x.js', hook: 'postTurn', capabilities: ['model:unknown'] }, /unknown model role/],
        ['an undeclared write', { file: 'x.js', hook: 'postTurn', capabilities: ['write:nope'] }, /unknown write "nope"/],
        ['an unavailable table', { file: 'x.js', hook: 'postTurn', capabilities: ['table:write:divergence'] }, /unavailable write table "divergence"/],
    ])('rejects %s', (_label, compute, expected) => {
        write('x', validMod({ compute }));

        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it.each(['../outside.js', 'nested\\x.js', '/x.js'])('rejects a compute path that is not relative or uses backslashes: %s', (file) => {
        write('x', validMod({ compute: { file, hook: 'postTurn', capabilities: [] } }));

        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/relative path using forward slashes inside the mod's own folder/);
    });

    it('rejects a missing sibling compute source as a fault', () => {
        write('x', validMod({ compute: { file: 'missing.js', hook: 'postTurn', capabilities: [] } }));

        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/compute\.file "missing\.js" could not be read/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// WO-P5-05 — mod-declared data tables. Tests for Step 1 (validation only).
//
// The contract under test is §2 of the work order: the modder NEVER supplies a
// path. A mod declares a table `name`; the app computes the file suffix. The
// manifest has no `fileSuffix` field and must not accept one. No mod-supplied
// functions either. Every attack string below must be a REJECTION with a
// clear reason, never a crash.
// ─────────────────────────────────────────────────────────────────────────────
describe('loadMods — tables validation (WO-P5-05 Step 1)', () => {
    const withTables = (tables) => validMod({ tables });

    it('accepts a mod with no tables field (the common case today)', () => {
        write('x.mod.json', validMod());
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].tables).toEqual([]);
    });

    it('accepts an empty tables array', () => {
        write('x.mod.json', withTables([]));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].tables).toEqual([]);
    });

    it('loads a valid table declaration with every field preserved', () => {
        write('x.mod.json', withTables([
            { name: 'powers', recordShape: 'array', label: 'Powers', reads: ['npcs'], writes: ['state'] },
            { name: 'cfg', recordShape: 'single-object' },
        ]));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].tables).toEqual([
            { name: 'powers', recordShape: 'array', label: 'Powers', reads: ['npcs'], writes: ['state'] },
            { name: 'cfg', recordShape: 'single-object' },
        ]);
    });

    it('accepts a table with only the required fields', () => {
        write('x.mod.json', withTables([{ name: 'things', recordShape: 'array' }]));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].tables).toEqual([{ name: 'things', recordShape: 'array' }]);
    });

    // ── §2 attack suite: every case is a REJECTION, never a crash ──────────
    it.each([
        // Attack 1: fileSuffix supplied as ".state.json" — would silently
        // overwrite campaign state on every save. Blocked: suffix is derived,
        // never supplied. The field is forbidden, full stop.
        ['a fileSuffix field (".state.json" overwrite)', [{ name: 'powers', recordShape: 'array', fileSuffix: '.state.json' }], /fileSuffix is not allowed/],
        // Attack 2: fileSuffix as a path traversal out of the campaigns dir.
        ['a fileSuffix path traversal', [{ name: 'powers', recordShape: 'array', fileSuffix: '../../../../vault.json' }], /fileSuffix is not allowed/],
        // Attack 3: a `path` field (same attack, alternate key name).
        ['a path field', [{ name: 'powers', recordShape: 'array', path: '../evil.json' }], /path is not allowed/],
        // Attack 4: a `filePath` field (same attack, third key name).
        ['a filePath field', [{ name: 'powers', recordShape: 'array', filePath: '../evil.json' }], /filePath is not allowed/],
        // Attack 5: a name with a dot — would forge the namespace if the app
        // naively derived the suffix as `.${name}.json` (yielding `.state.json`
        // for name "state"). ID_REGEX rejects the dot.
        ['a dotted name (namespace forge)', [{ name: 'a.state', recordShape: 'array' }], /may contain only letters/],
        // Attack 6: a name with a slash — path traversal via the name.
        ['a slashed name (traversal)', [{ name: '../vault', recordShape: 'array' }], /may contain only letters/],
        // Attack 7: a name with ".." — traversal via the name.
        ['a dotdot name (traversal)', [{ name: '....', recordShape: 'array' }], /may contain only letters/],
        // Attack 8: two tables in the same mod claiming the same name — the
        // second would clobber the first's file on every save.
        ['a duplicate table name', [{ name: 'powers', recordShape: 'array' }, { name: 'powers', recordShape: 'single-object' }], /declared more than once/],
        // Attack 9: a mod-supplied serverSchema. §2: a mod table is data only;
        // a schema touchpoint is a function the app would invoke, and letting
        // mod code in here is the accident this plan exists to prevent. A mod
        // file is JSON, so this arrives as an object/string, not a function —
        // but the field is forbidden regardless of value type.
        ['a serverSchema field', [{ name: 'powers', recordShape: 'array', serverSchema: {} }], /serverSchema is not allowed/],
        // Attack 10: a mod-supplied clientSchema.
        ['a clientSchema field', [{ name: 'powers', recordShape: 'array', clientSchema: 'normalize' }], /clientSchema is not allowed/],
        // Attack 11: a mod-supplied hooks map.
        ['a hooks map', [{ name: 'powers', recordShape: 'array', hooks: { onBeforeWrite: 'x' } }], /hooks is not allowed/],
        // Attack 12: a mod-supplied onRemove side effect.
        ['an onRemove field', [{ name: 'powers', recordShape: 'array', onRemove: 'cleanup' }], /onRemove is not allowed/],
        // Attack 13: a name colliding with a built-in table name (`npcs`).
        // The `mod-` prefix already makes this unreachable; the name regex
        // alone does NOT block it (npcs is a valid id string). The assert-
        // not-built-in check is Step 2; here we only verify the name is a
        // valid id. A built-in collision is rejected at registration.
        // (This case is accepted at Step 1; Step 2 rejects it.)
    ])('rejects %s', (_label, tables, expected) => {
        write('x.mod.json', withTables(tables));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('rejects a non-array tables field', () => {
        write('x.mod.json', withTables({ name: 'powers' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/tables must be an array/);
    });

    it('rejects a table entry that is not an object', () => {
        write('x.mod.json', withTables(['just a string']));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/tables\[0\] must be an object/);
    });

    it.each([
        ['missing', undefined],
        ['a number', 7],
        ['an empty string', '   '],
        ['an object', {}],
    ])('rejects a table name that is %s', (_label, name) => {
        write('x.mod.json', withTables([{ name, recordShape: 'array' }]));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/tables\[0\]\.name must be a non-empty string/);
    });

    it.each([
        ['missing', undefined],
        ['a number', 7],
        ['an invalid string', 'list'],
        ['an object', {}],
    ])('rejects a recordShape that is %s', (_label, recordShape) => {
        write('x.mod.json', withTables([{ name: 'powers', recordShape }]));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/recordShape/);
    });

    it('rejects a non-string label', () => {
        write('x.mod.json', withTables([{ name: 'powers', recordShape: 'array', label: 12 }]));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/label must be a string/);
    });

    it.each([
        ['a non-array', 'npcs'],
        ['an array with a number', [7]],
        ['an array with an empty string', ['']],
    ])('rejects reads given as %s', (_label, reads) => {
        write('x.mod.json', withTables([{ name: 'powers', recordShape: 'array', reads }]));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/reads/);
    });

    it.each([
        ['a non-array', 'npcs'],
        ['an array with a number', [7]],
        ['an array with an empty string', ['']],
    ])('rejects writes given as %s', (_label, writes) => {
        write('x.mod.json', withTables([{ name: 'powers', recordShape: 'array', writes }]));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/writes/);
    });

    it('rejects an unknown field on a table declaration', () => {
        write('x.mod.json', withTables([{ name: 'powers', recordShape: 'array', future: 'oops' }]));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/unknown field "future"/);
    });

    it('keeps loading the good mods when one file has a bad table', () => {
        write('a-good.mod.json', validMod({ id: 'good' }));
        write('b-bad.mod.json', validMod({
            id: 'bad',
            tables: [{ name: 'powers', recordShape: 'array', fileSuffix: '.state.json' }],
        }));
        write('c-good.mod.json', validMod({ id: 'alsogood' }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        // §6.3: survivors sort by id ascending. Old folder sort returned
        // ['good', 'alsogood']; resolved order is ['alsogood', 'good'].
        expect(mods.map((m) => m.id)).toEqual(['alsogood', 'good']);
        expect(faults.map((f) => f.file)).toEqual(['b-bad/manifest.json']);
        expect(faults[0].reason).toMatch(/fileSuffix is not allowed/);
    });

    it('rejects the whole file when a single table entry is bad', () => {
        write('x.mod.json', validMod({
            tables: [
                { name: 'good', recordShape: 'array' },
                { name: 'bad', recordShape: 'array', fileSuffix: '.x.json' },
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/tables\[1\]\.fileSuffix/);
    });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1.3 — folder discovery, load order, and dependencies.
//
// The contract under test is MANIFEST.md §6.3 (resolved load order is
// topological over `dependencies`, tie-broken by `loadOrder` ascending then
// `id` ascending) and §6.4 (dependencies: present, loaded, version-satisfied,
// no cycles). Every test below is a "Done when" item from the phase work
// order. The fail-safe contract still holds: a faulted mod never takes down
// independent mods.
// ─────────────────────────────────────────────────────────────────────────────
describe('loadMods — Phase 1.3 folder discovery', () => {
    it('rejects a directory without manifest.json as a fault, not a silent skip', () => {
        // A real folder with junk in it — not a dotfile, not a stray .mod.json.
        const modFolder = path.join(dir, 'no-manifest');
        fs.mkdirSync(modFolder, { recursive: true });
        fs.writeFileSync(path.join(modFolder, 'README.md'), '# not a mod');

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(mods).toEqual([]);
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('no-manifest');
        expect(faults[0].reason).toMatch(/directory "no-manifest" contains no manifest\.json — a mod folder must contain one/);
    });

    it('ignores dot-directories silently (e.g. .git, .DS_Store)', () => {
        fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.git', 'config'), '[core]');

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods).toEqual([]);
    });

    it('carries the mod folder name and absolute path on the validated mod', () => {
        write('arc-like', validMod({ id: 'arc' }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].folder).toBe('arc-like');
        expect(typeof mods[0].folderPath).toBe('string');
        expect(mods[0].folderPath).toContain('arc-like');
    });
});

describe('loadMods — Phase 1.3 loadOrder', () => {
    it('respects loadOrder: lower runs first', () => {
        write('a', validMod({ id: 'alpha', loadOrder: 100 }));
        write('b', validMod({ id: 'beta', loadOrder: -5 }));
        write('c', validMod({ id: 'gamma', loadOrder: 50 }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id))
            .toEqual(['beta', 'gamma', 'alpha']);
    });

    it('respects loadOrder over id: a higher loadOrder always runs later', () => {
        // id-ascending would give ['aaa', 'zzz']; loadOrder inverts it.
        write('a', validMod({ id: 'zzz', loadOrder: 0 }));
        write('b', validMod({ id: 'aaa', loadOrder: 10 }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id)).toEqual(['zzz', 'aaa']);
    });

    it('two mods with equal loadOrder sort deterministically by id ascending', () => {
        write('a', validMod({ id: 'zeta', loadOrder: 0 }));
        write('b', validMod({ id: 'alpha', loadOrder: 0 }));
        write('c', validMod({ id: 'mid', loadOrder: 0 }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id))
            .toEqual(['alpha', 'mid', 'zeta']);
    });

    it('two mods with equal loadOrder sort by id even when folder order differs', () => {
        // Folder order: z-folder, a-folder, m-folder. Id-ascending: a, m, z.
        write('z-folder', validMod({ id: 'aaa' }));
        write('a-folder', validMod({ id: 'mmm' }));
        write('m-folder', validMod({ id: 'zzz' }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id))
            .toEqual(['aaa', 'mmm', 'zzz']);
    });

    it('rejects a non-integer loadOrder', () => {
        write('x', validMod({ loadOrder: 1.5 }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/loadOrder must be an integer/);
    });

    it('rejects a string loadOrder', () => {
        write('x', validMod({ loadOrder: '0' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/loadOrder must be an integer/);
    });

    it('accepts a negative loadOrder', () => {
        write('a', validMod({ id: 'a', loadOrder: -100 }));
        write('b', validMod({ id: 'b', loadOrder: 0 }));
        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id)).toEqual(['a', 'b']);
    });

    it('defaults loadOrder to 0 when absent', () => {
        write('x', validMod());
        const { mods } = loadMods(dir, '1.0.4');
        expect(mods[0].loadOrder).toBe(0);
    });
});

// Phase 6.2 — user load-order override. The third argument to `loadMods`
// is the user-chosen order (array of ids). It is the PRIMARY tiebreak in
// the topological sort: a mod earlier in `userOrder` emits before a mod
// later in `userOrder`, regardless of manifest `loadOrder`. The dependency
// graph is still a hard constraint — a dependency always precedes its
// dependent — so the override only reorders mods that are simultaneously
// ready. This is exactly the "override persists and beats the manifest
// value" rule (Phase 6.2 §2.2).
describe('loadMods — Phase 6.2 user load-order override', () => {
    it('with no userOrder, preserves the manifest loadOrder default', () => {
        write('a', validMod({ id: 'alpha', loadOrder: 100 }));
        write('b', validMod({ id: 'beta', loadOrder: -5 }));
        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id))
            .toEqual(['beta', 'alpha']);
    });

    it('with an empty userOrder array, preserves the manifest default', () => {
        write('a', validMod({ id: 'alpha', loadOrder: 100 }));
        write('b', validMod({ id: 'beta', loadOrder: -5 }));
        expect(loadMods(dir, '1.0.4', []).mods.map((m) => m.id))
            .toEqual(['beta', 'alpha']);
    });

    it('userOrder overrides manifest loadOrder as the primary tiebreak', () => {
        // Manifest: beta (-5) before alpha (100). User says the opposite.
        write('a', validMod({ id: 'alpha', loadOrder: 100 }));
        write('b', validMod({ id: 'beta', loadOrder: -5 }));
        expect(loadMods(dir, '1.0.4', ['alpha', 'beta']).mods.map((m) => m.id))
            .toEqual(['alpha', 'beta']);
    });

    it('userOrder does not violate the dependency graph (dep still first)', () => {
        // 'need' depends on 'dep'. User puts 'need' first in the override.
        // The topological sort must still emit 'dep' before 'need'.
        write('dep', validMod({ id: 'dep', loadOrder: 100 }));
        write('need', validMod({
            id: 'need',
            loadOrder: 0,
            dependencies: { dep: '*' },
        }));
        expect(loadMods(dir, '1.0.4', ['need', 'dep']).mods.map((m) => m.id))
            .toEqual(['dep', 'need']);
    });

    it('userOrder reorders mods that are simultaneously ready (no dep between them)', () => {
        // Two independent mods; user inverts the manifest order.
        write('a', validMod({ id: 'a', loadOrder: 0 }));
        write('b', validMod({ id: 'b', loadOrder: 0 }));
        // Manifest default: ['a', 'b'] (id ascending). User says ['b', 'a'].
        expect(loadMods(dir, '1.0.4', ['b', 'a']).mods.map((m) => m.id))
            .toEqual(['b', 'a']);
    });

    it('mods not in userOrder fall back to loadOrder then id, after listed mods', () => {
        // Three independent mods. User lists only 'c' first.
        write('a', validMod({ id: 'a', loadOrder: 0 }));
        write('b', validMod({ id: 'b', loadOrder: 0 }));
        write('c', validMod({ id: 'c', loadOrder: 0 }));
        // 'c' is listed → sorts first. 'a' and 'b' unlisted → fall back to
        // id ascending among themselves, after 'c'.
        expect(loadMods(dir, '1.0.4', ['c']).mods.map((m) => m.id))
            .toEqual(['c', 'a', 'b']);
    });

    it('a partial userOrder that lists only some mods still respects deps', () => {
        // 'need' depends on 'dep'. User lists 'dep' but not 'need'.
        // 'dep' sorts first (it is listed); 'need' follows (unlisted, but
        // its dep is satisfied).
        write('dep', validMod({ id: 'dep', loadOrder: 100 }));
        write('need', validMod({
            id: 'need',
            loadOrder: 0,
            dependencies: { dep: '*' },
        }));
        expect(loadMods(dir, '1.0.4', ['dep']).mods.map((m) => m.id))
            .toEqual(['dep', 'need']);
    });

    it('userOrder ids not installed are ignored (no fault, no effect)', () => {
        write('a', validMod({ id: 'a', loadOrder: 0 }));
        // 'ghost' is not on disk; it should be silently ignored.
        expect(loadMods(dir, '1.0.4', ['ghost', 'a']).mods.map((m) => m.id))
            .toEqual(['a']);
    });

    it('userOrder is the tiebreak BETWEEN ready mods; loadOrder breaks ties among unlisted', () => {
        // 'a' (loadOrder 0, unlisted), 'b' (loadOrder 10, unlisted),
        // 'c' (loadOrder 5, listed first).
        // 'c' is ready and listed → first. 'a' and 'b' are unlisted →
        // loadOrder ascending: 'a' (0) before 'b' (10).
        write('a', validMod({ id: 'a', loadOrder: 0 }));
        write('b', validMod({ id: 'b', loadOrder: 10 }));
        write('c', validMod({ id: 'c', loadOrder: 5 }));
        expect(loadMods(dir, '1.0.4', ['c']).mods.map((m) => m.id))
            .toEqual(['c', 'a', 'b']);
    });
});

describe('loadMods — Phase 1.3 dependencies', () => {
    it('rejects a mod whose dependency is not installed, naming the missing dep', () => {
        write('dependent', validMod({
            id: 'dependent',
            dependencies: { 'missing-mod': '>=1.0.0' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods).toHaveLength(0);
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('dependent/manifest.json');
        expect(faults[0].reason).toMatch(/depends on mod "missing-mod", which is not installed/);
    });

    it('keeps independent mods when one mod has a missing dependency', () => {
        write('a', validMod({ id: 'alpha' }));
        write('b', validMod({
            id: 'beta',
            dependencies: { 'no-such': '*' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods.map((m) => m.id)).toEqual(['alpha']);
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('b/manifest.json');
        expect(faults[0].reason).toMatch(/depends on mod "no-such", which is not installed/);
    });

    it('rejects a self-dependency', () => {
        write('x', validMod({
            id: 'selfish',
            dependencies: { 'selfish': '>=1.0.0' },
        }));

        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/dependencies names "selfish", which is this mod/);
    });

    it('rejects a version-unsatisfied dependency, naming the range and the installed version', () => {
        write('dep', validMod({ id: 'dep', version: '1.0.0' }));
        write('need', validMod({
            id: 'need',
            dependencies: { 'dep': '>=2.0.0' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods).toHaveLength(1);
        expect(mods[0].id).toBe('dep');
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('need/manifest.json');
        expect(faults[0].reason).toMatch(/depends on mod "dep" >=2\.0\.0, but the installed version is 1\.0\.0/);
    });

    it('accepts a satisfied dependency (>= floor met)', () => {
        write('dep', validMod({ id: 'dep', version: '1.2.3' }));
        write('need', validMod({
            id: 'need',
            dependencies: { 'dep': '>=1.0.0' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        // Dependency precedes dependent regardless of loadOrder/folder.
        expect(mods.map((m) => m.id)).toEqual(['dep', 'need']);
    });

    it('accepts a wildcard dependency range', () => {
        write('dep', validMod({ id: 'dep', version: '0.1.0' }));
        write('need', validMod({
            id: 'need',
            dependencies: { 'dep': '*' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id)).toEqual(['dep', 'need']);
    });

    it('dependency runs before dependent even when its loadOrder is higher', () => {
        // §6.3: the dependency graph is a constraint, loadOrder is the tie-break.
        // dep has loadOrder 100, dependent has loadOrder 0, but dependent needs dep.
        write('dep', validMod({ id: 'dep', loadOrder: 100 }));
        write('need', validMod({
            id: 'need',
            loadOrder: 0,
            dependencies: { 'dep': '*' },
        }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id)).toEqual(['dep', 'need']);
    });

    it('cascades drops: a mod whose dependency was dropped also drops', () => {
        // chain: c -> b -> a, a is missing. b drops (a missing), c drops (b dropped).
        write('b', validMod({
            id: 'b',
            dependencies: { 'a': '*' },
        }));
        write('c', validMod({
            id: 'c',
            dependencies: { 'b': '*' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods).toHaveLength(0);
        // Two faults: b (a missing) and c (b failed to load).
        expect(faults).toHaveLength(2);
        const reasons = faults.map((f) => f.reason).join('\n');
        expect(reasons).toMatch(/depends on mod "a", which is not installed/);
        expect(reasons).toMatch(/depends on mod "b", which failed to load/);
    });

    it('detects a two-mod dependency cycle and rejects both, naming both ids', () => {
        write('a', validMod({
            id: 'alpha',
            dependencies: { 'beta': '*' },
        }));
        write('b', validMod({
            id: 'beta',
            dependencies: { 'alpha': '*' },
        }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods).toHaveLength(0);
        expect(faults).toHaveLength(2);
        const files = faults.map((f) => f.file).sort();
        expect(files).toEqual(['a/manifest.json', 'b/manifest.json']);
        // §11: cycle reason names both ids.
        for (const fault of faults) {
            expect(fault.reason).toMatch(/dependency cycle between "alpha" and "beta"/);
        }
    });

    it('rejects a malformed dependency range', () => {
        write('x', validMod({
            id: 'x',
            dependencies: { 'dep': '^1.0.0' },
        }));

        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/dependencies\["dep"\] "\^1\.0\.0" must be ">=X\.Y\.Z" or "\*"/);
    });

    it('rejects a non-object dependencies field', () => {
        write('x', validMod({ id: 'x', dependencies: ['dep'] }));

        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/dependencies must be an object mapping mod ids to version ranges/);
    });

    it('rejects a dotted dependency key (would forge a namespace)', () => {
        write('x', validMod({
            id: 'x',
            dependencies: { 'dotted.id': '*' },
        }));

        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/dependencies key "dotted\.id" may contain only letters, digits, "_" and "-"/);
    });
});

describe('loadMods — Phase 1.3 manifest version', () => {
    it('rejects a version that is not X.Y.Z', () => {
        write('x', validMod({ version: '1.0' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/version "1\.0" must be X\.Y\.Z, optionally with a "-prerelease" suffix/);
    });

    it('accepts a version with a prerelease suffix', () => {
        write('x', validMod({ version: '2.1.0-rc.1' }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].version).toBe('2.1.0-rc.1');
    });

    it('accepts a plain X.Y.Z version', () => {
        write('x', validMod({ version: '1.2.3' }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].version).toBe('1.2.3');
    });
});

describe('loadMods — Phase 1.3 author and homepage', () => {
    it('accepts author and homepage', () => {
        write('x', validMod({ author: 'Jane', homepage: 'https://example.invalid/x' }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].author).toBe('Jane');
        expect(mods[0].homepage).toBe('https://example.invalid/x');
    });

    it('rejects an empty author', () => {
        write('x', validMod({ author: '   ' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/author must be a non-empty string/);
    });

    it('rejects a non-http homepage', () => {
        write('x', validMod({ homepage: 'ftp://example.invalid/x' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/homepage "ftp:\/\/example\.invalid\/x" must be an http or https URL/);
    });

    it('rejects a non-string homepage', () => {
        write('x', validMod({ homepage: 7 }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/homepage .* must be an http or https URL/);
    });
});

describe('loadMods — Phase 1.3 unknown top-level keys', () => {
    it('rejects an unknown top-level key', () => {
        write('x', validMod({ futureField: 'oops' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "futureField" — see MANIFEST\.md for the field set/);
    });

    it('gives a targeted hint for loading_order (ST spelling)', () => {
        write('x', validMod({ loading_order: 5 }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "loading_order" — this app spells it "loadOrder"/);
    });

    it('gives a targeted hint for display_name (ST spelling)', () => {
        write('x', validMod({ display_name: 'X' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "display_name" — this app spells it "name"/);
    });

    it('gives a targeted hint for minimum_client_version (ST spelling)', () => {
        write('x', validMod({ minimum_client_version: '>=1.0.0' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "minimum_client_version" — this app spells it "appVersion"/);
    });

    it('rejects the declined "assets" key with a targeted message', () => {
        write('x', validMod({ assets: ['x.png'] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "assets" — every file in the mod's folder is available to it; no declaration is needed/);
    });

    it('rejects the declined "permissions" key with a targeted message', () => {
        write('x', validMod({ permissions: ['vault'] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "permissions" — native code runs with the app's own access and a permission list would not constrain it/);
    });

    it('rejects the declined "settings" key with a targeted message', () => {
        write('x', validMod({ settings: { x: 1 } }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "settings" — declare a single-object table and a form panel bound to it/);
    });

    it('rejects a reserved key with the phase that will define it', () => {
        write('x', validMod({ mounts: [] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/field "mounts" is reserved for a later app version \(4\.1\) and is not supported yet/);
    });

    // Phase 3.2 / MANIFEST.md §16 — `events` moved from reserved to declined.
    // Phase 3.1 was the phase that would have defined it, and it declined the
    // key, so the message must say so and point at the working alternative.
    it('rejects the declined "events" key with the ctx.events.on() alternative', () => {
        write('x', validMod({ events: ['turn.start'] }));
        const reason = soleFaultReason(loadMods(dir, '1.0.4'));
        expect(reason).toMatch(/events is not a manifest field — subscribe with ctx\.events\.on\(\) from your activate hook/);
        expect(reason).not.toMatch(/reserved for a later app version/);
    });

    it('rejects top-level hooks (belongs inside native)', () => {
        write('x', validMod({ hooks: { activate: 'onActivate' } }));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/unknown field "hooks" — it belongs inside "native", which requires a native\.js entry point/);
    });

    it('allows x- prefixed keys as the escape hatch (never read, never validated)', () => {
        write('x', validMod({ 'x-built-by': 'tooling', 'x-anything': { nested: true } }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
    });
});

describe('loadMods — Phase 1.3 native tier validation', () => {
    const writeNative = (native, siblingFiles = {}) =>
        write('x', { ...validMod(), contributions: undefined, native }, siblingFiles);

    it('accepts a native-only mod (no contributions, but native declares something)', () => {
        writeNative({ js: 'index.js' }, { 'index.js': 'export function onActivate() {}' });

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].native).toEqual({ js: 'index.js' });
        expect(mods[0].contributions).toEqual([]);
    });

    it('rejects native that is not an object', () => {
        writeNative('not an object');
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/native must be an object/);
    });

    it('rejects native without a js entry point', () => {
        writeNative({ hooks: { activate: 'onActivate' } });
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/native\.js must be a non-empty string/);
    });

    it('rejects a native.js that does not exist on disk', () => {
        writeNative({ js: 'missing.js' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.js "missing\.js" could not be read/);
    });

    it('rejects a native.js that escapes the mod folder (path traversal)', () => {
        writeNative({ js: '../outside.js' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.js "\.\.\/outside\.js" must be a relative path inside the mod's own folder/);
    });

    it('rejects a native.js with a backslash (Windows-authored path)', () => {
        writeNative({ js: 'nested\\\\x.js' }, { 'nested/x.js': 'export {}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.js ".*" must use forward slashes/);
    });

    it('rejects an unknown native hook name', () => {
        writeNative({ js: 'index.js', hooks: { onActivate: 'onActivate' } }, { 'index.js': 'export {}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.hooks has unknown hook "onActivate" \(allowed: install, update, activate, enable, disable, delete, clean\)/);
    });

    it('accepts all seven known hooks', () => {
        writeNative({
            js: 'index.js',
            hooks: {
                install: 'onInstall', update: 'onUpdate', activate: 'onActivate',
                enable: 'onEnable', disable: 'onDisable', delete: 'onDelete', clean: 'onClean',
            },
        }, { 'index.js': 'export {}' });

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(Object.keys(mods[0].native.hooks).sort()).toEqual(
            ['activate', 'clean', 'delete', 'disable', 'enable', 'install', 'update'],
        );
    });

    it('rejects a hook value that is not a string', () => {
        writeNative({ js: 'index.js', hooks: { activate: 7 } }, { 'index.js': 'export {}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.hooks\.activate must name an exported function/);
    });

    it('rejects an empty generateInterceptor', () => {
        writeNative({ js: 'index.js', generateInterceptor: '   ' }, { 'index.js': 'export {}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.generateInterceptor must name an exported function/);
    });

    it('rejects an unknown native key', () => {
        writeNative({ js: 'index.js', future: 'oops' }, { 'index.js': 'export {}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native has unknown field "future" — only js, css, hooks, generateInterceptor are allowed/);
    });

    it('accepts and validates a native.css path', () => {
        writeNative({ js: 'index.js', css: 'style.css' }, {
            'index.js': 'export {}', 'style.css': 'body { color: red; }',
        });
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].native.css).toBe('style.css');
    });

    it('rejects a native.css that does not exist on disk', () => {
        writeNative({ js: 'index.js', css: 'missing.css' }, { 'index.js': 'export {}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/native\.css "missing\.css" could not be read/);
    });
});

describe('loadMods — Phase 1.3 i18n validation', () => {
    const writeI18n = (i18n, siblingFiles = {}) =>
        write('x', { ...validMod(), i18n }, siblingFiles);

    it('accepts a mod with no i18n field (default {})', () => {
        write('x', validMod());
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].i18n).toEqual({});
        expect(mods[0].i18nStrings).toEqual({});
    });

    it('accepts and parses a locale file', () => {
        writeI18n({ en: 'i18n/en.json' }, {
            'i18n/en.json': JSON.stringify({ 'greeting': 'Hello', 'farewell': 'Bye' }),
        });

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].i18n).toEqual({ en: 'i18n/en.json' });
        expect(mods[0].i18nStrings).toEqual({ en: { greeting: 'Hello', farewell: 'Bye' } });
    });

    it('accepts locale codes outside the host\'s six (e.g. fr)', () => {
        writeI18n({ fr: 'fr.json' }, { 'fr.json': JSON.stringify({ hi: 'Bonjour' }) });
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].i18n.fr).toBe('fr.json');
    });

    it('accepts a dashed locale code (e.g. pt-BR)', () => {
        writeI18n({ 'pt-BR': 'pt.json' }, { 'pt.json': JSON.stringify({ hi: 'Oi' }) });
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].i18n['pt-BR']).toBe('pt.json');
    });

    it('rejects a non-object i18n field', () => {
        writeI18n(['en']);
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n must be an object mapping locale codes to translation files/);
    });

    it('rejects a bad locale code', () => {
        writeI18n({ 'not_a_locale!': 'x.json' }, { 'x.json': '{}' });
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/i18n key "not_a_locale!" is not a locale code/);
    });

    it('rejects a non-string i18n value', () => {
        writeI18n({ en: 7 });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n\["en"\] must be a path to a JSON translation file/);
    });

    it('rejects an i18n file that does not exist', () => {
        writeI18n({ en: 'missing.json' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n\["en"\] file "missing\.json" could not be read/);
    });

    it('rejects an i18n file that is not valid JSON', () => {
        writeI18n({ en: 'en.json' }, { 'en.json': '{ broken' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n\["en"\] file "en\.json" is not valid JSON/);
    });

    it('rejects an i18n file that is not a flat string map', () => {
        writeI18n({ en: 'en.json' }, { 'en.json': JSON.stringify({ nested: { a: 1 } }) });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n\["en"\] must be a flat object of string keys to string values/);
    });

    it('rejects an i18n file with a non-string value', () => {
        writeI18n({ en: 'en.json' }, { 'en.json': JSON.stringify({ num: 7 }) });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n\["en"\] must be a flat object of string keys to string values/);
    });

    it('rejects an i18n path that escapes the mod folder', () => {
        writeI18n({ en: '../outside.json' });
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(/i18n\["en"\] "\.\.\/outside\.json" must be a relative path inside the mod's own folder/);
    });
});

// ── Phase 6.3 — bundled vs installed provenance ───────────────────────────
//
// `loadMods` now accepts an optional fourth argument `bundledModsDir`. When
// supplied, that directory is scanned first and every mod in it is tagged
// `provenance: 'bundled'`; the installed dir is scanned second and tagged
// `'installed'`. Both use the same `validateMod` — a bundled mod is not
// special-cased (§3). A duplicate id across the two dirs faults the second
// (installed) copy, so the bundled mod wins. The combined set is then
// topologically sorted together.
//
// `write` places a mod in the installed `dir`; `writeBundled` places one in a
// separate `bundledDir`. Both build the same manifest.json shape.
describe('loadMods — Phase 6.3 bundled vs installed provenance', () => {
    let bundledDir;

    beforeEach(() => {
        bundledDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-bundled-'));
    });

    afterEach(() => {
        fs.rmSync(bundledDir, { recursive: true, force: true });
    });

    const writeBundled = (name, contents, siblingFiles = {}) => {
        let folderName = name;
        if (name.endsWith('/manifest.json')) {
            folderName = name.slice(0, -'/manifest.json'.length);
        }
        const modFolder = path.join(bundledDir, folderName);
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

    it('stamps provenance: "bundled" on bundled-dir mods and "installed" on installed-dir mods', () => {
        writeBundled('bundled-tone', validMod({ id: 'bundled-tone', name: 'Bundled Tone' }));
        write('installed-tone', validMod({ id: 'installed-tone', name: 'Installed Tone' }));

        const { mods, faults } = loadMods(dir, '1.0.4', undefined, bundledDir);

        expect(faults).toEqual([]);
        expect(mods).toHaveLength(2);
        const bundled = mods.find((m) => m.id === 'bundled-tone');
        const installed = mods.find((m) => m.id === 'installed-tone');
        expect(bundled.provenance).toBe('bundled');
        expect(installed.provenance).toBe('installed');
    });

    it('without a bundledModsDir argument, stamps every mod as "installed"', () => {
        write('a', validMod({ id: 'a', name: 'A' }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        expect(mods[0].provenance).toBe('installed');
    });

    it('a missing bundled dir is the normal case, not a fault', () => {
        write('a', validMod({ id: 'a', name: 'A' }));
        const { mods, faults } = loadMods(dir, '1.0.4', undefined, path.join(bundledDir, 'does-not-exist'));
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        expect(mods[0].provenance).toBe('installed');
    });

    it('a duplicate id across bundled and installed faults the installed copy (bundled wins)', () => {
        writeBundled('shared', validMod({ id: 'shared', name: 'Bundled Shared' }));
        write('shared', validMod({ id: 'shared', name: 'Installed Shared' }));

        const { mods, faults } = loadMods(dir, '1.0.4', undefined, bundledDir);

        expect(mods).toHaveLength(1);
        expect(mods[0].name).toBe('Bundled Shared');
        expect(mods[0].provenance).toBe('bundled');
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('shared/manifest.json');
        expect(faults[0].reason).toMatch(/duplicate mod id "shared"/);
    });

    it('applies the same validation to bundled mods — a bad bundled mod faults, installed ones still load', () => {
        writeBundled('bad-bundled', { id: 'bad', name: 'Bad', version: 'not-a-version', contributions: [{ id: 'c', order: 1, text: 'x' }] });
        write('good-installed', validMod({ id: 'good', name: 'Good' }));

        const { mods, faults } = loadMods(dir, '1.0.4', undefined, bundledDir);

        expect(mods).toHaveLength(1);
        expect(mods[0].id).toBe('good');
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('bad-bundled/manifest.json');
        expect(faults[0].reason).toMatch(/version/);
    });

    it('sorts bundled and installed mods together by load order', () => {
        writeBundled('z-bundled', validMod({ id: 'z-bundled', name: 'Z', loadOrder: 0 }));
        write('a-installed', validMod({ id: 'a-installed', name: 'A', loadOrder: 10 }));

        const { mods, faults } = loadMods(dir, '1.0.4', undefined, bundledDir);
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id)).toEqual(['z-bundled', 'a-installed']);
    });

    it('passes the userOrder override to the combined sort', () => {
        writeBundled('bundled-x', validMod({ id: 'bundled-x', name: 'X', loadOrder: 0 }));
        write('installed-y', validMod({ id: 'installed-y', name: 'Y', loadOrder: 10 }));

        const { mods, faults } = loadMods(dir, '1.0.4', ['installed-y', 'bundled-x'], bundledDir);
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id)).toEqual(['installed-y', 'bundled-x']);
    });

    it('a bundled mod with a dependency on an installed mod resolves correctly', () => {
        writeBundled('depender', validMod({
            id: 'depender',
            name: 'Depender',
            dependencies: { base: '>=1.0.0' },
        }));
        write('base', validMod({ id: 'base', name: 'Base', version: '1.0.0' }));

        const { mods, faults } = loadMods(dir, '1.0.4', undefined, bundledDir);
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id)).toEqual(['base', 'depender']);
        expect(mods[0].provenance).toBe('installed');
        expect(mods[1].provenance).toBe('bundled');
    });

    it('an empty bundled dir produces no bundled mods and no fault', () => {
        write('a', validMod({ id: 'a', name: 'A' }));
        // bundledDir exists but is empty (mkdtemp created it)
        const { mods, faults } = loadMods(dir, '1.0.4', undefined, bundledDir);
        expect(faults).toEqual([]);
        expect(mods).toHaveLength(1);
        expect(mods[0].id).toBe('a');
        expect(mods[0].provenance).toBe('installed');
    });
});
// ── MANIFEST.md §2 — the `dev` fixture flag ────────────────────────────────
//
// `dev` marks a mod that exists to exercise the API rather than to be played
// with. The loader's whole job here is to VALIDATE and CARRY it: the flag's
// effect — inverting the enablement default — belongs to `modEnablement.ts` on
// the client, and nothing in the loader may treat a dev mod differently. A
// fixture that stopped loading, sorting, or resolving dependencies normally
// would stop working as the regression test it was written to be.
describe('loadMods — the `dev` fixture flag', () => {
    it('defaults to false when the manifest omits it', () => {
        write('plain', validMod({ id: 'plain', name: 'Plain' }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        // Always present, so no consumer re-applies the absent-means-false rule.
        expect(mods[0].dev).toBe(false);
    });

    it('carries `dev: true` through to the validated mod', () => {
        write('fixture', validMod({ id: 'fixture', name: 'Fixture', dev: true }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].dev).toBe(true);
    });

    it('normalises a non-true value to false rather than carrying it', () => {
        write('fixture', validMod({ id: 'fixture', name: 'Fixture', dev: false }));
        const { mods } = loadMods(dir, '1.0.4');
        expect(mods[0].dev).toBe(false);
    });

    it('rejects a non-boolean `dev`', () => {
        write('bad', validMod({ id: 'bad', name: 'Bad', dev: 'yes' }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/dev must be a boolean/);
    });

    it('a dev mod is otherwise loaded exactly like any other', () => {
        // The point of the flag is that it changes ONE thing. A dev mod still
        // contributes, still sorts by loadOrder, and still resolves as a
        // dependency — `probe` is the cross-phase mount regression test and has
        // to keep working when switched on.
        write('fixture', validMod({
            id: 'fixture',
            name: 'Fixture',
            dev: true,
            loadOrder: -10,
        }));
        write('normal', validMod({ id: 'normal', name: 'Normal', loadOrder: 5 }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        // Sorted by loadOrder, dev flag irrelevant.
        expect(mods.map((m) => m.id)).toEqual(['fixture', 'normal']);
        expect(mods[0].contributions).toHaveLength(1);
    });

    it('a normal mod may depend on a dev mod', () => {
        write('fixture', validMod({ id: 'fixture', name: 'Fixture', dev: true, version: '1.0.0' }));
        write('dependent', validMod({
            id: 'dependent',
            name: 'Dependent',
            dependencies: { fixture: '>=1.0.0' },
        }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods.map((m) => m.id)).toEqual(['fixture', 'dependent']);
    });
});
