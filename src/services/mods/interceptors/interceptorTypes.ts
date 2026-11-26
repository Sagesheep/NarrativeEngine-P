/**
 * Phase 5.2 — the pre-prompt / generation interceptor contract types.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.2 -
 * Pre-prompt generation interceptor - Frontier-high.md`, and it is the most
 * dangerous phase in the epic: it puts mod code inside the path that builds
 * the prompt the user pays for, and that path has a cache-stability contract.
 *
 * The manifest field is `native.generateInterceptor` (`MANIFEST.md` §3), which
 * names a function exported by `native.js`. `MANIFEST.md` §10 item 2 left the
 * argument and return shape to this phase, "constrained by 2.2". This module
 * is that decision.
 *
 * ─── THE FIVE DECISIONS (Phase 5.2 §2) ────────────────────────────────────
 *
 * 1. **Where it fires** — `turn.payloadBuilding`. Named in `EVENTS.md`'s
 *    vocabulary (it is the counterpart of `turn.payloadBuilt`, `EVENTS.md`
 *    §6.3) even though it is a HOOK, not an event: it has a return value, and
 *    events are observational for ever (`EVENTS.md` §4.1). It fires once per
 *    turn, in `turnOrchestrator.ts`, after `runDirectorStage` and before
 *    `buildTurnPayload` — the first instant at which every input the payload
 *    consumes is settled and the last instant before assembly begins. No
 *    payload assembly is reordered to make this possible (§5 stop condition).
 *
 * 2. **What it receives** — ONE argument: a frozen, shallow, scalar record of
 *    the turn's inputs (`PromptInterceptorInput`). The payload rule from
 *    `EVENTS.md` §3 applies verbatim: identity plus anything observable only
 *    at that instant, never a collection a mod can read from `ctx.data`,
 *    never a host type, never a credential. A mod that needs live host state
 *    reads it through the `ModContext` its `activate` captured — that is what
 *    Phase 2.4's `ctx.subscribe` and `ctx.refresh()` exist for.
 *
 * 3. **What it may return** — additive and subtractive only, per the phase's
 *    own recommendation. A mod may CONTRIBUTE blocks and may SUPPRESS
 *    permitted ones. It may not rewrite the player's message, edit an
 *    existing block's text, or reorder assembly.
 *    `PROTECTED_SUPPRESSION_IDS` (`user.message`, `volatile.block`,
 *    `askgm.brief`, `absolute.command`) is absolute: a suppression naming one
 *    is rejected with a reason and dropped, and the rest of the interception
 *    still lands.
 *
 * 4. **Async or sync** — async is ALLOWED, under a hard per-interceptor
 *    deadline (`INTERCEPTOR_DEADLINE_MS`). Interceptors run concurrently and
 *    their results are collected in resolved load order, so the stage's wall
 *    time is bounded by the slowest single interceptor rather than by their
 *    sum. A timed-out or throwing interceptor is faulted and the turn
 *    continues with the un-intercepted payload.
 *
 * 5. **Ordering** — the loader's resolved load order (`MANIFEST.md` §6.3),
 *    consistent with mounts (`MOUNTS.md` §3.1), events (`EVENTS.md` §4.2) and
 *    everything else in the epic. Ties break on mod id ascending, which is
 *    what the loader already guarantees upstream.
 *
 * ─── WHAT IS NOT HERE ─────────────────────────────────────────────────────
 *
 * There is no `ctx.interceptors.register()`. The interceptor is declared in
 * the manifest and resolved from the module's exports, exactly as
 * `MANIFEST.md` §3 says — one interceptor per mod, discoverable without
 * running any code. That is deliberately unlike macros/mounts/events, which
 * need a runtime call because they take a name the manifest cannot carry.
 */
import type { ContributionSpec } from '../../payload/contributions/types';

/**
 * Phase 5.2 §2.1 — the hook's name in `EVENTS.md`'s vocabulary.
 *
 * A hook, not an event: nothing is emitted on the bus under this name, and
 * `modEventBus.emit('turn.payloadBuilding', …)` is not a thing. The name
 * exists so the fire point has one word in the same grammar the twenty core
 * events use, and so a future reader does not invent a second vocabulary for
 * "the moment before assembly".
 */
export const PROMPT_INTERCEPTOR_HOOK_NAME = 'turn.payloadBuilding' as const;

