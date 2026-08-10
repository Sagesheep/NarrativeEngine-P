/**
 * Phase 7.4 — the budget claim registry for mods.
 *
 * The host-level budget registry lives in `budgetClaims.ts` (the name-blind
 * store that `computeBudgets` walks). This module is the mod-facing wrapper:
 * it qualifies ids, contains faults, and tears down on disable.
 *
 * Design notes carried from the work order:
 *
 *   • **Namespacing.** A mod's claim id is qualified to `mod.<modId>.<id>`,
 *     the same way macros and facts are. A mod cannot claim an id a non-mod
 *     owner already registered; claiming one is a `shadow` fault and the
 *     registration is rejected with a no-op `unregister`. Which ids those are
 *     is asked of the registry, never listed here (Phase 7.5).
 *   • **Native-tier only.** Registration needs a closure (the allocator);
 *     a closure needs a module; a module is `native.js`.
 *   • **Never throws.** Shadow / duplicate / revoked / bad-args
 *     registration records a fault and returns a no-op `unregister`.
 *   • **Teardown is host-owned.** `disableModBudgets` removes every claim
 *     the mod registered, at the same call site that already disposes
 *     subscriptions, event listeners, mounts, macros, interceptors and
 *     facts. The mod is never trusted to call `unregister()`.
 *   • **Zero mods → budgets behave exactly as today.** With no mod claims
 *     registered, the budget map contains only the non-mod claims, and
 *     `payloadBuilder` reads the same numbers it always has.
 *   • **Absence stays zero.** A mod claim disappears when its mod is disabled,
 *     and `budgetMap.get(...)` returns 0 for it — the "absent means no
 *     allocation" contract (Phase 7.5 §3).
 */
import type { BudgetAllocator, BudgetRegistryMod, ModBudgetsApi } from './budgetTypes';
import { budgetClaims } from '../../payload/budgetClaims';
import { budgetFaultStore, formatBudgetFaultReason } from './budgetFaults';

/** The id prefix that marks a mod-owned claim. */
const MOD_PREFIX = 'mod.';

/**
 * Whether `id` is already claimed by a non-mod owner and therefore may not be
 * shadowed.
 *
 * **Phase 7.5 made this computed rather than listed.** It used to be a
 * hardcoded `new Set(['stable', 'world', 'volatile', 'npc', 'enemy'])` — a
 * feature name in the mods layer, and one that would have gone stale silently
 * the moment the subsystem left core: the list would still have named a claim
 * nothing registered, so a mod would have kept being refused an id that was
 * free. Asking the registry is both name-blind and self-maintaining, and it
 * covers subsystem claims that register outside `budgetClaims.ts` (7.5) for
 * free.
 */
function isReservedClaimId(id: string): boolean {
    return budgetClaims.get(id)?.source === 'builtin';
}

/** The qualified id for a mod-owned claim: `mod.<modId>.<id>`. */
export function qualifyBudgetClaimId(modId: string, id: string): string {
    return `${MOD_PREFIX}${modId}.${id}`;
}

/** The set of mods whose lease has been revoked (disabled). */
const revokedMods = new Set<string>();

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isAllocator(value: unknown): value is BudgetAllocator {
    return typeof value === 'function';
}

/**
 * Phase 7.4 §2 item 1 — register a mod's budget claim.
 *
 * The host qualifies the id to `mod.<modId>.<id>`. A mod can therefore never
 * collide with a non-mod claim or with another mod's claim.
 *
 * Never throws: a shadow / duplicate / revoked / bad-args registration
 * records a fault and returns a no-op `unregister`.
 */
