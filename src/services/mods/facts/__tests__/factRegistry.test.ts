/**
 * Phase 5.4 — the fact registry unit tests.
 *
 * Mirrors `macroRegistry.test.ts` and `interceptorRegistry.test.ts`: the
 * registry's own invariants are pinned here, independent of the turn path.
 * The product tests (`phase54Facts.test.ts`) drive the shipped fixtures
 * through `buildPayload`.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
    clearAllModFacts,
    disableModFacts,
    enableModFacts,
    hasFactClaim,
    hasFactPublishers,
    isModFactsRevoked,
    listModFacts,
    registerModFact,
    runFactPublishers,
} from '../factRegistry';
import { factFaultStore } from '../factFaults';
import type { FactRegistryMod } from '../factTypes';

const modA: FactRegistryMod = { id: 'mod-a', name: 'Mod A', loadIndex: 10 };
const modB: FactRegistryMod = { id: 'mod-b', name: 'Mod B', loadIndex: 20 };

beforeEach(() => {
    clearAllModFacts();
    factFaultStore.clear();
});

describe('registerModFact — namespacing and claims', () => {
    it('registers a namespaced mod fact without a claim', () => {
        const unreg = registerModFact(modA, 'mood', () => 'tense');
        expect(hasFactPublishers()).toBe(true);
        expect(listModFacts('mod-a')).toEqual(['mood']);
        unreg();
        expect(hasFactPublishers()).toBe(false);
    });

    it('registers a claimed core fact (inCombat)', () => {
        const unreg = registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        expect(hasFactClaim('mod-a', 'inCombat')).toBe(true);
        expect(listModFacts('mod-a')).toEqual(['inCombat']);
        unreg();
        expect(hasFactClaim('mod-a', 'inCombat')).toBe(false);
    });

    it('rejects a bare core fact name without a claim (the footgun)', () => {
        registerModFact(modA, 'inCombat', () => true);
        expect(hasFactPublishers()).toBe(false);
        expect(hasFactClaim('mod-a', 'inCombat')).toBe(false);
        const record = factFaultStore.getRecords()[0];
        expect(record?.kind).toBe('shadow');
        expect(record?.name).toBe('inCombat');
    });

    it('rejects a claim on a name the host has not opened', () => {
        // `location` is a core fact but not claimable today.
        registerModFact(modA, 'location', () => 'Tavern', { claims: 'location' });
        expect(hasFactPublishers()).toBe(false);
        const record = factFaultStore.getRecords()[0];
        expect(record?.kind).toBe('shadow');
    });

    it('rejects a claim where the name does not match the claim', () => {
        registerModFact(modA, 'mood', () => true, { claims: 'inCombat' });
        expect(hasFactPublishers()).toBe(false);
        const record = factFaultStore.getRecords()[0];
        expect(record?.kind).toBe('shadow');
    });

    it('rejects invalid args with a fault and no-op', () => {
        const unreg1 = registerModFact(modA, '', () => true);
        // The fault store is keyed by modId (latest fault wins), so the
        // second bad registration overwrites the first's record. One fault
        // for one mod id is the correct posture — the store does not grow.
        const unreg2 = registerModFact(modB, 'mood', null as unknown as () => unknown);
        expect(hasFactPublishers()).toBe(false);
        unreg1();
        unreg2();
        expect(factFaultStore.getRecords().length).toBeGreaterThanOrEqual(1);
    });
});

describe('registerModFact — conflict resolution', () => {
    it('the first claimant wins; the second is surfaced as a conflict', () => {
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        registerModFact(modB, 'inCombat', () => false, { claims: 'inCombat' });

        // Mod A (earlier loadIndex) holds the claim.
        expect(hasFactClaim('mod-a', 'inCombat')).toBe(true);
        expect(hasFactClaim('mod-b', 'inCombat')).toBe(false);

        // Mod B has a conflict fault naming both mods.
        const record = factFaultStore.getRecords().find((r) => r.kind === 'conflict');
        expect(record).toBeDefined();
        expect(record?.name).toBe('inCombat');
        expect(record?.reason).toContain('Mod A');
        expect(record?.reason).toContain('Mod B');
    });

    it('a conflict fault is surfaced, not silently picked', () => {
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        registerModFact(modB, 'inCombat', () => false, { claims: 'inCombat' });

        const conflicts = factFaultStore.getRecords().filter((r) => r.kind === 'conflict');
        expect(conflicts).toHaveLength(1);
        // The fault names the winner so the user can see who collided.
        expect(conflicts[0].reason).toMatch(/Mod A/);
    });
});

describe('registerModFact — duplicate within a mod', () => {
    it('surfaces a duplicate fault but overwrites the publisher', () => {
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        registerModFact(modA, 'inCombat', () => false, { claims: 'inCombat' });

        const dup = factFaultStore.getRecords().find((r) => r.kind === 'duplicate');
        expect(dup).toBeDefined();

        // Only ONE publisher runs (the overwrite removed the old one).
        const result = runFactPublishers();
        expect(result?.facts.inCombat).toBe(false);
    });
});

describe('runFactPublishers — publication and containment', () => {
    it('returns undefined when no publishers are registered', () => {
        expect(runFactPublishers()).toBeUndefined();
    });

    it('publishes a claimed core fact into the overlay', () => {
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        const result = runFactPublishers();
        expect(result?.facts.inCombat).toBe(true);
    });

    it('does not publish a namespaced mod fact into the overlay', () => {
        registerModFact(modA, 'mood', () => 'tense');
        const result = runFactPublishers();
        // Namespaced facts are not in the core facts overlay.
        expect(result?.facts.mood).toBeUndefined();
        expect((result?.facts as Record<string, unknown>).mood).toBeUndefined();
    });

    it('a throwing publisher yields no fact plus a surfaced fault', () => {
        registerModFact(modA, 'inCombat', () => { throw new Error('boom'); }, { claims: 'inCombat' });
        const result = runFactPublishers();
        expect(result?.facts.inCombat).toBeUndefined();
        const record = factFaultStore.getRecords()[0];
        expect(record?.kind).toBe('threw');
        expect(record?.reason).toContain('boom');
    });

    it('an ill-typed value is rejected with a fault', () => {
        // `inCombat` expects boolean; publishing a string is a type error.
        registerModFact(modA, 'inCombat', () => 'not-a-bool' as unknown, { claims: 'inCombat' });
        const result = runFactPublishers();
        expect(result?.facts.inCombat).toBeUndefined();
        const record = factFaultStore.getRecords()[0];
        expect(record?.kind).toBe('threw');
        expect(record?.reason).toContain('boolean');
    });

    it('publishing undefined means "no opinion" — the host value is kept', () => {
        registerModFact(modA, 'inCombat', () => undefined, { claims: 'inCombat' });
        const result = runFactPublishers();
        expect(result?.facts.inCombat).toBeUndefined();
        // No fault — "no opinion" is valid.
        expect(factFaultStore.getRecords()).toHaveLength(0);
    });

    it('runs publishers in loading_order', () => {
        // Mod B (loadIndex 20) publishes after Mod A (loadIndex 10).
        // Both claim inCombat; only A survives (B is a conflict).
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        registerModFact(modB, 'inCombat', () => false, { claims: 'inCombat' });
        const result = runFactPublishers();
        expect(result?.facts.inCombat).toBe(true);
    });
});

describe('disableModFacts / enableModFacts — host-owned teardown', () => {
    it('disable removes all publishers and revokes the lease', () => {
        const unreg = registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        expect(hasFactPublishers()).toBe(true);

        const removed = disableModFacts('mod-a');
        expect(removed).toBe(1);
        expect(hasFactPublishers()).toBe(false);
        expect(hasFactClaim('mod-a', 'inCombat')).toBe(false);
        expect(isModFactsRevoked('mod-a')).toBe(true);

        // A register call after disable is a no-op plus fault.
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        expect(hasFactPublishers()).toBe(false);
        const revoked = factFaultStore.getRecords().find((r) => r.kind === 'revoked');
        expect(revoked).toBeDefined();

        unreg(); // no-op, already removed
    });

    it('enable restores the lease so the mod can register again', () => {
        disableModFacts('mod-a');
        expect(isModFactsRevoked('mod-a')).toBe(true);

        enableModFacts('mod-a');
        expect(isModFactsRevoked('mod-a')).toBe(false);

        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        expect(hasFactPublishers()).toBe(true);
    });

    it('clears the mod fault record on disable so re-enable starts clean', () => {
        registerModFact(modA, 'inCombat', () => { throw new Error('x'); }, { claims: 'inCombat' });
        runFactPublishers();
        expect(factFaultStore.getRecords().length).toBeGreaterThan(0);

        disableModFacts('mod-a');
        expect(factFaultStore.getRecords()).toHaveLength(0);
    });
});

describe('clearAllModFacts — reset', () => {
    it('clears everything', () => {
        registerModFact(modA, 'inCombat', () => true, { claims: 'inCombat' });
        registerModFact(modB, 'mood', () => 'tense');
        expect(hasFactPublishers()).toBe(true);

        clearAllModFacts();
        expect(hasFactPublishers()).toBe(false);
        expect(hasFactClaim('mod-a', 'inCombat')).toBe(false);
        expect(isModFactsRevoked('mod-a')).toBe(false);
        expect(factFaultStore.getRecords()).toHaveLength(0);
    });
});