/**
 * Phase 5.2 §2.4 — the hard per-interceptor deadline, in milliseconds.
 *
 * 1500 ms, chosen against two constraints the work order states directly:
 * "an async interceptor delays every turn" and "the timeout must be short
 * enough that a broken mod does not make the app feel dead". It is under a
 * third of the lifecycle host's 5 s (`LIFECYCLE_DEADLINE_MS`), because a
 * lifecycle hook fires once per session and this fires once per turn.
 *
 * It deliberately does NOT accommodate a model call. An interceptor that
 * wants LLM-authored text should compute it off the turn path (a compute
 * track, a `turn.committed` listener) and publish the result to its own
 * table, then read the table here — which is synchronous and free. Blocking
 * every turn on a third party's network call is not a capability this phase
 * grants by accident.
 */
export const INTERCEPTOR_DEADLINE_MS = 1500;

/**
 * Phase 5.2 §2.2 — the frozen view of the turn's inputs.
 *
 * Shallow and scalar, per `EVENTS.md` §3. Every field answers a question a
 * mod cannot answer any other way at this instant:
 *
 *   • `turnId` correlates this call with `turn.start` / `turn.payloadBuilt` /
 *     `turn.committed` (`EVENTS.md` §7.1).
 *   • `playerInput` is the turn's input AS THE PROMPT WILL SEE IT — after the
 *     dice/loot/one-shot injections `resolveEngineRolls` appends, which is
 *     the opposite of `turn.start`'s `playerInput` (raw). The two are
 *     different on purpose and both are documented as such.
 *   • the three `has…` flags say which built-ins are live this turn, so a mod
 *     can decide what to suppress without guessing. They are booleans, not
 *     the block text: publishing a prompt body on the surface is a
 *     `CONTRACT.md` permanent prohibition.
 *
 * Deep-frozen before it is handed over. A mod cannot mutate the host's view
 * of its own turn.
 */
export interface PromptInterceptorInput {
    /** The per-session correlation key (`EVENTS.md` §7.1). */
    readonly turnId: string;
    /** The active campaign, or `null` outside one. */
    readonly campaignId: string | null;
    /** The tier this turn runs at. `undefined` when unset. */
    readonly tier: string | undefined;
    /**
     * The player's input for this turn, post engine-roll injection — the
     * exact string the `user.message` contribution will render. Differs from
     * `turn.start`'s `playerInput`, which is the raw pre-injection text.
     */
    readonly playerInput: string;
    /** True when the Director produced a Brief for this turn. */
    readonly hasDirectorBrief: boolean;
    /** True when the deterministic watchdog nudge is armed this turn. */
    readonly hasWatchdogNudge: boolean;
    /** True when the player armed an Absolute Command for this turn. */
    readonly hasAbsoluteCommand: boolean;
}

/**
 * Phase 5.2 §2.3 — one block a mod contributes for this turn.
 *
 * The same shape a declarative `contributions[]` entry produces, minus the
 * parts a manifest needs and code does not (`when`, `suppresses`): a code
 * interceptor evaluates its own condition by simply not returning the block,
 * and states its suppressions once for the whole interception.
 */
export interface PromptContribution {
    /**
     * The bare contribution id. The host qualifies it to
     * `mod.<modId>.<id>` before it reaches the arbiter, so a mod can never
     * collide with — or impersonate — a built-in id, exactly as
     * `modAdapter.ts:modSpecId` does for the declarative path.
     */
    readonly id: string;
    /**
     * The rendered text. `''` means "inactive this turn" — the arbiter drops
     * it before suppression is computed, and an inactive contribution
     * suppresses nothing (`types.ts` `ContributionSpec.text`).
     *
     * Used VERBATIM. `{{slots}}` are not expanded here: an interceptor is
     * code and can compute what a macro would have expanded to. Macros stay
     * the declarative path's mechanism (Phase 5.1).
     */
    readonly text: string;
    /**
     * Sort key within the final user message; ascending. Built-ins are spaced
     * 100…800 (`builtins.ts`). Absent → `0`, which is the same default the
     * declarative path uses (`modAdapter.ts:toSpec`) and puts the block ahead
     * of the world-state block.
     */
    readonly order?: number;
    /**
     * Token ceiling. Absent → `DEFAULT_MOD_CONTRIBUTION_BUDGET`. A macro's
     * output is not exempt from a budget (Phase 5.1 §2.4) and neither is an
     * interceptor's: one mod must not eat the context window through a hook.
     */
    readonly budget?: number;
}

