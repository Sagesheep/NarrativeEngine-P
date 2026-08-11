import { describe, it, expect, beforeEach } from 'vitest';
import { buildModBudgetsApi, registerModBudgetClaim, disableModBudgets, enableModBudgets, clearAllModBudgets, listModBudgetClaims, isModBudgetsRevoked, qualifyBudgetClaimId } from '../budgetRegistry';
import { budgetClaims } from '../../../payload/budgetClaims';
import { budgetFaultStore } from '../budgetFaults';
import type { BudgetRegistryMod } from '../budgetTypes';

/**
 * Phase 7.4 — the mod-facing budget claim surface (`ctx.budgets`).
 *
 * Mirrors the shape of `factRegistry.test.ts`: the registry qualifies ids,
 * contains faults, tears down on disable, and never throws.
 *
 * Phase 8.3 — the `'enemy'` claim that was this suite's fixture for "a mod
 * may not shadow a built-in id" left core with the enemy subsystem. The
 * fixture is re-pointed to `'world'` (one of the four structural claims
 * `budgetClaims.ts` still registers at module load), so the shadow invariant
 * is still exercised against a real built-in. The `ensureEnemyBudgetClaim`
 * import is gone; `resetState` no longer calls it.
 */

const MOD: BudgetRegistryMod = { id: 'test-mod', name: 'Test Mod' };

function resetState(): void {
    clearAllModBudgets();
    budgetFaultStore.clear();
    // Re-register built-in claims (cleared by `clearAllModBudgets`? No —
    // `clearAllModBudgets` only removes `source: 'mod'` claims. Built-ins
    // survive. But the module-level singleton may have stale state from
    // other tests, so we clear mod claims only.)
}

beforeEach(() => {
    resetState();
});

describe('Phase 7.4 — qualifyBudgetClaimId', () => {
    it('qualifies a bare id to mod.<modId>.<id>', () => {
        expect(qualifyBudgetClaimId('my-mod', 'myBudget')).toBe('mod.my-mod.myBudget');
    });
});

describe('Phase 7.4 — registerModBudgetClaim', () => {
    it('registers a mod claim and exposes it through the budget map', () => {
        const unregister = registerModBudgetClaim(MOD, 'myBudget', () => 250);
        expect(typeof unregister).toBe('function');
        const map = budgetClaims.compute(10_000, undefined, false);
        expect(map.get('mod.test-mod.myBudget')).toBe(250);
        expect(listModBudgetClaims('test-mod')).toContain('mod.test-mod.myBudget');
    });

    it('the returned unregister function removes the claim', () => {
        const unregister = registerModBudgetClaim(MOD, 'temp', () => 100);
        const mapBefore = budgetClaims.compute(10_000, undefined, false);
        expect(mapBefore.get('mod.test-mod.temp')).toBe(100);
        unregister();
        const mapAfter = budgetClaims.compute(10_000, undefined, false);
        expect(mapAfter.get('mod.test-mod.temp')).toBe(0);
    });

    it('namespaces the id so a mod cannot collide with a built-in', () => {
        // Phase 8.3 — the fixture was `'enemy'` (a subsystem claim that
        // registered from outside `budgetClaims.ts`). The enemy claim left
        // core with the subsystem, so the fixture is re-pointed to `'world'`
        // (one of the four structural claims `budgetClaims.ts` registers at
        // module load). The invariant is the same: a mod claiming a built-in
        // id is rejected with a shadow fault.
        const unregister = registerModBudgetClaim(MOD, 'world', () => 999);
        const map = budgetClaims.compute(10_000, undefined, false);
        // The built-in 'world' claim is untouched.
        expect(map.get('world')).toBeGreaterThan(0);
        // The mod's claim was rejected; no 'mod.test-mod.world' was registered.
        expect(map.get('mod.test-mod.world')).toBe(0);
        expect(typeof unregister).toBe('function');
        // A shadow fault was surfaced.
        const records = budgetFaultStore.getRecords();
        expect(records.some((r) => r.kind === 'shadow' && r.modId === 'test-mod')).toBe(true);
    });

    it('rejects bad args (empty id) with a bad-args fault and a no-op unregister', () => {
        const unregister = registerModBudgetClaim(MOD, '', () => 100);
        expect(typeof unregister).toBe('function');
        const records = budgetFaultStore.getRecords();
        expect(records.some((r) => r.kind === 'bad-args' && r.modId === 'test-mod')).toBe(true);
    });

    it('rejects bad args (non-function allocator) with a bad-args fault', () => {
        const unregister = registerModBudgetClaim(MOD, 'broken', 'not-a-function' as unknown as () => number);
        expect(typeof unregister).toBe('function');
        const records = budgetFaultStore.getRecords();
        expect(records.some((r) => r.kind === 'bad-args' && r.modId === 'test-mod')).toBe(true);
    });

    it('surfaces a duplicate-id fault and overwrites the allocator', () => {
        registerModBudgetClaim(MOD, 'dup', () => 100);
        registerModBudgetClaim(MOD, 'dup', () => 200);
        const map = budgetClaims.compute(10_000, undefined, false);
        expect(map.get('mod.test-mod.dup')).toBe(200);
        const records = budgetFaultStore.getRecords();
        expect(records.some((r) => r.kind === 'duplicate' && r.modId === 'test-mod')).toBe(true);
    });

    it('rejects a claim after the mod is disabled (revoked)', () => {
        disableModBudgets('test-mod');
        const unregister = registerModBudgetClaim(MOD, 'postDisable', () => 100);
        void unregister; // rejected claim returns a no-op unregister; nothing to tear down
        const map = budgetClaims.compute(10_000, undefined, false);
        expect(map.get('mod.test-mod.postDisable')).toBe(0);
        const records = budgetFaultStore.getRecords();
        expect(records.some((r) => r.kind === 'revoked' && r.modId === 'test-mod')).toBe(true);
        // Re-enable for teardown.
        enableModBudgets('test-mod');
    });

    it('disableModBudgets removes every claim the mod registered', () => {
        registerModBudgetClaim(MOD, 'a', () => 100);
        registerModBudgetClaim(MOD, 'b', () => 200);
        const mapBefore = budgetClaims.compute(10_000, undefined, false);
        expect(mapBefore.get('mod.test-mod.a')).toBe(100);
        expect(mapBefore.get('mod.test-mod.b')).toBe(200);
        disableModBudgets('test-mod');
        const mapAfter = budgetClaims.compute(10_000, undefined, false);
        expect(mapAfter.get('mod.test-mod.a')).toBe(0);
        expect(mapAfter.get('mod.test-mod.b')).toBe(0);
        expect(isModBudgetsRevoked('test-mod')).toBe(true);
        enableModBudgets('test-mod');
    });
});

