import { describe, it, expect, beforeEach } from 'vitest';
import { createTierBlockRegistry, type ModTierEntry } from '../tierBlockRegistry';
import type { AiTier } from '../../../types';

/**
 * Phase 7.3 — the mod-declared tier block registry.
 *
 * Mirrors the shape of `createPostTurnTrackRegistry` (`runner.test.ts`) and
 * `createContributionRegistry` (`registry.test.ts`): register, unregister,
 * list, resolve. The registry is name-blind — it never branches on which
 * entry it is holding.
 */

const TIERS: AiTier[] = ['lite', 'pro', 'max'];

function makeEntry(overrides: Partial<ModTierEntry> = {}): ModTierEntry {
    return {
        id: 'mod.test.beacon',
        name: 'Beacon',
        description: 'Scans for beacons.',
        toggleable: true,
        trigger: 'automatic',
        defaultEnabled: true,
        callsModel: true,
        matrix: { lite: false, pro: true, max: true },
        modId: 'test',
        ...overrides,
    };
}

describe('createTierBlockRegistry — registration', () => {
    let reg: ReturnType<typeof createTierBlockRegistry>;

    beforeEach(() => {
        reg = createTierBlockRegistry();
    });

    it('register + list round-trips one entry', () => {
        const entry = makeEntry();
        reg.register(entry);
        expect(reg.list()).toHaveLength(1);
        expect(reg.list()[0]).toBe(entry);
    });

    it('register throws on duplicate id', () => {
        reg.register(makeEntry({ id: 'mod.test.beacon' }));
        expect(() => reg.register(makeEntry({ id: 'mod.test.beacon' })))
            .toThrow('duplicate mod tier entry id: mod.test.beacon');
    });

    it('unregister removes an entry and returns true', () => {
        reg.register(makeEntry());
        expect(reg.unregister('mod.test.beacon')).toBe(true);
        expect(reg.list()).toHaveLength(0);
    });

    it('unregister returns false for an absent id', () => {
        expect(reg.unregister('nope')).toBe(false);
    });

    it('unregisterMod removes every entry from a mod', () => {
        reg.register(makeEntry({ id: 'mod.a.x', modId: 'a' }));
        reg.register(makeEntry({ id: 'mod.a.y', modId: 'a' }));
        reg.register(makeEntry({ id: 'mod.b.z', modId: 'b' }));
        reg.unregisterMod('a');
        expect(reg.list()).toHaveLength(1);
        expect(reg.list()[0].id).toBe('mod.b.z');
    });

    it('get returns the entry or undefined', () => {
        reg.register(makeEntry());
        expect(reg.get('mod.test.beacon')?.name).toBe('Beacon');
        expect(reg.get('nope')).toBeUndefined();
    });

    it('clear drops all entries', () => {
        reg.register(makeEntry({ id: 'mod.a.x' }));
        reg.register(makeEntry({ id: 'mod.b.y' }));
        reg.clear();
        expect(reg.list()).toHaveLength(0);
    });

    it('list returns a defensive copy (mutating the result does not affect the registry)', () => {
        reg.register(makeEntry());
        const a = reg.list();
        (a as ModTierEntry[]).pop();
        expect(reg.list()).toHaveLength(1);
    });
});

describe('createTierBlockRegistry — allows (tier resolution)', () => {
    let reg: ReturnType<typeof createTierBlockRegistry>;

    beforeEach(() => {
        reg = createTierBlockRegistry();
    });

    it('returns the matrix value for each tier', () => {
        reg.register(makeEntry({ matrix: { lite: false, pro: false, max: true } }));
        for (const tier of TIERS) {
            expect(reg.allows(tier, 'mod.test.beacon')).toBe(tier === 'max');
        }
    });

    it('returns false for an unregistered id', () => {
        for (const tier of TIERS) {
            expect(reg.allows(tier, 'mod.unknown.feature')).toBe(false);
        }
    });

    it('returns false after unregister', () => {
        reg.register(makeEntry());
        reg.unregister('mod.test.beacon');
        for (const tier of TIERS) {
            expect(reg.allows(tier, 'mod.test.beacon')).toBe(false);
        }
    });

    it('returns false after clear', () => {
        reg.register(makeEntry());
        reg.clear();
        expect(reg.allows('pro', 'mod.test.beacon')).toBe(false);
    });
});

describe('createTierBlockRegistry — cooldownFor', () => {
    let reg: ReturnType<typeof createTierBlockRegistry>;

    beforeEach(() => {
        reg = createTierBlockRegistry();
    });

    it('returns the declared cooldown for a tier', () => {
        reg.register(makeEntry({ cooldown: { pro: 5, max: 0 } }));
        expect(reg.cooldownFor('mod.test.beacon', 'pro')).toBe(5);
        expect(reg.cooldownFor('mod.test.beacon', 'max')).toBe(0);
    });

    it('returns undefined for a tier not in the cooldown map', () => {
        reg.register(makeEntry({ cooldown: { pro: 5 } }));
        expect(reg.cooldownFor('mod.test.beacon', 'max')).toBeUndefined();
    });

    it('returns undefined when the entry has no cooldown', () => {
        reg.register(makeEntry());
        expect(reg.cooldownFor('mod.test.beacon', 'pro')).toBeUndefined();
    });

    it('returns undefined for an unregistered id', () => {
        expect(reg.cooldownFor('nope', 'pro')).toBeUndefined();
    });
});