export function registerModBudgetClaim(
    mod: BudgetRegistryMod,
    id: string,
    allocator: BudgetAllocator,
    options: { faultFile?: string; name?: string; description?: string } = {},
): () => void {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;

    // Bad args — programming bug; record a fault and no-op.
    if (!isNonEmptyString(id) || !isAllocator(allocator)) {
        budgetFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'bad-args',
            name: isNonEmptyString(id) ? id : undefined,
            reason: formatBudgetFaultReason({
                modName: mod.name,
                kind: 'bad-args',
                name: isNonEmptyString(id) ? id : undefined,
                message: 'invalid id or allocator',
            }),
        });
        return () => undefined;
    }

    // Revoked lease — no-op plus fault.
    if (revokedMods.has(mod.id)) {
        budgetFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'revoked',
            name: id,
            reason: formatBudgetFaultReason({ modName: mod.name, kind: 'revoked', name: id }),
        });
        return () => undefined;
    }

    // Shadow check: a mod may not claim an id a non-mod owner already holds.
    // The namespacing rule qualifies the id to `mod.<modId>.<id>`, but a mod
    // that passes a bare reserved id (`'stable'`) would produce
    // `mod.<modId>.stable`, which is legal but confusing — the mod plainly
    // meant to change the host's allocation and would get a private one
    // instead. The direct check catches the obvious footgun; the registry's
    // duplicate check catches the rest.
    if (isReservedClaimId(id)) {
        budgetFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'shadow',
            name: id,
            reason: formatBudgetFaultReason({ modName: mod.name, kind: 'shadow', name: id }),
        });
        return () => undefined;
    }

    const qualifiedId = qualifyBudgetClaimId(mod.id, id);
    const displayName = options.name ?? id;
    const displayDescription = options.description ?? '';

    // Duplicate-id check. A re-registration overwrites the allocator (the
    // mod is replacing it) but the fault is surfaced.
    if (budgetClaims.get(qualifiedId) !== undefined) {
        budgetFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'duplicate',
            name: id,
            reason: formatBudgetFaultReason({ modName: mod.name, kind: 'duplicate', name: id }),
        });
        budgetClaims.unregister(qualifiedId);
    }

    budgetClaims.register({
        id: qualifiedId,
        source: 'mod',
        modId: mod.id,
        name: displayName,
        description: displayDescription,
        allocate: allocator,
    });

    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        budgetClaims.unregister(qualifiedId);
    };
}

/** The registered claim ids for a mod, in registration order. Diagnostics and tests. */
export function listModBudgetClaims(modId: string): readonly string[] {
    return budgetClaims.list()
        .filter((c) => c.modId === modId)
        .map((c) => c.id);
}

/** Test helper: whether a mod's lease is revoked. */
export function isModBudgetsRevoked(modId: string): boolean {
    return revokedMods.has(modId);
}

/**
 * Phase 7.4 — host-owned teardown. `disable` removes every claim the mod
 * registered, at the same call site that already disposes subscriptions,
 * event listeners, mounts, macros, interceptors and facts. The mod is never
 * trusted to call `unregister()`.
 *
 * Clears the mod's fault record too, so a re-enable starts clean.
 */
export function disableModBudgets(modId: string): number {
    revokedMods.add(modId);
    budgetClaims.unregisterMod(modId);
    budgetFaultStore.clearMod(modId);
    return 0;
}

/**
 * Allow a mod to register again after a re-enable. Mirrors
 * `enableModFacts` / `enableModMacros`.
 */
export function enableModBudgets(modId: string): void {
    revokedMods.delete(modId);
}

/**
 * `lifecycleHost.reset()` — clear ALL mod budget claims. Test/teardown only.
 * Does NOT clear built-in claims (those register at module load in
 * `budgets.ts` and re-register on re-import).
 */
export function clearAllModBudgets(): void {
    // Remove every mod-namespaced claim.
    const modClaimIds = budgetClaims.list()
        .filter((c) => c.source === 'mod')
        .map((c) => c.id);
    for (const id of modClaimIds) budgetClaims.unregister(id);
    revokedMods.clear();
    budgetFaultStore.clear();
}

/**
 * Phase 7.4 — build the `ctx.budgets` API for one mod. The returned object
 * is frozen; a mod cannot reassign its method. Mirrors `buildModFactsApi`
 * (Phase 5.4).
 */
export function buildModBudgetsApi(mod: BudgetRegistryMod, options: { faultFile?: string } = {}): ModBudgetsApi {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;
    return Object.freeze({
        claim: (id: string, allocator: BudgetAllocator, opts?: { name?: string; description?: string }): () => void =>
            registerModBudgetClaim(mod, id, allocator, { faultFile, name: opts?.name, description: opts?.description }),
    });
}