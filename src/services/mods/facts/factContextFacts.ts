/**
 * Phase 5.4 — build the `ctx.facts` API for one mod.
 *
 * Mirrors `buildModContextMacros` (Phase 5.1): one method (`register`),
 * per-mod so the host owns the qualification and the teardown on
 * `disable`. The returned object is frozen; a mod cannot reassign its
 * method. A faulted registration returns a no-op `unregister`.
 */
import type { ModFactsApi, FactRegistryMod } from './factTypes';
import { buildModFactsApi } from './factRegistry';

export interface ModFactsApiOptions {
    readonly mod: FactRegistryMod;
    /** The fault-store file label. Default `mod:<id>`. */
    readonly faultFile?: string;
}

/**
 * Build the `ctx.facts` API for one mod. The returned object is frozen.
 */
export function buildModContextFacts(options: ModFactsApiOptions): ModFactsApi {
    return buildModFactsApi(options.mod, { faultFile: options.faultFile });
}