describe('Phase 7.4 — buildModBudgetsApi', () => {
    it('returns a frozen API object with a claim method', () => {
        const api = buildModBudgetsApi(MOD);
        expect(Object.isFrozen(api)).toBe(true);
        expect(typeof api.claim).toBe('function');
    });

    it('claim registers through the registry', () => {
        const api = buildModBudgetsApi(MOD);
        const unregister = api.claim('apiBudget', () => 300, { name: 'API Budget', description: 'via api' });
        const map = budgetClaims.compute(10_000, undefined, false);
        expect(map.get('mod.test-mod.apiBudget')).toBe(300);
        const claim = budgetClaims.get('mod.test-mod.apiBudget');
        expect(claim?.name).toBe('API Budget');
        expect(claim?.description).toBe('via api');
        unregister();
        expect(budgetClaims.compute(10_000, undefined, false).get('mod.test-mod.apiBudget')).toBe(0);
    });

    it('defaults name/description to the id', () => {
        const api = buildModBudgetsApi(MOD);
        api.claim('bare', () => 50);
        const claim = budgetClaims.get('mod.test-mod.bare');
        expect(claim?.name).toBe('bare');
        expect(claim?.description).toBe('');
    });
});

describe('Phase 7.4 — budget allocator receives the correct context', () => {
    it('passes limit, remainingAfterRules, and hasDeepContext to the allocator', () => {
        const captured: { limit: number; remainingAfterRules: number; hasDeepContext: boolean }[] = [];
        const api = buildModBudgetsApi(MOD);
        api.claim('ctxProbe', (ctx) => {
            captured.push({ ...ctx });
            return Math.floor(ctx.remainingAfterRules * 0.05);
        });
        budgetClaims.compute(16_384, undefined, false);
        budgetClaims.compute(32_768, 0.20, true);
        expect(captured).toEqual([
            { limit: 16_384, remainingAfterRules: 16_384 - Math.floor(16_384 * 0.10), hasDeepContext: false },
            { limit: 32_768, remainingAfterRules: 32_768 - Math.floor(32_768 * 0.20), hasDeepContext: true },
        ]);
    });
});

describe('Phase 7.4 — built-in claims are untouched by mod operations', () => {
    // Phase 8.3 — the subsystem claim that registered from outside
    // `budgetClaims.ts` left core with the enemy subsystem. These assertions
    // now cover the four structural claims `budgetClaims.ts` registers at
    // module load (`stable`, `world`, `volatile`, `npc`).
    it('clearAllModBudgets does not remove built-in claims', () => {
        // Core's four structural claims should all survive.
        clearAllModBudgets();
        const map = budgetClaims.compute(16_384, undefined, false);
        expect(map.get('stable')).toBeGreaterThan(0);
        expect(map.get('world')).toBeGreaterThan(0);
        expect(map.get('volatile')).toBeGreaterThan(0);
        expect(map.get('npc')).toBeGreaterThan(0);
    });

    it('disableModBudgets does not affect built-in claims', () => {
        disableModBudgets('test-mod');
        const map = budgetClaims.compute(16_384, undefined, false);
        expect(map.get('stable')).toBeGreaterThan(0);
        expect(map.get('world')).toBeGreaterThan(0);
        enableModBudgets('test-mod');
    });
});