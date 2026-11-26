import { describe, it, expect, beforeEach } from 'vitest';
import { createBudgetClaimRegistry, type BudgetClaim } from '../budgetClaims';

/**
 * Phase 7.4 — the budget claim registry.
 *
 * Mirrors the shape of `tierBlockRegistry.test.ts` and the contribution
 * registry tests: the registry is name-blind, the budget map is keyed by
 * claim id, and an unregistered id returns zero (the absent-means-zero
 * contract).
 */

function makeClaim(overrides: Partial<BudgetClaim> = {}): BudgetClaim {
    return {
        id: 'test.x',
        source: 'builtin',
        name: 'Test claim',
        description: 'A test claim.',
        allocate: () => 100,
        ...overrides,
    };
}

describe('Phase 7.4 — budget claim registry', () => {
    let registry: ReturnType<typeof createBudgetClaimRegistry>;

    beforeEach(() => {
        registry = createBudgetClaimRegistry();
    });

    describe('register / unregister / list / get', () => {
        it('registers a claim and lists it', () => {
            const claim = makeClaim();
            registry.register(claim);
            expect(registry.list()).toHaveLength(1);
            expect(registry.list()[0]).toBe(claim);
            expect(registry.get('test.x')).toBe(claim);
        });

        it('throws on a duplicate id', () => {
            registry.register(makeClaim());
            expect(() => registry.register(makeClaim())).toThrowError(/duplicate claim id/);
        });

        it('unregisters a claim by id and returns whether it was present', () => {
            registry.register(makeClaim());
            expect(registry.unregister('test.x')).toBe(true);
            expect(registry.unregister('test.x')).toBe(false);
            expect(registry.list()).toHaveLength(0);
        });

        it('unregisters every claim for a mod id', () => {
            registry.register(makeClaim({ id: 'mod.a.x', source: 'mod', modId: 'a' }));
            registry.register(makeClaim({ id: 'mod.a.y', source: 'mod', modId: 'a' }));
            registry.register(makeClaim({ id: 'mod.b.z', source: 'mod', modId: 'b' }));
            registry.unregisterMod('a');
            expect(registry.list().map((c) => c.id)).toEqual(['mod.b.z']);
        });

        it('clears all claims', () => {
            registry.register(makeClaim({ id: 'a' }));
            registry.register(makeClaim({ id: 'b' }));
            registry.clear();
            expect(registry.list()).toHaveLength(0);
        });
    });

    describe('compute', () => {
        it('returns the rules budget taken off the top (10% default)', () => {
            const map = registry.compute(10_000, undefined, false);
            expect(map.rulesBudget).toBe(1_000);
        });

        it('honours a custom rules budget percentage', () => {
            const map = registry.compute(10_000, 0.20, false);
            expect(map.rulesBudget).toBe(2_000);
        });

        it('returns zero for an unregistered id (absent means zero)', () => {
            const map = registry.compute(10_000, undefined, false);
            expect(map.get('nonexistent')).toBe(0);
        });

        it('runs the allocator with the correct allocation context', () => {
            let captured: { limit: number; remainingAfterRules: number; hasDeepContext: boolean } | undefined;
            registry.register({
                id: 'test.ctx',
                source: 'builtin',
                name: 'Context capture',
                description: '',
                allocate: (ctx) => {
                    captured = { ...ctx };
                    return 50;
                },
            });
            const map = registry.compute(10_000, 0.10, true);
            expect(captured).toEqual({ limit: 10_000, remainingAfterRules: 9_000, hasDeepContext: true });
            expect(map.get('test.ctx')).toBe(50);
        });

        it('floors a fractional allocation', () => {
            registry.register({
                id: 'test.frac',
                source: 'builtin',
                name: 'Fractional',
                description: '',
                allocate: () => 99.7,
            });
            const map = registry.compute(10_000, undefined, false);
            expect(map.get('test.frac')).toBe(99);
        });

        it('treats a non-finite allocation as zero (absence is quiet)', () => {
            registry.register({
                id: 'test.nan',
                source: 'mod',
                modId: 'm',
                name: 'NaN',
                description: '',
                allocate: () => Number.NaN,
            });
            registry.register({
                id: 'test.inf',
                source: 'mod',
                modId: 'm',
                name: 'Infinity',
                description: '',
                allocate: () => Number.POSITIVE_INFINITY,
            });
            const map = registry.compute(10_000, undefined, false);
            expect(map.get('test.nan')).toBe(0);
            expect(map.get('test.inf')).toBe(0);
        });

        it('treats a negative allocation as zero', () => {
            registry.register({
                id: 'test.neg',
                source: 'mod',
                modId: 'm',
                name: 'Negative',
                description: '',
                allocate: () => -100,
            });
            const map = registry.compute(10_000, undefined, false);
            expect(map.get('test.neg')).toBe(0);
        });

        it('treats a throwing allocator as zero (absence is quiet)', () => {
            registry.register({
                id: 'test.throw',
                source: 'mod',
                modId: 'm',
                name: 'Throwing',
                description: '',
                allocate: () => { throw new Error('boom'); },
            });
            const map = registry.compute(10_000, undefined, false);
            expect(map.get('test.throw')).toBe(0);
        });

        it('lists only non-zero ids in claimedIds', () => {
            registry.register({ id: 'a', source: 'builtin', name: 'A', description: '', allocate: () => 100 });
            registry.register({ id: 'b', source: 'builtin', name: 'B', description: '', allocate: () => 0 });
            registry.register({ id: 'c', source: 'builtin', name: 'C', description: '', allocate: () => 200 });
            const map = registry.compute(10_000, undefined, false);
            expect(map.claimedIds).toEqual(['a', 'c']);
        });

        it('preserves registration order in claimedIds', () => {
            registry.register({ id: 'z', source: 'builtin', name: 'Z', description: '', allocate: () => 1 });
            registry.register({ id: 'a', source: 'builtin', name: 'A', description: '', allocate: () => 1 });
            const map = registry.compute(10_000, undefined, false);
            expect(map.claimedIds).toEqual(['z', 'a']);
        });
    });
});