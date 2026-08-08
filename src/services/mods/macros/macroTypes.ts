/**
 * Phase 5.1 — the macro registry contract types.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.1 -
 * Macro registry - Medium-mid.md`. The design copies SillyTavern's
 * `macros.register()` shape: a mod declares a name and a resolver through
 * `getContext()`; the host expands `{{name}}` during prompt assembly.
 *
 * This module owns only the contract types. The registry itself
 * (`macroRegistry.ts`) is the module-level store; the per-mod API
 * (`macroContextMacros.ts`) is the `ctx.macros` wrapper; the fault store
 * (`macroFaults.ts`) is the sixth fault store, in the shape the repo already
 * uses for mounts/events/reactive reads.
 *
 * Native-tier only — same ruling `MOUNTS.md` §8.1 made for `ctx.mounts` and
 * `EVENTS.md` §5.1 made for `ctx.events`: registration needs a closure (the
 * resolver), a closure needs a module, and a module is `native.js`. A
 * sandboxed compute mod is handed one snapshot and one journal and cannot
 * hold a closure across to prompt assembly. The sandbox binding therefore
 * does not construct a `ModMacrosApi` and a call from sandbox code is a
 * `TypeError`, the same shape the existing `events`/`mounts` stubs take.
 */

/**
 * A macro resolver. Pure and synchronous: it runs during prompt assembly,
 * which is on the hot path of every turn. Reading host state through
 * `ctx.data.*` is fine; mutating or awaiting is not.
 *
 * Returns the string the `{{name}}` slot expands to. Returning `''` is
 * the defined "inactive this turn" path — the slot expands to nothing and
 * the contribution's budget is unchanged.
 *
 * Throwing is contained by the registry: the slot expands to `''` plus a
 * surfaced fault naming the mod. A throwing or slow resolver must not break
 * prompt assembly (Phase 5.1 §3).
 */
export type MacroResolver = () => string;

/**
 * `Phase 5.1 §2.1` — the surface a mod's `activate` hook reaches through
 * `ctx.macros`. One method: a mod registers a name and a resolver, the host
 * expands `{{name}}` (the bare name — namespacing is host-owned and
 * invisible to authors, the same discipline `ctx.table` already uses for
 * table names).
 *
 * Returns an `unregister()` function so a mod that wants to replace its
 * resolver at runtime (e.g. after a `ctx.refresh()`) has an obvious way to
 * drop the old one before registering the new. Teardown on `disable` is
 * host-owned, mirroring mounts/events/subscriptions: the host removes every
 * macro the mod registered, never trusting the mod to call `unregister()`.
 */
export interface ModMacrosApi {
    /**
     * Register a macro. The name is qualified to `mod.<modId>.<name>` by the
     * host, so two mods cannot collide and a mod cannot shadow a built-in
     * slot (`{{location}}`, `{{npcs}}`).
     *
     * Shadowing a built-in slot is rejected with a fault (Phase 5.1 §2.2).
     * The set of built-in slot names is the closed list `renderTemplate`
     * already understands; a mod may not register `location` or `npcs`.
     *
     * Never throws: a shadow / duplicate / revoked-lease registration records
     * a fault and returns a no-op `unregister`. Throwing inside `activate`
     * would count a strike against the mod and latch its hooks off after
     * three (`lifecycleHost.ts`), the same posture mounts take.
     */
    register(name: string, resolver: MacroResolver): () => void;
}

/**
 * `Phase 5.1 §3` — macro fault kinds. Uses the existing fault-store shape
 * (`{ modId, file, kind, reason }`), surfaced in Extensions beside the
 * others.
 */
export type MacroFaultKind = 'shadow' | 'duplicate' | 'threw' | 'revoked';

/**
 * A narrow mod view the registry needs to attribute a registration. The
 * host owns the qualification (`mod.<modId>.<name>`) and the fault record,
 * both keyed by `modId`. Mirrors `MountRegistryMod`.
 */
export interface MacroRegistryMod {
    readonly id: string;
    readonly name: string;
}