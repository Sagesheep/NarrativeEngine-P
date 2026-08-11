/**
 * Phase 5.1 — the macro registry.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.1 -
 * Macro registry - Medium-mid.md`. This module owns the namespaced store,
 * the shadow-rejection rule (§2.2), the resolver containment rule (§3), and
 * the host-owned teardown on `disable` (same site mounts/subscriptions/
 * event listeners already use).
 *
 * Design notes carried from Phase 5.1:
 *
 *   • **Namespacing.** A mod's macro is namespaced the way contributions
 *     and tables already are (`modAdapter.ts:modSpecId`): the host qualifies
 *     `name` to `mod.<modId>.<name>`. A mod may not shadow `{{location}}`
 *     or `{{npcs}}` — the closed list `renderTemplate` already understands.
 *   • **Native-tier only.** Registration needs a closure (the resolver); a
 *     closure needs a module; a module is `native.js`. The sandbox binding
 *     does not construct a `ModMacrosApi` and a call from sandbox code is a
 *     `TypeError`, the same shape `events`/`mounts` take.
 *   • **Never throws.** Shadow / duplicate / revoked-lease registration
 *     records a fault and returns a no-op `unregister`. Throwing inside
 *     `activate` would count a strike against the mod and latch its hooks
 *     off after three (`lifecycleHost.ts`), killing registrations that were
 *     fine — the same posture mounts take.
 *   • **Teardown is host-owned.** `disableModMacros` removes every macro
 *     the mod registered, at the same call site that already disposes
 *     subscriptions, event listeners, and mounts. The mod is never trusted
 *     to call `unregister()`.
 *   • **Resolver containment.** `resolveMacros` is the function
 *     `renderTemplate` calls. A throwing resolver is contained: the slot
 *     expands to `''` plus a surfaced fault. Prompt assembly never breaks.
 *
 * Prompt-cache stability (Phase 5.1 §3, load-bearing): a macro's output
 * lands in the final user message (the `final-user` slot, below the cache
 * boundary), so a macro cannot perturb the cached prefix by construction.
 * `payloadCacheStability.test.ts` stays green by design.
 */
import type { MacroRegistryMod, MacroResolver, ModMacrosApi } from './macroTypes';
import { macroFaultStore, formatMacroFaultReason } from './macroFaults';

/** The id prefix that marks a mod-owned macro. A built-in never carries it. */
const MOD_PREFIX = 'mod.';

/** The qualified name for a mod macro: `mod.<modId>.<name>`. */
export function qualifyMacroName(modId: string, name: string): string {
    return `${MOD_PREFIX}${modId}.${name}`;
}

/**
 * The closed set of built-in slot names `renderTemplate` already
 * understands. A mod may not register a macro with any of these names —
 * shadowing a built-in is rejected with a fault (Phase 5.1 §2.2).
 *
 * Kept here rather than in `modAdapter.ts` so the registry owns the
 * rejection decision (the resolver never runs for a shadowed name); the
 * adapter owns only the substitution order. The two must stay in step: a
 * new built-in slot added to `renderTemplate`'s `switch` MUST be added
 * here too.
 */
export const BUILTIN_MACRO_NAMES: ReadonlySet<string> = new Set(['location', 'npcs']);

interface RegisteredMacro {
    readonly modId: string;
    readonly modName: string;
    readonly resolver: MacroResolver;
}

/** Per-mod maps of bare name → registered macro. Keyed by mod id, then bare name. */
const byMod = new Map<string, Map<string, RegisteredMacro>>();

/** The flat lookup the adapter reads: qualified name → resolver. */
const qualified = new Map<string, RegisteredMacro>();

/** The set of mods whose lease has been revoked (disabled). Registration after this is a no-op + fault. */
const revokedMods = new Set<string>();

function isNonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function isResolver(value: unknown): value is MacroResolver {
    return typeof value === 'function';
}

/**
 * Phase 5.1 §2.1 — register a mod's macro. The host qualifies the name, so
 * two mods cannot collide and a mod cannot shadow a built-in slot. Returns
 * an `unregister()` so a mod that wants to replace its resolver has an
 * obvious way to drop the old one first.
 *
 * Never throws: a shadow / duplicate / revoked / bad-args registration
 * records a fault and returns a no-op `unregister`. Throwing inside
 * `activate` would count a strike against the mod and latch its hooks off
 * after three (`lifecycleHost.ts`), killing registrations that were fine.
 */
