// WO-P5-16 Step 3 — mod panel manifest validation. R1–R5 enforced at load
// time as ModFault, each with a test proving the rejection.
//
// The contract under test mirrors `validateTables` (modLoader.js:297-382):
// allow-listed keys, ID_REGEX on ids, reject with a ModFault rather than
// fail silently. A malformed panel rejects THIS mod, with a reason naming
// the mod, the panel and the problem. Other mods keep loading.
//
// R1 — bindsTo resolves against the mod's OWN declared tables, never the
//      host store. This is the security ruling of the sub-phase: 4.2's
//      descriptor bound to `enemyInstances` (a store field). Grant a mod the
//      same and `bindsTo: "settings"` renders an editable view of the API
//      keys — handing back through the UI exactly what the vault work in
//      COMPUTE was done to protect.
// R2 — reads may name only the mod's own tables. Same hole as R1, one
//      field over.
// R3 — hooks is rejected at load time. v1 defers panel logic.
// R4 — launch is always "nested". A mod may not claim prime navigation.
// R5 — layout follows recordShape: single-object -> form; array -> list or
//      list-detail. Any other pairing is a rejection.
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
    id: 'panel-mod',
    name: 'Panel Mod',
    version: '1.0.0',
    description: 'A mod declaring a panel over its own table.',
    contributions: [{ id: 'placeholder', order: 990, budget: 1, text: '.' }],
    tables: [{ name: 'things', recordShape: 'array', label: 'Things' }],
    ...overrides,
});

const validPanel = (overrides = {}) => ({
    id: 'things-panel',
    bindsTo: 'things',
    launch: 'nested',
    layout: 'list',
    fields: [{ key: 'name', label: 'Name', control: 'text' }],
    crud: { create: true, read: true, update: true, delete: true },
    ...overrides,
});

/** Assert exactly one file was rejected, and return its reason. */
const soleFaultReason = (result) => {
    expect(result.mods).toHaveLength(0);
    expect(result.faults).toHaveLength(1);
    return result.faults[0].reason;
};

beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mod-loader-panels-'));
});

afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
});

