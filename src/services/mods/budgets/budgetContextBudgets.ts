/**
 * Phase 7.4 — build the `ctx.budgets` API for one mod.
 *
 * Mirrors `buildModContextFacts` (Phase 5.4): one method (`claim`), per-mod
 * so the host owns the qualification (`mod.<modId>.<id>`) and the teardown
 * on `disable`. The returned object is frozen; a mod cannot reassign its
 * method. A faulted claim returns a no-op `unregister`.
 */
import type { ModBudgetsApi, BudgetRegistryMod } from './budgetTypes';
import { buildModBudgetsApi } from './budgetRegistry';

export interface ModBudgetsApiOptions {
    readonly mod: BudgetRegistryMod;
    /** The fault-store file label. Default `mod:<id>`. */
    readonly faultFile?: string;
}

/**
 * Build the `ctx.budgets` API for one mod. The returned object is frozen.
 */
export function buildModContextBudgets(options: ModBudgetsApiOptions): ModBudgetsApi {
    return buildModBudgetsApi(options.mod, { faultFile: options.faultFile });
}