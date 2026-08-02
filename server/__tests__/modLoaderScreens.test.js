// WO-P5-17 Step 1 — mod screen manifest validation. R2 (source ships as
// text, server never evaluates it) and R6 (no host API) enforced at load
// time as ModFault, each with a test proving the rejection.
//
// The contract under test mirrors `validatePanels` (modLoader.js:493+) and
// `validateTables` (modLoader.js:297-382): allow-listed keys, ID_REGEX on
// ids, reject with a ModFault rather than fail silently. A malformed
// screen rejects THIS mod, with a reason naming the mod, the screen and
// the problem. Other mods keep loading.
//
// R2 — `file` is a sibling source file, read as text and carried on
//      `ValidatedMod.screenSources[]` in `screens[]` order. The server
//      NEVER evaluates it (same rule as `computeSource` at
//      modLoader.js:252-261). The server holds the vault; mod code never
//      runs on the machine with the keys.
// R6 — no `capabilities`, no `channel`, no `api`, no `launch`, no `hooks`.
//      A 5.1 screen receives nothing and sends nothing — useless on
//      purpose. Adding a channel "to make it useful" is a stop condition.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadMods } from '../lib/modLoader.js';

let dir;

const write = (name, contents) => {
    fs.writeFileSync(
        path.join(dir, name),
        typeof contents === 'string' ? contents : JSON.stringify(contents, null, 2),
        'utf-8',
    );
};

const validMod = (overrides = {}) => ({
    id: 'screen-mod',
    name: 'Screen Mod',
    version: '1.0.0',
    description: 'A mod declaring a screen.',
    contributions: [{ id: 'placeholder', order: 990, budget: 1, text: '.' }],
    ...overrides,
});

const validScreen = (overrides = {}) => ({
    id: 'main-screen',
    file: 'screen-mod.js',
    label: 'Main Screen',
    ...overrides,
});

