import { describe, it, expect } from 'vitest';
import { modToTierEntries, modTierEntryId } from '../tierEntryAdapter';
import type { ValidatedMod } from '../modTypes';

/**
 * Phase 7.3 — the mod → tier entry adapter.
 *
 * Mirrors `modToComputeTrack` and `modToContributionModule` in shape: the
 * registry never learns what produced an entry. The one invariant under test
 * is NAMESPACING — every entry id is `mod.<modId>.<entryId>`, so a mod can
 * never collide with or impersonate a built-in `TierFeature` id.
 */

function makeMod(overrides: Partial<ValidatedMod> = {}): ValidatedMod {
    return {
        id: 'beacon-mod',
        name: 'Beacon Mod',
        version: '1.0.0',
        description: 'A mod with a tier entry.',
        file: 'beacon-mod/manifest.json',
        folder: 'beacon-mod',
        folderPath: '/mods/beacon-mod',
        loadOrder: 0,
        roles: [],
        tierEntries: [
            {
                id: 'beacon',
                name: 'Beacon Scanner',
                description: 'Scans for beacons.',
                toggleable: true,
                trigger: 'automatic',
                defaultEnabled: true,
                callsModel: true,
                matrix: { lite: false, pro: true, max: true },
                cooldown: { pro: 3, max: 0 },
            },
        ],
        dependencies: {},
        i18n: {},
        i18nStrings: {},
        contributions: [],
        tables: [],
        panels: [],
        screens: [],
        screenSources: [],
        provenance: 'installed',
        ...overrides,
    };
}

describe('modTierEntryId', () => {
    it('produces mod.<modId>.<entryId>', () => {
        expect(modTierEntryId('beacon-mod', 'beacon')).toBe('mod.beacon-mod.beacon');
    });
});

describe('modToTierEntries', () => {
    it('namespaces every entry id as mod.<modId>.<entryId>', () => {
        const entries = modToTierEntries(makeMod());
        expect(entries).toHaveLength(1);
        expect(entries[0].id).toBe('mod.beacon-mod.beacon');
    });

    it('carries the mod id as provenance', () => {
        const entries = modToTierEntries(makeMod());
        expect(entries[0].modId).toBe('beacon-mod');
    });

    it('preserves all TierBlock metadata', () => {
        const entries = modToTierEntries(makeMod());
        expect(entries[0]).toMatchObject({
            name: 'Beacon Scanner',
            description: 'Scans for beacons.',
            toggleable: true,
            trigger: 'automatic',
            defaultEnabled: true,
            callsModel: true,
        });
    });

    it('preserves the per-tier matrix', () => {
        const entries = modToTierEntries(makeMod());
        expect(entries[0].matrix).toEqual({ lite: false, pro: true, max: true });
    });

    it('preserves the cooldown', () => {
        const entries = modToTierEntries(makeMod());
        expect(entries[0].cooldown).toEqual({ pro: 3, max: 0 });
    });

    it('defaults description to empty string when absent', () => {
        const mod = makeMod({
            tierEntries: [{
                id: 'beacon',
                name: 'Beacon',
                toggleable: true,
                trigger: 'automatic',
                defaultEnabled: true,
                matrix: { lite: false, pro: true, max: true },
            }],
        });
        const entries = modToTierEntries(mod);
        expect(entries[0].description).toBe('');
    });

    it('returns [] for a mod with no tierEntries', () => {
        const mod = makeMod({ tierEntries: [] });
        expect(modToTierEntries(mod)).toEqual([]);
    });

    it('returns [] for a mod with undefined tierEntries', () => {
        const mod = makeMod({});
        delete (mod as Partial<ValidatedMod>).tierEntries;
        expect(modToTierEntries(mod)).toEqual([]);
    });

    it('handles multiple entries', () => {
        const mod = makeMod({
            tierEntries: [
                { id: 'a', name: 'A', description: 'a', toggleable: true, trigger: 'automatic', defaultEnabled: true, matrix: { lite: false, pro: true, max: true } },
                { id: 'b', name: 'B', description: 'b', toggleable: false, trigger: 'manual', defaultEnabled: false, callsModel: false, matrix: { lite: false, pro: false, max: true } },
            ],
        });
        const entries = modToTierEntries(mod);
        expect(entries).toHaveLength(2);
        expect(entries[0].id).toBe('mod.beacon-mod.a');
        expect(entries[1].id).toBe('mod.beacon-mod.b');
        expect(entries[1].toggleable).toBe(false);
        expect(entries[1].trigger).toBe('manual');
    });

    it('a mod id with dots still produces a namespaced entry id (dots allowed in mod ids? no — ID_REGEX forbids them)', () => {
        // Mod ids are validated by ID_REGEX (no dots). The adapter does not
        // re-validate; it trusts the loader. This test documents that the
        // adapter simply concatenates, relying on the loader's guarantee.
        const mod = makeMod({ id: 'my-mod' });
        const entries = modToTierEntries(mod);
        expect(entries[0].id).toBe('mod.my-mod.beacon');
    });
});
