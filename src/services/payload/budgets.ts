import { budgetClaims, ensureBuiltinClaims } from './budgetClaims';
import type { BudgetMap } from './budgetClaims';

/**
 * Phase 7.4 — the budget map, claimed not hardcoded.
 *
 * `computeBudgets` used to allocate token budgets by feature name, all in one
 * function, with `payloadBuilder` reading the resulting fields directly. That
 * made the payload path know every feature by name, which is the god-node
 * shape the previous epic fought for prompt text and the contribution registry
 * fixed.
 *
 * This file is the same cure applied to budgets. Core's four structural claims
 * register at module load in `budgetClaims.ts` (the registry module) with
 * their EXACT current formulae — same numbers, same proportions, same
 * floor/ceiling behaviour. `computeBudgets` then delegates to the registry,
 * which runs every claim (core's, a subsystem's, a mod's) and returns a
 * `BudgetMap` keyed by id. Consumers read `budgetMap.get(id)`, and Phase 7.5
 * made the one id that is not structural resolve through the segment that
 * spends it — so no feature is named here at all.
 *
 * When a subsystem leaves core (Phase 8), its claim is unregistered and
 * `get(id)` returns 0: "absent means no allocation", the quiet absence Phase
 * 7.5 §3 requires. The residual flows to history as before, because
 * `buildHistory`'s budget is `limit - reservedTotal`, and a zero allocation
 * is not reserved.
 *
 * **Byte-identical with zero mods.** The claims reproduce the numbers the old
 * `computeBudgets` produced, verified by `budgetByteIdentical.test.ts` at
 * 8k / 32k / 128k.
 */

// Ensure the four core claims are registered. `budgetClaims.ts` registers them
// at its own module load too; this call is idempotent and belt-and-braces so
// an import of `budgets.ts` alone (without the registry module) still produces
// a populated budget map. `ensureBuiltinClaims` guards against
// double-registration.
ensureBuiltinClaims();

/**
 * Compute the budget map for a turn.
 *
 * Delegates to the `budgetClaims` registry, which runs every registered
 * claim (built-in and mod) against the same allocation context. The returned
 * `BudgetMap` exposes budgets by id via `get(id)`, with `0` for an
 * unregistered id (the absent-means-zero contract).
 *
 * The return type is widened to `BudgetMap` — callers read `budgetMap.get('stable')`
 * etc. rather than `budgetMap.stable`. The ids are stable: a consumer reading
 * `get('stable')` gets the same number the old `budgetMap.stable` carried.
 * This is the indirection the brief asks for: the payload path no longer knows
 * a feature by name; it knows the id it registered.
 */
export function computeBudgets(
    limit: number,
    rulesBudgetPct: number | undefined,
    hasDeepContext: boolean,
): { rulesBudget: number; budgetMap: BudgetMap } {
    // Re-register the built-ins if a test called `budgetClaims.clear()`.
    // Idempotent — `ensureBuiltinClaims` guards on a module-level flag.
    ensureBuiltinClaims();
    const budgetMap = budgetClaims.compute(limit, rulesBudgetPct, hasDeepContext);
    return { rulesBudget: budgetMap.rulesBudget, budgetMap };
}

// Re-export the registry and the allocation context type so the bootstrap and
// the mod context can register/claim budgets without reaching into the
// registry module directly. Mirrors the `aiTier.ts` re-export of
// `modTierBlocks`.
export { budgetClaims, ensureBuiltinClaims } from './budgetClaims';
export type { BudgetAllocationContext, BudgetClaim, BudgetMap as BudgetMapType } from './budgetClaims';