/** Assert exactly one file was rejected, and return its reason. */
const soleFaultReason = (result) => {
    expect(result.mods).toHaveLength(0);
    expect(result.faults).toHaveLength(1);
    return result.faults[0].reason;
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-loader-screens-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadMods — screens validation (WO-P5-17 Step 1)', () => {
    it('accepts a mod with no screens field (the common case)', () => {
        write('x.mod.json', validMod());
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].screens).toEqual([]);
        expect(mods[0].screenSources).toEqual([]);
    });

    it('accepts an empty screens array', () => {
        write('x.mod.json', validMod({ screens: [] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].screens).toEqual([]);
        expect(mods[0].screenSources).toEqual([]);
    });

    it('loads a valid screen declaration with every field preserved', () => {
        write('screen-mod.js', 'export default function () { return "ok"; }');
        write('x.mod.json', validMod({ screens: [validScreen()] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].screens).toHaveLength(1);
        const screen = mods[0].screens[0];
        expect(screen).toEqual({ id: 'main-screen', file: 'screen-mod.js', label: 'Main Screen' });
    });

    it('R2: carries the screen source as text, in screens[] order, never evaluated', () => {
        // The source is real JavaScript. The loader reads it as a STRING
        // and carries it on screenSources[0]. It never evaluates it —
        // `require`/`import` would throw here because the file is not a
        // module the server can resolve, and a thrown error would surface
        // as a fault. The text survives verbatim.
        const source = 'export default function () { /* screen body */ return 42; }';
        write('screen-mod.js', source);
        write('x.mod.json', validMod({ screens: [validScreen()] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].screenSources).toEqual([source]);
    });

    it('R2: pairs declaration i with source i across multiple screens', () => {
        write('a.js', '// first');
        write('b.js', '// second');
        write('x.mod.json', validMod({
            screens: [
                { id: 'first', file: 'a.js' },
                { id: 'second', file: 'b.js' },
            ],
        }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].screens.map((s) => s.id)).toEqual(['first', 'second']);
        expect(mods[0].screenSources).toEqual(['// first', '// second']);
    });

    // ── Structural rejections ──────────────────────────────────────────

    it('rejects a non-array screens field', () => {
        write('x.mod.json', validMod({ screens: { id: 'x' } }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/screens must be an array/);
    });

    it('rejects a screen entry that is not an object', () => {
        write('x.mod.json', validMod({ screens: ['just a string'] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/screens\[0\] must be an object/);
    });

    it.each([
        ['missing', undefined],
        ['a number', 7],
        ['an empty string', '   '],
        ['a dotted id', 'a.b'],
    ])('rejects a screen id that is %s', (_label, id) => {
        write('x.mod.json', validMod({ screens: [validScreen({ id })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/screens\[0\]\.id/);
    });

    it('rejects two screens sharing an id', () => {
        write('a.js', '// a');
        write('b.js', '// b');
        write('x.mod.json', validMod({
            screens: [
                { id: 'same', file: 'a.js' },
                { id: 'same', file: 'b.js' },
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/declared more than once/);
    });

    it('rejects a missing file', () => {
        write('x.mod.json', validMod({ screens: [validScreen()] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/screens\[0\]\.file "screen-mod\.js" could not be read/);
    });

    it('rejects a non-string file', () => {
        write('x.mod.json', validMod({ screens: [validScreen({ file: 7 })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/screens\[0\]\.file must be a non-empty string/);
    });

    it('R2: rejects a file with a path separator (traversal)', () => {
        write('x.mod.json', validMod({ screens: [validScreen({ file: 'sub/screen-mod.js' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/file must be a plain filename inside the mods directory/);
    });

    it('R2: rejects a file with a parent traversal (..)', () => {
        write('x.mod.json', validMod({ screens: [validScreen({ file: '../screen-mod.js' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/file must be a plain filename inside the mods directory/);
    });

    it('rejects a non-string label', () => {
        write('screen-mod.js', '// ok');
        write('x.mod.json', validMod({ screens: [validScreen({ label: 7 })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/label must be a string/);
    });

    // ── R6 — no host API in 5.1 ─────────────────────────────────────────

    it.each([
        ['capabilities', /capabilities is not allowed on a mod screen/],
        ['channel', /channel is not allowed on a mod screen/],
        ['postMessage', /postMessage is not allowed on a mod screen/],
        ['api', /api is not allowed on a mod screen/],
        ['launch', /launch is not allowed on a mod screen/],
        ['hooks', /hooks is not allowed on a mod screen/],
    ])('R6: rejects a %s field on a screen (no host API in 5.1)', (field, expected) => {
        write('screen-mod.js', '// ok');
        write('x.mod.json', validMod({ screens: [validScreen({ [field]: 'anything' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('rejects an unknown field on a screen declaration', () => {
        write('screen-mod.js', '// ok');
        write('x.mod.json', validMod({ screens: [validScreen({ future: 'oops' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/unknown field "future"/);
    });

    // ── Fail-safe: a bad screen rejects only this mod, not others ──────

    it('keeps loading the good mods when one file has a bad screen', () => {
        write('a-good.mod.json', validMod({ id: 'good' }));
        write('b-bad.mod.json', validMod({
            id: 'bad',
            screens: [validScreen({ id: 'oops', file: 'missing.js' })],
        }));
        write('c-good.mod.json', validMod({ id: 'alsogood' }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods.map((m) => m.id)).toEqual(['good', 'alsogood']);
        expect(faults.map((f) => f.file)).toEqual(['b-bad.mod.json']);
        expect(faults[0].reason).toMatch(/screens\[0\]\.file "missing\.js" could not be read/);
    });

    it('rejects the whole file when a single screen is bad', () => {
        write('good.js', '// good');
        write('x.mod.json', validMod({
            screens: [
                { id: 'good', file: 'good.js' },
                { id: 'bad', file: 'missing.js' },
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/screens\[1\]\.file "missing\.js" could not be read/);
    });
});