describe('loadMods — panels validation (WO-P5-16 Step 3)', () => {
    it('accepts a mod with no panels field (the common case)', () => {
        write('x.mod.json', validMod());
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels).toEqual([]);
    });

    it('accepts an empty panels array', () => {
        write('x.mod.json', validMod({ panels: [] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels).toEqual([]);
    });

    it('loads a valid panel declaration with every field preserved', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({
                fields: [
                    { key: 'name', label: 'Name', control: 'text', placeholder: 'Name…' },
                    { key: 'count', label: 'Count', control: 'number', min: 0, max: 100 },
                    { key: 'kind', label: 'Kind', control: 'select', options: [{ value: 'a', label: 'A' }] },
                    { key: 'enabled', label: 'Enabled', control: 'checkbox' },
                    { key: 'tags', label: 'Tags', control: 'tags' },
                ],
                sort: { field: 'name', direction: 'desc' },
                reads: ['things'],
                search: true,
                filter: { field: 'kind', options: [{ value: 'a', label: 'A' }], label: 'Kind' },
            })],
        }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels).toHaveLength(1);
        const panel = mods[0].panels[0];
        expect(panel).toMatchObject({
            id: 'things-panel',
            bindsTo: 'things',
            launch: 'nested',
            layout: 'list',
            crud: { create: true, read: true, update: true, delete: true },
            sort: { field: 'name', direction: 'desc' },
            reads: ['things'],
            search: true,
            filter: { field: 'kind', label: 'Kind' },
        });
        expect(panel.fields.map((f) => f.control)).toEqual([
            'text', 'number', 'select', 'checkbox', 'tags',
        ]);
    });

    it('accepts a bare-string sort (4.1 default, ascending)', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ sort: 'name' })] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels[0].sort).toBe('name');
    });

    it('accepts a SortSpec with no direction (defaults to ascending)', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ sort: { field: 'name' } })] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels[0].sort).toEqual({ field: 'name' });
    });

    it('accepts a form layout over a single-object table (R5)', () => {
        write('x.mod.json', validMod({
            tables: [{ name: 'cfg', recordShape: 'single-object' }],
            panels: [validPanel({ bindsTo: 'cfg', layout: 'form' })],
        }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels[0].layout).toBe('form');
    });

    // ── Structural rejections ──────────────────────────────────────────

    it('rejects a non-array panels field', () => {
        write('x.mod.json', validMod({ panels: { id: 'x' } }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/panels must be an array/);
    });

    it('rejects a panel entry that is not an object', () => {
        write('x.mod.json', validMod({ panels: ['just a string'] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/panels\[0\] must be an object/);
    });

    it.each([
        ['missing', undefined],
        ['a number', 7],
        ['an empty string', '   '],
        ['a dotted id', 'a.b'],
    ])('rejects a panel id that is %s', (_label, id) => {
        write('x.mod.json', validMod({ panels: [validPanel({ id })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/panels\[0\]\.id/);
    });

    it('rejects two panels sharing an id', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ id: 'same' }), validPanel({ id: 'same', bindsTo: 'things' })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/declared more than once/);
    });

    it('rejects an empty fields array', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ fields: [] })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/fields must be a non-empty array/);
    });

    it('rejects a non-object crud', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ crud: 'yes' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/crud must be an object/);
    });

    it('rejects an unknown crud operation', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ crud: { reorder: true } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/crud has unknown operation "reorder"/);
    });

    it('rejects a non-boolean crud value', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ crud: { create: 'yes' } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/crud\.create must be a boolean/);
    });

    // ── R1 — bindsTo must name one of the mod's own tables ──────────────

    it('R1: rejects a panel binding to a host store field (settings)', () => {
        // The security ruling. 4.2's descriptor bound to `enemyInstances`,
        // a store field. Grant a mod the same and `bindsTo: "settings"`
        // renders an editable view of the API keys. R1 closes that hole at
        // load time: bindsTo must be one of THIS MOD's own tables.
        write('x.mod.json', validMod({ panels: [validPanel({ bindsTo: 'settings' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/bindsTo "settings" is not one of mod "panel-mod"'s own tables/);
    });

    it('R1: rejects a panel binding to a table no other mod owns (cross-mod)', () => {
        // A mod cannot bind to ANOTHER mod's table either — only its own.
        write('x.mod.json', validMod({ panels: [validPanel({ bindsTo: 'other-mod-table' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/bindsTo "other-mod-table" is not one of mod "panel-mod"'s own tables/);
    });

    it('R1: rejects a panel binding to nothing when the mod declares no tables', () => {
        write('x.mod.json', validMod({ tables: [], panels: [validPanel()] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/bindsTo "things" is not one of mod "panel-mod"'s own tables.*no tables declared/);
    });

    // ── R2 — reads may name only the mod's own tables ───────────────────

    it('R2: rejects a reads entry naming a host store field', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ reads: ['enemyCompendium'] })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/reads "enemyCompendium" is not one of mod "panel-mod"'s own tables/);
    });

    it('R2: rejects a reads entry naming another mod\'s table', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ reads: ['other'] })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/reads "other" is not one of mod "panel-mod"'s own tables/);
    });

    it('R2: accepts reads naming the mod\'s own table', () => {
        write('x.mod.json', validMod({
            tables: [
                { name: 'things', recordShape: 'array' },
                { name: 'lookup', recordShape: 'array' },
            ],
            panels: [validPanel({ reads: ['lookup'] })],
        }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels[0].reads).toEqual(['lookup']);
    });

    // ── R3 — hooks is rejected at load time ─────────────────────────────

    it('R3: rejects a hooks map on a panel', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ hooks: { onSave: 'x' } })] }));
        // hooks is forbidden by name; never validated. R3 defers panel logic.
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/hooks is not allowed on a mod panel.*v1 defers panel logic/);
    });

    it('R3: rejects a computed field (would require a function)', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ fields: [{ key: 'name', control: 'computed', compute: 'x' }] })],
        }));
        // `computed` is the field kind that carries panel logic. A manifest
        // cannot supply a function, but the field is rejected explicitly so a
        // future loader change cannot accidentally accept one.
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/control "computed" is not a mod panel control/);
    });

    it('R3: rejects a compute function on a field', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ fields: [{ key: 'name', control: 'text', compute: 'x' }] })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/compute is not allowed on a mod panel field/);
    });

    // ── R4 — launch is always "nested" ─────────────────────────────────

    it.each([
        ['header-button', /launch "header-button" is not allowed for a mod panel.*only "nested"/],
        ['tab', /launch "tab" is not allowed for a mod panel.*only "nested"/],
    ])('R4: rejects launch %s for a mod panel', (launch, expected) => {
        write('x.mod.json', validMod({ panels: [validPanel({ launch })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(expected);
    });

    it('R4: rejects a non-string launch', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ launch: 7 })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/launch must be a non-empty string/);
    });

    // ── R5 — layout follows recordShape ────────────────────────────────

    it('R5: rejects a list layout over a single-object table', () => {
        write('x.mod.json', validMod({
            tables: [{ name: 'cfg', recordShape: 'single-object' }],
            panels: [validPanel({ bindsTo: 'cfg', layout: 'list' })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/layout "list" is not valid for a single-object table.*only "form"/);
    });

    it('R5: rejects a form layout over an array table', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ layout: 'form' })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/layout "form" is not valid for an array table.*use "list" or "list-detail"/);
    });

    it('R5: accepts list-detail over an array table', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ layout: 'list-detail' })] }));
        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(faults).toEqual([]);
        expect(mods[0].panels[0].layout).toBe('list-detail');
    });

    it('R5: rejects an invalid layout string', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ layout: 'spatial' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/layout "spatial" must be one of/);
    });

    // ── Field validation ───────────────────────────────────────────────

    it('rejects an unknown control', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ fields: [{ key: 'x', control: 'colour' }] })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/control "colour" is not a mod panel control/);
    });

    it('rejects a select with no options', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ fields: [{ key: 'kind', control: 'select' }] })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/options must be a non-empty array for a select control/);
    });

    it('rejects a non-finite min', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ fields: [{ key: 'n', control: 'number', min: 'five' }] })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/min must be a finite number/);
    });

    it('rejects an unknown field on a panel field', () => {
        write('x.mod.json', validMod({
            panels: [validPanel({ fields: [{ key: 'x', control: 'text', future: 'oops' }] })],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/unknown field "future"/);
    });

    it('rejects an unknown field on a panel declaration', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ future: 'oops' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/unknown field "future"/);
    });

    it('rejects a writes field (a mod panel writes via crud on bindsTo only)', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ writes: ['things'] })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/writes is not allowed on a mod panel/);
    });

    it('rejects a newRow field (the renderer derives the empty row from fields)', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ newRow: {} })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/newRow is not allowed on a mod panel/);
    });

    // ── Sort validation ────────────────────────────────────────────────

    it('rejects an invalid sort direction', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ sort: { field: 'name', direction: 'sideways' } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/sort\.direction "sideways" must be "asc" or "desc"/);
    });

    it('rejects a non-string, non-object sort', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ sort: 7 })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/sort must be a string or/);
    });

    // ── Filter/search validation ───────────────────────────────────────

    it('rejects a non-boolean search', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ search: 'yes' })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/search must be a boolean/);
    });

    it('rejects a filter with no options', () => {
        write('x.mod.json', validMod({ panels: [validPanel({ filter: { field: 'kind', options: [] } })] }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/filter\.options must be a non-empty array/);
    });

    // ── Fail-safe: a bad panel rejects only this mod, not others ───────

    it('keeps loading the good mods when one file has a bad panel', () => {
        write('a-good.mod.json', validMod({ id: 'good' }));
        write('b-bad.mod.json', validMod({
            id: 'bad',
            panels: [validPanel({ bindsTo: 'settings' })],
        }));
        write('c-good.mod.json', validMod({ id: 'alsogood' }));

        const { mods, faults } = loadMods(dir, '1.0.4');
        expect(mods.map((m) => m.id)).toEqual(['good', 'alsogood']);
        expect(faults.map((f) => f.file)).toEqual(['b-bad.mod.json']);
        expect(faults[0].reason).toMatch(/bindsTo "settings" is not one of mod "bad"'s own tables/);
    });

    it('rejects the whole file when a single panel is bad', () => {
        write('x.mod.json', validMod({
            panels: [
                validPanel({ id: 'good' }),
                validPanel({ id: 'bad', bindsTo: 'settings' }),
            ],
        }));
        expect(soleFaultReason(loadMods(dir, '1.0.4'))).toMatch(/panels\[1\]\.bindsTo "settings"/);
    });
});