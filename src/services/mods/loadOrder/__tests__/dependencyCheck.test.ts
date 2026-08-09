/**
 * Phase 6.2 — `dependencyCheck` unit tests.
 *
 * Pins the two behaviours the spec requires:
 *  1. A proposed order that puts a mod before its dependency is rejected
 *     with a reason naming both mods (§2.4).
 *  2. A legal order (dependency before dependent) is accepted.
 *
 * The check is pure — it reads the mod list and the proposed order, and
 * returns the first violation or `null`. It does not call the server.
 */
import { describe, it, expect } from 'vitest';
import {
    validateProposedLoadOrder,
    modsThatMustPrecede,
} from '../dependencyCheck';
import type { ValidatedMod } from '../../modTypes';

const makeMod = (id: string, deps: Record<string, string> = {}): ValidatedMod => ({
    id,
    name: id,
    version: '1.0.0',
    description: '',
    file: `${id}/manifest.json`,
    folder: id,
    folderPath: `/mods/${id}`,
    dependencies: deps,
    loadOrder: 0,
    i18n: {},
    i18nStrings: {},
    contributions: [],
    panels: [],
    tables: [],
    screens: [],
    screenSources: [],
});

describe('validateProposedLoadOrder', () => {
    it('returns null for an order with no dependencies', () => {
        const mods = [makeMod('a'), makeMod('b'), makeMod('c')];
        expect(validateProposedLoadOrder(mods, ['c', 'a', 'b'])).toBeNull();
    });

    it('returns null when dependencies are satisfied (dep before dependent)', () => {
        const mods = [
            makeMod('a', { b: '*' }),
            makeMod('b'),
        ];
        expect(validateProposedLoadOrder(mods, ['b', 'a'])).toBeNull();
    });

    it('returns a violation when a mod is ordered before its dependency', () => {
        const mods = [
            makeMod('a', { b: '*' }),
            makeMod('b'),
        ];
        const v = validateProposedLoadOrder(mods, ['a', 'b']);
        expect(v).not.toBeNull();
        expect(v!.modId).toBe('a');
        expect(v!.blockedBy).toBe('b');
        expect(v!.message).toContain('a');
        expect(v!.message).toContain('b');
    });

    it('returns a violation for a transitive dependency ordered after', () => {
        // a depends on b, b depends on c. Order [c, a, b] puts a before b.
        const mods = [
            makeMod('a', { b: '*' }),
            makeMod('b', { c: '*' }),
            makeMod('c'),
        ];
        const v = validateProposedLoadOrder(mods, ['c', 'a', 'b']);
        expect(v).not.toBeNull();
        expect(v!.modId).toBe('a');
        expect(v!.blockedBy).toBe('b');
    });

    it('ignores mods in the proposed list that are not installed', () => {
        const mods = [makeMod('a')];
        // 'ghost' is not in mods — should be ignored, not a violation.
        expect(validateProposedLoadOrder(mods, ['ghost', 'a'])).toBeNull();
    });

    it('ignores dependencies that are not installed (missing dep is a load fault)', () => {
        const mods = [makeMod('a', { missing: '*' })];
        expect(validateProposedLoadOrder(mods, ['a'])).toBeNull();
    });

    it('returns null for an empty proposed order', () => {
        const mods = [makeMod('a')];
        expect(validateProposedLoadOrder(mods, [])).toBeNull();
    });
});

describe('modsThatMustPrecede', () => {
    it('returns the direct dependencies', () => {
        const mods = [
            makeMod('a', { b: '*', c: '*' }),
            makeMod('b'),
            makeMod('c'),
        ];
        const set = modsThatMustPrecede(mods, 'a');
        expect(set.has('b')).toBe(true);
        expect(set.has('c')).toBe(true);
        expect(set.size).toBe(2);
    });

    it('includes transitive dependencies', () => {
        const mods = [
            makeMod('a', { b: '*' }),
            makeMod('b', { c: '*' }),
            makeMod('c'),
        ];
        const set = modsThatMustPrecede(mods, 'a');
        expect(set.has('b')).toBe(true);
        expect(set.has('c')).toBe(true);
        expect(set.size).toBe(2);
    });

    it('returns an empty set for a mod with no dependencies', () => {
        const mods = [makeMod('a')];
        expect(modsThatMustPrecede(mods, 'a').size).toBe(0);
    });

    it('handles a diamond dependency graph without double-counting', () => {
        // a → b → d, a → c → d
        const mods = [
            makeMod('a', { b: '*', c: '*' }),
            makeMod('b', { d: '*' }),
            makeMod('c', { d: '*' }),
            makeMod('d'),
        ];
        const set = modsThatMustPrecede(mods, 'a');
        expect(set.has('b')).toBe(true);
        expect(set.has('c')).toBe(true);
        expect(set.has('d')).toBe(true);
        expect(set.size).toBe(3);
    });
});