/**
 * Phase 5.2 §2.3 — what an interceptor may return.
 *
 * Additive and subtractive only. There is no field for editing an existing
 * block, replacing the player's message, or changing assembly order, and
 * adding one is a decision for a later phase with its own work order.
 *
 * Returning nothing (`undefined` / `void` / `null`) is the normal quiet path
 * — a mod that has nothing to say this turn says nothing, and costs the turn
 * one function call.
 */
export interface PromptInterception {
    /** Blocks to add to the final user message. */
    readonly contributions?: readonly PromptContribution[];
    /**
     * Built-in or mod contribution ids to remove from THIS turn's prompt.
     *
     * Anything except `PROTECTED_SUPPRESSION_IDS` is permitted, which is the
     * same rule the declarative `suppresses` field already follows
     * (`modLoader.js` rejects the protected four at load time; everything
     * else is used verbatim). Phase 5.3 publishes the narrower "suppressible"
     * list through `getContext()`; until then, a mod that names a live
     * built-in gets it, and a mod that names a protected one gets a fault.
     */
    readonly suppress?: readonly string[];
}

/** The value an interceptor may resolve to. Nothing is the quiet path. */
export type PromptInterceptorResult = PromptInterception | null | void;

/**
 * Phase 5.2 — the function `native.generateInterceptor` names.
 *
 * ONE argument, per `MANIFEST.md` §3.1's convention for everything the host
 * calls on a mod. May be sync or async; async is bounded by
 * `INTERCEPTOR_DEADLINE_MS`.
 */
export type PromptInterceptor = (
    input: PromptInterceptorInput,
) => PromptInterceptorResult | Promise<PromptInterceptorResult>;

/**
 * Phase 5.2 §3 — interceptor fault kinds. Uses the existing fault-store shape
 * (`{ modId, file, kind, reason }`), surfaced in Extensions beside the others.
 *
 *   • `threw`     — the interceptor threw or rejected.
 *   • `timeout`   — it did not settle within `INTERCEPTOR_DEADLINE_MS`.
 *   • `protected` — it tried to suppress a `PROTECTED_SUPPRESSION_IDS` id.
 *   • `invalid`   — it returned a malformed shape (bad id, non-string text,
 *                   duplicate id within one interception).
 *   • `revoked`   — the turn path reached an interceptor whose lease was
 *                   revoked (the mod was disabled mid-turn).
 */
export type InterceptorFaultKind = 'threw' | 'timeout' | 'protected' | 'invalid' | 'revoked' | 'suppressed';

/**
 * A narrow mod view the registry needs to attribute a registration. Mirrors
 * `MacroRegistryMod` / `MountRegistryMod`, plus the resolved load index that
 * decides run order (`MANIFEST.md` §6.3).
 */
export interface InterceptorRegistryMod {
    readonly id: string;
    readonly name: string;
    /**
     * The mod's position in the loader's resolved `mods[]` array. Lower runs
     * first. Default `0` — correct for a single-mod test; production supplies
     * the real index, the same way `MOUNTS.md` §3.1 does for mounts.
     */
    readonly loadIndex?: number;
    /** The fault-store file label. Default `mod:<id>`. */
    readonly file?: string;
}

/**
 * What the registry hands back to the turn stage: specs ready for the arbiter
 * and an attributed suppression list.
 *
 * The specs are fully-formed `ContributionSpec`s — qualified id, `final-user`
 * slot, `source: 'mod'`, budget stamped. `payloadBuilder` appends them to what
 * the contribution registry collected and passes the suppression list to the
 * arbiter; the payload layer therefore still never learns what a mod is, which
 * is the dependency direction `contributions/extensions.ts` establishes.
 *
 * Suppression carries its attributor (`by: 'mod.<modId>'`) so the assembled
 * diagnostics stay honest about who removed what — the same information
 * spec-declared suppression already reports.
 */
export interface PromptInterceptionResult {
    readonly specs: readonly ContributionSpec[];
    readonly suppress: readonly { readonly id: string; readonly by: string }[];
}
