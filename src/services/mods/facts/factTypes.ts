/**
 * Phase 5.4 — the fact publication contract types.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.4 -
 * Mods publish facts - Medium-mid.md`. A subsystem leaving core (Phase 8,
 * enemies) must be able to keep publishing the facts it used to provide —
 * otherwise every mod using `when: { inCombat }` silently evaluates to
 * false forever, and that is quietly wrong rather than loudly broken.
 *
 * A mod registers a **fact publisher** through `getContext()` via
 * `ctx.facts.register(name, publisher)`. The host runs every registered
 * publisher once per turn, after the interceptor and before contributions
 * are evaluated, collecting the returned values into a `ModFacts` overlay
 * that merges with the host-computed facts. The merged facts then drive
 * `evaluateWhen` exactly as the host-computed ones always have.
 *
 * ─── NAMESPACING AND THE KNOWN-CORE-FACT EXCEPTION ───────────────────────
 *
 * Mod facts are namespaced: a mod registering `mood` publishes
 * `mod.<modId>.mood`, and a `when` clause referencing it would read the
 * namespaced key. The ONE deliberate exception is a known core fact name
 * (`inCombat`, `location`, `sceneTags`, `onStageNpcNames`) — a mod may
 * CLAIM one of these when it owns that domain (e.g. the enemy mod claiming
 * `inCombat` after Phase 8 extracts enemies from core). A claim is
 * authorised by the host, not self-declared: the registration call accepts
 * a `claims` option, and a claim on a core name the host has not opened
 * for claims is rejected with a fault (the footgun the spec calls out in
 * §2 item 2).
 *
 * Which core names are open for claims is a host-owned configuration point
 * (`CLAIMABLE_CORE_FACTS` in the registry). Today only `inCombat` is open
 * — it is the rehearsal for Phase 8. A future subsystem leaving core opens
 * its own fact name here.
 *
 * Native-tier only — same ruling mounts/macros/events/interceptors made:
 * registration needs a closure (the publisher), a closure needs a module,
 * and a module is `native.js`.
 */
import type { ModFacts } from '../modTypes';

/**
 * A fact publisher. Pure and synchronous: it runs on the hot path of
 * every turn, after the interceptor and before contribution evaluation.
 * Reading host state through `ctx.data.*` is fine; mutating or awaiting
 * is not.
 *
 * Returns the fact value for this turn. Returning `undefined` means "no
 * opinion this turn" — the fact stays at whatever the host or an
 * earlier-load-order mod set it to. Returning a value OVERWRITES the
 * fact for this turn (subject to conflict resolution by `loading_order`).
 *
 * The type of the return depends on the fact name being claimed:
 *   • `inCombat` → `boolean`
 *   • `location` → `string`
 *   • `sceneTags` → `string[]`
 *   • `onStageNpcNames` → `string[]`
 *   • A namespaced mod fact (`mod.<modId>.<name>`) → `unknown` (the host
 *     does not type-check mod-owned facts; `evaluateWhen` only reads the
 *     four core fact keys).
 *
 * Throwing is contained by the registry: the fact yields no value (no
 * match) plus a surfaced fault naming the mod. A throwing or slow
 * publisher must not break the turn (Phase 5.4 §3).
 */
export type FactPublisher = () => unknown;

/**
 * The fact names the host recognises as core facts. A mod may claim one
 * of these (with host authorisation) when it owns that domain. Every
 * other fact name a mod publishes is namespaced to `mod.<modId>.<name>`.
 *
 * This list is the closed set of keys `ModFacts` defines
 * (`modTypes.ts:ModFacts`). A new core fact added there MUST be added
 * here too.
 */
export const CORE_FACT_NAMES: readonly string[] = [
    'onStageNpcNames',
    'location',
    'inCombat',
    'sceneTags',
] as const;

/**
 * The core fact names the host has opened for mod claims. A mod may
 * register a publisher for one of these names and the host will use its
 * value to drive `when` conditions, exactly as the host-computed version
 * does today.
 *
 * Today only `inCombat` is open — it is the rehearsal for Phase 8 (enemies
 * leave core, the enemy mod publishes `inCombat`). Opening a new name
 * here is a deliberate decision: the subsystem that owns the domain
 * opens it, and the host stops computing its own value for it (or keeps
 * computing one as a fallback when no mod claims it — the merge rule is
 * "mod-published wins over host-computed when a claim exists").
 */