export function registerModMacro(
    mod: MacroRegistryMod,
    name: string,
    resolver: MacroResolver,
    options: { faultFile?: string } = {},
): () => void {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;

    // Bad args are a programming bug; record a fault and no-op. The mod's
    // `activate` continues, so a single bad registration does not latch
    // the mod's hooks off.
    if (!isNonEmptyString(name) || !isResolver(resolver)) {
        macroFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'duplicate',
            name: isNonEmptyString(name) ? name : undefined,
            reason: formatMacroFaultReason({
                modName: mod.name,
                kind: 'duplicate',
                name: isNonEmptyString(name) ? name : undefined,
                message: 'invalid name or resolver',
            }),
        });
        return () => undefined;
    }

    // Revoked lease (§3): a register call after the mod's lease is revoked
    // is a no-op plus a fault, not a throw.
    if (revokedMods.has(mod.id)) {
        macroFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'revoked',
            name,
            reason: formatMacroFaultReason({ modName: mod.name, kind: 'revoked', name }),
        });
        return () => undefined;
    }

    // Shadow-rejection (§2.2). A mod may not register `location` or `npcs`.
    // The check is against the bare name the mod declared, case-sensitive —
    // `{{LOCATION}}` is NOT `{{location}}` (the adapter is case-sensitive
    // too, so `{{LOCATION}}` is already an unknown slot today).
    if (BUILTIN_MACRO_NAMES.has(name)) {
        macroFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'shadow',
            name,
            reason: formatMacroFaultReason({ modName: mod.name, kind: 'shadow', name }),
        });
        return () => undefined;
    }

    // Duplicate-id check within the mod. Name both — do not silently
    // first-win (`MANIFEST.md` §6.1's duplicate-id voice). A re-registration
    // with the same name overwrites the resolver (the mod is replacing it)
    // but the fault is surfaced so the author notices the duplicate.
    const modMap = byMod.get(mod.id);
    if (modMap !== undefined && modMap.has(name)) {
        macroFaultStore.add({
            modId: mod.id,
            file: faultFile,
            kind: 'duplicate',
            name,
            reason: formatMacroFaultReason({ modName: mod.name, kind: 'duplicate', name }),
        });
        // Fall through and overwrite — the mod is replacing its resolver.
    }

    const record: RegisteredMacro = { modId: mod.id, modName: mod.name, resolver };
    if (modMap === undefined) {
        const fresh = new Map<string, RegisteredMacro>();
        fresh.set(name, record);
        byMod.set(mod.id, fresh);
    } else {
        modMap.set(name, record);
    }
    qualified.set(qualifyMacroName(mod.id, name), record);

    let removed = false;
    return () => {
        if (removed) return;
        removed = true;
        unregisterModMacro(mod.id, name);
    };
}

/** Remove one macro. Called by the returned `unregister()` and by `disableModMacros`. */
function unregisterModMacro(modId: string, name: string): void {
    const modMap = byMod.get(modId);
    if (modMap === undefined) return;
    if (!modMap.delete(name)) return;
    qualified.delete(qualifyMacroName(modId, name));
    if (modMap.size === 0) byMod.delete(modId);
}

/**
 * Phase 5.1 §2.4 — the function `renderTemplate` calls. Expand one slot
 * name against the registry. Returns:
 *   • `string` — the resolver's output, if a mod macro matched.
 *   • `undefined` — no mod macro matched (the adapter falls through to the
 *     built-in slots, then to the verbatim fallback).
 *
 * Resolver containment (§3): a throwing resolver is contained. The slot
 * expands to `''` (the "inactive this turn" path) plus a surfaced fault
 * naming the mod. Prompt assembly never breaks.
 *
 * The `qualifiedName` argument is the host-qualified form
 * `mod.<modId>.<name>`; the `bareName` is what the author wrote inside
 * `{{…}}`. The adapter passes both so the registry can look up by the
 * qualified form (the namespaced key) without re-deriving it.
 */
export function resolveMacro(qualifiedName: string, bareName: string): string | undefined {
    // A built-in slot name is never in `qualified` (the registry rejects
    // shadows), so this lookup naturally misses `location`/`npcs` and the
    // adapter's built-in switch runs. The check is here so a future
    // built-in slot added to the adapter does not accidentally become
    // resolvable through the registry.
    if (BUILTIN_MACRO_NAMES.has(bareName)) return undefined;

    const record = qualified.get(qualifiedName);
    if (record === undefined) return undefined;

    try {
        return record.resolver();
    } catch (error) {
        // Contain the fault: empty string plus a surfaced fault naming the
        // mod. The slot expands to nothing; the contribution's budget is
        // unchanged. Prompt assembly never breaks (§3).
        macroFaultStore.add({
            modId: record.modId,
            file: `mod:${record.modId}`,
            kind: 'threw',
            name: bareName,
            reason: formatMacroFaultReason({
                modName: record.modName,
                kind: 'threw',
                name: bareName,
                message: error instanceof Error ? error.message : String(error),
            }),
        });
        return '';
    }
}

