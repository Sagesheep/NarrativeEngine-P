import { describe, it, expect, beforeEach } from 'vitest';
import { tierAllows, listTierBlocks, modTierBlocks, MATRIX, type TierFeature } from '../aiTier';
import type { ModTierEntry } from '../tierBlockRegistry';
import type { AiTier } from '../../../types';

/**
 * Phase 7.3 — mod-declared tier entries are honoured by `tierAllows` and
 * surfaced in `listTierBlocks()`.
 *
 * The load-bearing constraint (work order §3): `tierAllows(tier, feature)`
 * keeps its exact exported signature. Only resolution changes. These tests
 * verify the resolution change — a mod feature resolves through the mod's
 * declared per-tier matrix, exactly as a built-in resolves through `MATRIX`.
 *
 * The characterization tests in `aiTier.characterization.test.ts` verify that
 * every built-in `TierFeature` is byte-identical before and after. These tests
 * verify the NEW path: a mod-declared id that is NOT a `TierFeature` literal.
 */

const TIERS: AiTier[] = ['lite', 'pro', 'max'];

function registerModEntry(overrides: Partial<ModTierEntry> = {}): ModTierEntry {
    const entry: ModTierEntry = {
        id: 'mod.beacon.scan',
        name: 'Beacon Scan',
        description: 'Scans for beacons.',
        toggleable: true,
        trigger: 'automatic',
        defaultEnabled: true,
        callsModel: true,
        matrix: { lite: false, pro: true, max: true },
        modId: 'beacon-mod',
        ...overrides,
    };
    modTierBlocks.register(entry);
    return entry;
}

beforeEach(() => {
    modTierBlocks.clear();
});

describe('Phase 7.3 — tierAllows resolves mod-declared entries', () => {
    it('returns the mod matrix value for each tier', () => {
        registerModEntry({ matrix: { lite: false, pro: true, max: true } });
        const feature = 'mod.beacon.scan' as TierFeature;
        expect(tierAllows('lite', feature)).toBe(false);
        expect(tierAllows('pro', feature)).toBe(true);
        expect(tierAllows('max', feature)).toBe(true);
    });

    it('returns the pro value for undefined tier (pro fallback)', () => {
        registerModEntry({ matrix: { lite: false, pro: true, max: true } });
        expect(tierAllows(undefined, 'mod.beacon.scan' as TierFeature)).toBe(true);
    });

    it('returns false for a mod entry that is not registered', () => {
        for (const tier of TIERS) {
            expect(tierAllows(tier, 'mod.unknown.feature' as TierFeature)).toBe(false);
        }
        expect(tierAllows(undefined, 'mod.unknown.feature' as TierFeature)).toBe(false);
    });

    it('returns false after the entry is unregistered', () => {
        registerModEntry();
        modTierBlocks.unregister('mod.beacon.scan');
        expect(tierAllows('pro', 'mod.beacon.scan' as TierFeature)).toBe(false);
    });

    it('returns false after clear', () => {
        registerModEntry();
        modTierBlocks.clear();
        expect(tierAllows('pro', 'mod.beacon.scan' as TierFeature)).toBe(false);
    });

    it('a mod entry with matrix all-false is blocked at every tier', () => {
        registerModEntry({ matrix: { lite: false, pro: false, max: false } });
        for (const tier of TIERS) {
            expect(tierAllows(tier, 'mod.beacon.scan' as TierFeature)).toBe(false);
        }
    });

    it('a mod entry with matrix all-true is allowed at every tier', () => {
        registerModEntry({ matrix: { lite: true, pro: true, max: true } });
        for (const tier of TIERS) {
            expect(tierAllows(tier, 'mod.beacon.scan' as TierFeature)).toBe(true);
        }
    });
});

describe('Phase 7.3 — built-in tierAllows is byte-identical (regression guard)', () => {
    // A subset of built-in features across the three tiers, checked against
    // the MATRIX directly. The full 27×3 golden matrix is in
    // aiTier.characterization.test.ts; this is a focused regression guard
    // that the mod-resolution fallthrough has not changed the built-in path.
    const SAMPLES: TierFeature[] = ['planner', 'enemyDiscovery', 'arcSpawn', 'deepScan', 'lodSlottedRag'];

    for (const tier of TIERS) {
        it(`built-in samples match MATRIX at ${tier}`, () => {
            for (const f of SAMPLES) {
                expect(tierAllows(tier, f)).toBe(MATRIX[tier][f]);
            }
        });
    }

    it('built-in unknown id still returns false (mod registry is empty)', () => {
        const unknown = 'nonExistentFeature' as unknown as TierFeature;
        for (const tier of TIERS) {
            expect(tierAllows(tier, unknown)).toBe(false);
        }
    });
});

describe('Phase 7.3 — listTierBlocks includes mod entries', () => {
    it('returns built-ins only when no mod entries are registered', () => {
        const blocks = listTierBlocks();
        // 27 built-in TierFeature ids — no mod entries.
        expect(blocks.length).toBe(27);
    });

    it('includes a registered mod entry after the built-ins', () => {
        registerModEntry();
        const blocks = listTierBlocks();
        expect(blocks.length).toBe(28);
        const modBlock = blocks.find((b) => b.id === 'mod.beacon.scan');
        expect(modBlock).toBeDefined();
        expect(modBlock!.name).toBe('Beacon Scan');
        expect(modBlock!.modId).toBe('beacon-mod');
    });

    it('includes multiple mod entries', () => {
        registerModEntry({ id: 'mod.a.x', name: 'AX' });
        registerModEntry({ id: 'mod.b.y', name: 'BY' });
        const blocks = listTierBlocks();
        expect(blocks.length).toBe(29);
        expect(blocks.find((b) => b.id === 'mod.a.x')?.name).toBe('AX');
        expect(blocks.find((b) => b.id === 'mod.b.y')?.name).toBe('BY');
    });

    it('returns a defensive copy (mutating the result does not affect the next call)', () => {
        registerModEntry();
        const a = listTierBlocks();
        const b = listTierBlocks();
        expect(a).not.toBe(b);
        expect(a).toEqual(b);
    });

    it('built-in entries come before mod entries', () => {
        registerModEntry({ id: 'mod.z.last', name: 'Z' });
        const blocks = listTierBlocks();
        const firstModIndex = blocks.findIndex((b) => b.id.startsWith('mod.'));
        const lastBuiltinIndex = blocks.length - 1;
        // The last entry should be the mod entry (only one registered).
        expect(blocks[lastBuiltinIndex].id).toBe('mod.z.last');
        expect(firstModIndex).toBe(lastBuiltinIndex);
    });
});
