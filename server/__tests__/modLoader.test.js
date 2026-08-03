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

const write = (name, contents) => {
    fs.writeFileSync(
        path.join(dir, name),
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
        write('grimdark.mod.json', validMod({
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
            file: 'grimdark.mod.json',
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
        write('a.mod.json', validMod({ contributions: [{ id: 'tone', order: 250, text: 'x' }] }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].budget).toBeUndefined();
    });

    it('normalises a missing description to an empty string', () => {
        write('a.mod.json', validMod({ description: undefined }));
        expect(loadMods(dir, '1.0.4').mods[0].description).toBe('');
    });

    it('ignores files that are not *.mod.json', () => {
        write('grimdark.mod.json', validMod());
        write('notes.json', { id: 'x' });
        write('README.md', '# not a mod');
        fs.mkdirSync(path.join(dir, 'nested.mod.json')); // a directory, not a file

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(mods.map((m) => m.id)).toEqual(['grimdark-tone']);
        expect(faults).toEqual([]);
    });

    it('loads several mods and keeps them in filename order', () => {
        write('b.mod.json', validMod({ id: 'beta' }));
        write('a.mod.json', validMod({ id: 'alpha' }));
        write('c.mod.json', validMod({ id: 'gamma' }));

        expect(loadMods(dir, '1.0.4').mods.map((m) => m.id)).toEqual(['alpha', 'beta', 'gamma']);
    });
});

describe('loadMods — fail-safe', () => {
    it('returns empty for a missing mods directory, and does not create it', () => {
        const missing = path.join(dir, 'does-not-exist');

        expect(loadMods(missing, '1.0.4')).toEqual({ mods: [], faults: [] });
        expect(fs.existsSync(missing)).toBe(false);
    });

    it('turns malformed JSON into a fault instead of throwing', () => {
        write('broken.mod.json', '{ "id": "broken", ');

        const result = loadMods(dir, '1.0.4');

        expect(result.faults[0].file).toBe('broken.mod.json');
        expect(result.faults[0].reason).toMatch(/invalid JSON/i);
    });

    it('keeps loading the good mods when one file is bad', () => {
        write('a-good.mod.json', validMod({ id: 'good' }));
        write('b-bad.mod.json', 'not json at all');
        write('c-good.mod.json', validMod({ id: 'alsogood' }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(mods.map((m) => m.id)).toEqual(['good', 'alsogood']);
        expect(faults.map((f) => f.file)).toEqual(['b-bad.mod.json']);
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
        ['missing', undefined],
        ['not an array', { id: 'tone' }],
        ['empty', []],
    ])('rejects contributions that are %s', (_label, value) => {
        write('x.mod.json', validMod({ contributions: value }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/contributions must be a non-empty array/i);
    });

    it('rejects the later file when two mods claim the same id, keeping the first', () => {
        write('a.mod.json', validMod({ id: 'twin', name: 'First' }));
        write('b.mod.json', validMod({ id: 'twin', name: 'Second' }));

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(mods).toHaveLength(1);
        expect(mods[0].name).toBe('First');
        expect(faults).toHaveLength(1);
        expect(faults[0].file).toBe('b.mod.json');
        expect(faults[0].reason).toMatch(/duplicate mod id "twin" \(already declared by a\.mod\.json\)/);
    });
});

describe('loadMods — contribution validation', () => {
    const withContribution = (contribution) => validMod({ contributions: [contribution] });

    it('accepts a lookup over one of the mod\'s own declared tables', () => {
        write('x.mod.json', validMod({
            tables: [{ name: 'prompt-index', recordShape: 'array' }],
            contributions: [{
                id: 'ability-context',
                order: 150,
                text: 'Relevant abilities:',
                lookup: {
                    table: 'prompt-index',
                    termFields: ['terms'],
                    textField: 'promptText',
                    recentMessages: 8,
                },
            }],
        }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].lookup).toEqual({
            table: 'prompt-index',
            termFields: ['terms'],
            textField: 'promptText',
            recentMessages: 8,
        });
    });

    it('rejects a lookup over an undeclared or foreign table', () => {
        write('x.mod.json', validMod({
            tables: [{ name: 'own', recordShape: 'array' }],
            contributions: [{
                id: 'ability-context', order: 150, text: 'Relevant abilities:',
                lookup: { table: 'foreign', termFields: ['terms'], textField: 'promptText' },
            }],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/lookup\.table "foreign" is not one of/);
    });

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
        write('x.mod.json', withContribution(contribution));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('rejects two contributions sharing an id', () => {
        write('x.mod.json', validMod({
            contributions: [
                { id: 'tone', order: 1, text: 'a' },
                { id: 'tone', order: 2, text: 'b' },
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/duplicate contribution id "tone"/);
    });

    it('rejects the whole file when a single contribution is bad', () => {
        write('x.mod.json', validMod({
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
        write('x.mod.json', withWhen(when));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('accepts an empty when object (always active)', () => {
        write('x.mod.json', withWhen({}));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].when).toEqual({});
    });

    it('accepts scalar and array forms of the string keys', () => {
        write('x.mod.json', withWhen({ npcPresent: 'Kira', sceneTag: ['tense', 'night'] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].when).toEqual({ npcPresent: 'Kira', sceneTag: ['tense', 'night'] });
    });
});

describe('loadMods — suppression guard', () => {
    const suppressing = (suppresses) =>
        validMod({ contributions: [{ id: 'a', order: 1, text: 'x', suppresses }] });

    it.each(PROTECTED_SUPPRESSION_IDS)('rejects a mod that suppresses the structural built-in %s', (id) => {
        write('x.mod.json', suppressing([id]));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toMatch(new RegExp(`may not target the structural built-in "${id.replace('.', '\\.')}"`));
    });

    it('rejects a protected id however it is cased or padded', () => {
        write('x.mod.json', suppressing([' User.Message ']));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/may not target the structural built-in/);
    });

    it('rejects the file when ANY entry is protected', () => {
        write('x.mod.json', suppressing(['gm.reminder', 'absolute.command']));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/absolute\.command/);
    });

    it('allows suppressing non-structural built-ins verbatim', () => {
        write('x.mod.json', suppressing(['gm.reminder', 'watchdog.nudge', 'director.brief']));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].contributions[0].suppresses).toEqual(['gm.reminder', 'watchdog.nudge', 'director.brief']);
    });

    it.each([
        ['a non-array', 'gm.reminder', /suppresses must be an array/],
        ['a blank entry', ['gm.reminder', ' '], /suppresses must contain only non-empty/],
        ['a numeric entry', [7], /suppresses must contain only non-empty/],
    ])('rejects suppresses given as %s', (_label, suppresses, expected) => {
        write('x.mod.json', suppressing(suppresses));
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
        write('x.mod.json', withAppVersion(appVersion));
        expect(loadMods(dir, '1.0.4').faults).toEqual([]);
    });

    it('rejects a mod that needs a newer app', () => {
        write('x.mod.json', withAppVersion('>=2.0.0'));
        expect(soleFaultReason(loadMods(dir, '1.0.4')))
            .toBe('requires app version >=2.0.0, but this app is 1.0.4');
    });

    it('compares minor and patch, not just major', () => {
        write('x.mod.json', withAppVersion('>=1.0.5'));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/requires app version >=1\.0\.5/);
    });

    it.each([
        ['a caret range', '^1.0.0'],
        ['a tilde range', '~1.0.0'],
        ['a bare version', '1.0.0'],
        ['an upper bound', '<2.0.0'],
        ['a compound range', '>=1.0.0 <2.0.0'],
    ])('rejects %s as unsupported', (_label, appVersion) => {
        write('x.mod.json', withAppVersion(appVersion));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/unsupported appVersion/);
    });

    it('rejects a non-string appVersion', () => {
        write('x.mod.json', withAppVersion(1));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/appVersion must be a non-empty string/);
    });

    it('skips the check when the host version is unknown rather than rejecting', () => {
        write('x.mod.json', withAppVersion('>=99.0.0'));
        expect(loadMods(dir, undefined).faults).toEqual([]);
    });
});

describe('loadMods — compute mods', () => {
    it('loads compute metadata and carries the sibling source as text', () => {
        write('arc.mod.json', validMod({
            id: 'arc',
            compute: {
                file: 'arc.compute.js',
                hook: 'postTurn',
                capabilities: ['write:updateContext', 'table:read:npcs'],
            },
        }));
        write('arc.compute.js', 'export default async function () { return { ok: true }; }');

        const { mods, faults } = loadMods(dir, '1.0.4');

        expect(faults).toEqual([]);
        expect(mods[0].compute).toEqual({
            file: 'arc.compute.js',
            hook: 'postTurn',
            capabilities: ['write:updateContext', 'table:read:npcs'],
        });
        expect(mods[0].computeSource).toBe('export default async function () { return { ok: true }; }');
    });

    it('leaves data-only mods without compute metadata or source', () => {
        write('data.mod.json', validMod());

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
        write('x.mod.json', validMod({ compute }));

        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it.each(['../outside.js', 'nested/x.js', 'nested\\x.js', 'x..js'])('rejects a compute path that is not a plain filename: %s', (file) => {
        write('x.mod.json', validMod({ compute: { file, hook: 'postTurn', capabilities: [] } }));

        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/plain filename inside the mods directory/);
    });

    it('rejects a missing sibling compute source as a fault', () => {
        write('x.mod.json', validMod({ compute: { file: 'missing.js', hook: 'postTurn', capabilities: [] } }));

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
        expect(mods.map((m) => m.id)).toEqual(['good', 'alsogood']);
        expect(faults.map((f) => f.file)).toEqual(['b-bad.mod.json']);
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