export const CLAIMABLE_CORE_FACTS: readonly string[] = [
    'inCombat',
] as const;

/** The frozen set form, for O(1) lookup in the registry. */
export const CLAIMABLE_CORE_FACT_SET: ReadonlySet<string> = new Set(CLAIMABLE_CORE_FACTS);

/** The frozen set of all core fact names. */
export const CORE_FACT_NAME_SET: ReadonlySet<string> = new Set(CORE_FACT_NAMES);

/**
 * Phase 5.4 §2.1 — the surface a mod's `activate` hook reaches through
 * `ctx.facts`. One method: a mod registers a fact name and a publisher,
 * the host runs the publisher once per turn and merges the result into
 * the facts that drive `when` conditions.
 *
 * Returns an `unregister()` function so a mod that wants to replace its
 * publisher at runtime has an obvious way to drop the old one first.
 * Teardown on `disable` is host-owned, mirroring mounts/macros/events/
 * interceptors: the host removes every fact publisher the mod
 * registered, never trusting the mod to call `unregister()`.
 */
export interface ModFactsApi {
    /**
     * Register a fact publisher.
     *
     * `name` is the fact name. For a namespaced mod fact the host
     * qualifies it to `mod.<modId>.<name>` — two mods cannot collide and
     * a mod cannot shadow a core fact (the `when` keys) unless it claims
     * one via the `claims` option.
     *
     * `claims` is optional. When supplied, it names a core fact this mod
     * is claiming ownership of (e.g. `inCombat`). The host must have
     * opened the name for claims (`CLAIMABLE_CORE_FACTS`); otherwise the
     * registration is rejected with a fault. Only ONE mod may claim a
     * given core fact at a time — a second claim is a conflict, resolved
     * by `loading_order` and surfaced (Phase 5.4 §2 item 3).
     *
     * Never throws: a shadow / conflict / revoked / bad-args registration
     * records a fault and returns a no-op `unregister`. Throwing inside
     * `activate` would count a strike against the mod and latch its
     * hooks off after three, the same posture mounts/macros take.
     */
    register(name: string, publisher: FactPublisher, options?: { claims?: string }): () => void;
}

/**
 * Phase 5.4 §3 — fact publication fault kinds. Uses the existing fault-store
 * shape (`{ modId, file, kind, reason }`), surfaced in Extensions beside
 * the others.
 *
 *   • `shadow`     — the mod tried to register a core fact name without a
 *                     claim, or claimed a name the host has not opened.
 *   • `conflict`   — two mods claimed the same core fact. The later in
 *                     `loading_order` loses and is surfaced (not silently
 *                     picked).
 *   • `threw`      — the publisher threw during a turn. The fact yields
 *                     no value (no match) plus the fault.
 *   • `revoked`    — a register call after the mod's lease was revoked
 *                     (disabled). No-op plus fault.
 *   • `duplicate`  — the mod registered the same name twice. Overwrites
 *                     the publisher but surfaces the duplicate.
 */
export type FactFaultKind = 'shadow' | 'conflict' | 'threw' | 'revoked' | 'duplicate';

/**
 * A narrow mod view the registry needs to attribute a registration.
 * Mirrors `MacroRegistryMod` / `InterceptorRegistryMod`.
 */
export interface FactRegistryMod {
    readonly id: string;
    readonly name: string;
    /**
     * The mod's resolved load index. Conflict resolution and publication
     * run order both follow `loading_order` (Phase 5.4 §2 item 3), which
     * is the loader's resolved order — lower runs first, and on a conflict
     * the later one loses. Default `0` — correct for a single-mod test.
     */
    readonly loadIndex?: number;
}

/**
 * Phase 5.4 — the result of running every registered publisher for one
 * turn. The host merges this overlay onto its own computed facts before
 * `evaluateWhen` runs: a claimed core fact overrides the host value;
 * a namespaced mod fact is not read by `evaluateWhen` today (it is
 * available for future expansion and for mods to read through
 * `ctx.data`).
 *
 * `conflicts` carries the surfaced conflicts so the host can surface them
 * in diagnostics (the spec says "surface it rather than silently picking
 * one", §2 item 3).
 */
export interface FactPublicationResult {
    /** The overlay to merge onto the host facts. */
    readonly facts: Partial<ModFacts>;
    /** Conflicts: two mods claimed the same core fact. Surfaced, not hidden. */
    readonly conflicts: readonly { readonly name: string; readonly winner: string; readonly loser: string }[];
}