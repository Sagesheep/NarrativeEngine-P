/**
 * Phase 5.1 — build the `ctx.macros` API for one mod.
 *
 * Mirrors `buildModMountsApi` (Phase 4.2): one method (`register`), per-mod
 * so the host owns the qualification (`mod.<modId>.<name>`) and the
 * teardown on `disable`. The returned object is frozen; a mod cannot
 * reassign its method. A faulted registration returns a no-op
 * `unregister` (§3).
 */
import type { ModMacrosApi, MacroRegistryMod } from './macroTypes';
import { buildModMacrosApi } from './macroRegistry';

export interface ModMacrosApiOptions {
    readonly mod: MacroRegistryMod;
    /** The fault-store file label. Default `mod:<id>`. */
    readonly faultFile?: string;
}

/**
 * Build the `ctx.macros` API for one mod. The returned object is frozen.
 */
export function buildModContextMacros(options: ModMacrosApiOptions): ModMacrosApi {
    return buildModMacrosApi(options.mod, { faultFile: options.faultFile });
}