/**
 * Phase 7.4 — the budget claim API types for `ctx.budgets`.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 7.4 -
 * Budget map without feature names - Medium-mid.md`. A budget is claimed by
 * id, not hardcoded. Built-in claims register at module load in `budgets.ts`;
 * mods claim through `getContext()` via `ctx.budgets.claim`.
 *
 * The registry itself (`budgetClaims.ts`) is name-blind: it holds
 * `BudgetClaim` records and runs their `allocate` functions. This file
 * defines the mod-facing surface that wraps the registry — the same pattern
 * `factTypes.ts` / `factContextFacts.ts` established for `ctx.facts`.
 *
 * Native-tier only — same ruling mounts/macros/events/interceptors/facts
 * made: registration needs a closure (the allocation function), a closure
 * needs a module, and a module is `native.js`. A sandboxed compute mod is
 * handed one snapshot and one journal and cannot hold a closure across
 * turns, so the sandbox binding does not construct a `ModBudgetsApi` and a
 * call from sandbox code is a `TypeError`, contained as a fault.
 */
import type { BudgetAllocationContext } from '../../payload/budgetClaims';

/**
 * A budget allocation function. Pure: reads only the allocation context and
 * any closed-over constants. Returns the token count this claim reserves.
 *
 * The host floors and clamps the result: a non-finite or negative return is
 * treated as zero (absence is quiet, per Phase 7.5 §3). A mod that wants
 * "no allocation this turn" returns `0`.
 */
export type BudgetAllocator = (ctx: BudgetAllocationContext) => number;

/**
 * Phase 7.4 §2 item 3 — the surface a mod's `activate` hook reaches through
 * `ctx.budgets`. One method: a mod registers a budget claim (an id plus an
 * allocation function), the host runs the allocator during `buildPayload`
 * and exposes the result through `BudgetMap.get(id)`.
 *
 * Returns an `unregister()` function so a mod that wants to replace its
 * allocator at runtime has an obvious way to drop the old one first.
 * Teardown on `disable` is host-owned, mirroring mounts/macros/events/
 * interceptors/facts: the host removes every claim the mod registered,
 * never trusting the mod to call `unregister()`.
 *
 * **Namespacing.** The id a mod passes is qualified to `mod.<modId>.<id>`.
 * A mod can therefore never collide with — or impersonate — a built-in
 * claim id (`stable`, `world`, `volatile`, `npc`, `enemy`). Two mods cannot
 * collide either; the second registration is rejected with a fault.
 */
export interface ModBudgetsApi {
    /**
     * Claim a budget by id.
     *
     * `id` is the claim id within this mod. The host qualifies it to
     * `mod.<modId>.<id>` so the claim is namespaced and cannot collide
     * with a built-in or another mod.
     *
     * `allocator` is a pure function of the `BudgetAllocationContext`. It
     * runs once per `buildPayload` call, in registration order, and its
     * result is exposed through `BudgetMap.get('mod.<modId>.<id>')`.
     *
     * `options.name` and `options.description` are optional display fields
     * for the block view / extensions screen. They default to the id.
     *
     * Never throws: a shadow (claiming a built-in id), duplicate, revoked,
     * or bad-args registration records a fault and returns a no-op
     * `unregister`. Throwing inside `activate` would count a strike against
     * the mod and latch its hooks off after three, the same posture mounts
     * and facts take.
     */
    claim(
        id: string,
        allocator: BudgetAllocator,
        options?: { name?: string; description?: string },
    ): () => void;
}

/**
 * A narrow mod view the budget registry needs to attribute a registration.
 * Mirrors `FactRegistryMod` / `MacroRegistryMod`.
 */
export interface BudgetRegistryMod {
    readonly id: string;
    readonly name: string;
}

/**
 * Phase 7.4 — budget claim fault kinds. Uses the existing fault-store shape
 * (`{ modId, file, kind, reason }`), surfaced in Extensions beside the others.
 *
 *   • `shadow`     — the mod tried to claim a built-in id (`stable`, `world`,
 *                     `volatile`, `npc`, `enemy`). Mod claims are namespaced
 *                     to `mod.<modId>.<id>`; claiming a built-in id would
 *                     silently replace a core allocation, which is the
 *                     footgun the namespacing rule exists to prevent.
 *   • `duplicate`  — the mod registered the same id twice. Overwrites the
 *                     allocator but surfaces the duplicate.
 *   • `revoked`    — a claim call after the mod's lease was revoked
 *                     (disabled). No-op plus fault.
 *   • `bad-args`   — the id or allocator was missing or ill-typed. No-op
 *                     plus fault.
 */
export type BudgetFaultKind = 'shadow' | 'duplicate' | 'revoked' | 'bad-args';