/**
 * Phase 9.2 / 6.9.2 awkward moment #3 — report a `{{…}}` slot in a mod's own
 * contribution text that matched no registered macro.
 *
 * Before this, the slot shipped to the model as literal braces with **no
 * signal anywhere**: not a load fault, not a runtime fault, not a log line.
 * 6.9.2 predicted an author would lose a whole feature to it and never know;
 * two shipped mods then did exactly that (see 9.2's report). The text is still
 * left verbatim — an author reading the prompt sees the typo, which was always
 * the intent — but an author who is not reading the prompt now sees it in
 * Extensions.
 *
 * Deduped per `(modId, slot)` for the session: this runs on the hot path of
 * every turn and the fault store notifies its listeners on every `add`. The
 * dedupe set is cleared with the registry, so a disable/enable cycle reports
 * again — which is what a user who just re-enabled a mod expects to see.
 */
const reportedUnresolved = new Set<string>();

export function reportUnresolvedMacroSlot(modId: string, slot: string): void {
    const key = `${modId} ${slot}`;
    if (reportedUnresolved.has(key)) return;
    reportedUnresolved.add(key);
    // The registry knows a mod's display name only if that mod registered a
    // macro; a mod whose every slot is a typo registered none. The id is what
    // Extensions keys on either way, so it is the honest fallback.
    const firstRecord = byMod.get(modId)?.values().next().value;
    const modName = firstRecord?.modName ?? modId;
    macroFaultStore.add({
        modId,
        file: `mod:${modId}`,
        kind: 'unresolved',
        name: slot,
        reason: formatMacroFaultReason({ modName, kind: 'unresolved', name: slot }),
    });
}

/**
 * Test/inspection helper: the qualified names every mod has registered.
 * Used by tests to assert the registry state; not called by prompt assembly.
 */
export function listMacros(): readonly string[] {
    return [...qualified.keys()];
}

/**
 * Test/inspection helper: whether a mod has registered a macro by bare name.
 */
export function hasModMacro(modId: string, name: string): boolean {
    return byMod.get(modId)?.has(name) ?? false;
}

/**
 * Phase 5.1 §3 — host-owned teardown. `disable` removes every macro the
 * mod registered, at the same call site that already disposes
 * subscriptions, event listeners, and mounts. The mod is never trusted to
 * call `unregister()`.
 *
 * Clears the mod's fault record too, so a re-enable starts clean in the
 * Extensions list (matches `mountFaultStore`'s per-mod clear on disable).
 */
export function disableModMacros(modId: string): number {
    revokedMods.add(modId);
    // Phase 9.2 — drop this mod's reported-slot memory alongside its faults so
    // a re-enable reports again rather than looking clean because it already
    // told the user once.
    for (const key of [...reportedUnresolved]) {
        if (key.startsWith(`${modId} `)) reportedUnresolved.delete(key);
    }
    const modMap = byMod.get(modId);
    if (modMap === undefined) {
        // Still clear faults — a mod that registered nothing but faulted
        // on a shadow attempt should start clean on re-enable.
        macroFaultStore.clearMod(modId);
        return 0;
    }
    let removed = 0;
    for (const name of [...modMap.keys()]) {
        qualified.delete(qualifyMacroName(modId, name));
        removed++;
    }
    byMod.delete(modId);
    macroFaultStore.clearMod(modId);
    return removed;
}

/**
 * Allow a mod to register again after a re-enable. Called by the lifecycle
 * host on `enable` (mirrors `enableModMounts`).
 */
export function enableModMacros(modId: string): void {
    revokedMods.delete(modId);
}

/**
 * `lifecycleHost.reset()` — clear ALL macros. Test/teardown only.
 */
export function clearAllModMacros(): void {
    byMod.clear();
    qualified.clear();
    revokedMods.clear();
    reportedUnresolved.clear();
    macroFaultStore.clear();
}

/**
 * Test helper: whether a mod's lease is revoked.
 */
export function isModMacrosRevoked(modId: string): boolean {
    return revokedMods.has(modId);
}

/**
 * Phase 5.1 §2.1 — build the `ctx.macros` API for one mod. The returned
 * object is frozen; a mod cannot reassign its methods. Mirrors
 * `buildModMountsApi` (Phase 4.2).
 */
export function buildModMacrosApi(mod: MacroRegistryMod, options: { faultFile?: string } = {}): ModMacrosApi {
    const faultFile = options.faultFile ?? `mod:${mod.id}`;
    return Object.freeze({
        register: (name: string, resolver: MacroResolver): () => void =>
            registerModMacro(mod, name, resolver, { faultFile }),
    });
}

/**
 * Re-export the fault kinds for tests that want to assert on them.
 */
export type { MacroFaultKind } from './macroTypes';