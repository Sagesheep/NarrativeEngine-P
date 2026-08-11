/**
 * `modEnablement` — the one place the mod enablement rule lives.
 *
 * The rule has two halves and they point in opposite directions, which is the
 * whole reason this module exists rather than a fourth inline copy of
 * `enablement[id] !== false`:
 *
 *   • A normal mod is ENABLED when absent from the map. Installing a mod is the
 *     act of enabling it; the map holds exceptions, not the roster.
 *   • A `dev` mod is DISABLED when absent. A fixture writes debug rows under
 *     every message and probe records into campaign tables — correct for a
 *     regression test, unacceptable for someone who never asked for it.
 */
import { describe, expect, it } from 'vitest';
import {
    enabledMods,
    isModEnabled,
    modDefaultEnabled,
    modEnablementKey,
} from '../modEnablement';
import type { ValidatedMod } from '../modTypes';

const mod = (id: string, dev = false) => ({ id, dev });

describe('modEnablementKey', () => {
    it('namespaces the mod id under `mod.`', () => {
        expect(modEnablementKey('arc')).toBe('mod.arc');
    });
});

describe('isModEnabled — a normal mod', () => {
    it('is enabled when absent from the map', () => {
        expect(isModEnabled(mod('arc'), {})).toBe(true);
        expect(isModEnabled(mod('arc'), undefined)).toBe(true);
    });

    it('is disabled only on an explicit false', () => {
        expect(isModEnabled(mod('arc'), { 'mod.arc': false })).toBe(false);
        expect(isModEnabled(mod('arc'), { 'mod.arc': true })).toBe(true);
    });

    it('ignores another mod’s entry', () => {
        expect(isModEnabled(mod('arc'), { 'mod.other': false })).toBe(true);
    });
});

describe('isModEnabled — a dev mod', () => {
    it('is DISABLED when absent from the map', () => {
        // The inversion. This is the assertion that stops thirteen fixtures
        // from auto-activating on a profile that never opened Extensions.
        expect(isModEnabled(mod('probe', true), {})).toBe(false);
        expect(isModEnabled(mod('probe', true), undefined)).toBe(false);
    });

    it('is enabled only on an explicit true', () => {
        expect(isModEnabled(mod('probe', true), { 'mod.probe': true })).toBe(true);
        expect(isModEnabled(mod('probe', true), { 'mod.probe': false })).toBe(false);
    });

    it('stays off when the map carries an unrelated entry', () => {
        expect(isModEnabled(mod('probe', true), { 'mod.arc': true })).toBe(false);
    });
});

describe('modDefaultEnabled', () => {
    it('is the switch position with nothing written', () => {
        expect(modDefaultEnabled(mod('arc'))).toBe(true);
        expect(modDefaultEnabled(mod('probe', true))).toBe(false);
    });

    it('agrees with isModEnabled against an empty map', () => {
        // The invariant that keeps Extensions' "Reset to defaults" honest: the
        // checkbox it draws after a reset must be the checkbox the runtime acts
        // on. These two functions disagreeing is the bug class ExtensionsTab's
        // header warns about.
        for (const m of [mod('arc'), mod('probe', true)]) {
            expect(modDefaultEnabled(m)).toBe(isModEnabled(m, {}));
        }
    });
});

describe('enabledMods', () => {
    const mods = [
        { id: 'arc', dev: false },
        { id: 'probe', dev: true },
        { id: 'anno-mark', dev: false },
        { id: 'template-mod', dev: true },
    ] as unknown as ValidatedMod[];

    it('keeps normal mods and drops dev mods with an empty map', () => {
        expect(enabledMods(mods, {}).map((m) => m.id)).toEqual(['arc', 'anno-mark']);
    });

    it('includes a dev mod the user switched on', () => {
        expect(enabledMods(mods, { 'mod.probe': true }).map((m) => m.id)).toEqual([
            'arc',
            'probe',
            'anno-mark',
        ]);
    });

    it('preserves the loader’s resolved order', () => {
        // Load order is behaviour, not style (MANIFEST.md §6.3) — filtering must
        // never reorder.
        const kept = enabledMods(mods, { 'mod.probe': true, 'mod.template-mod': true });
        expect(kept.map((m) => m.id)).toEqual(['arc', 'probe', 'anno-mark', 'template-mod']);
    });
});
