import type { PayloadTrace } from '../../../types';

/**
 * Project 2 / WO-P2-01 — the contribution contract.
 *
 * A `ContributionSpec` is the ONE object every prompt contributor produces, whether it is a
 * built-in system (Director Brief, watchdog, GM_REMINDER, …) or a user-installed mod file.
 * The arbiter in `assemble.ts` consumes only this shape — it never sees `AppSettings`,
 * `BuildPayloadOptions`, a mod file, or any feature-specific type.
 *
 * That indirection is deliberate and load-bearing:
 *   - today, a factory turns `BuildPayloadOptions` into specs (built-ins);
 *   - later, a loader can turn a mod file into specs;
 *   - later still, a code-mod layer could return specs directly.
 * All three plug into the same socket, and nothing downstream changes.
 */

/**
 * Where a contribution lands in the assembled prompt.
 *
 * v1 supports exactly one slot: `final-user` — the final user message, which sits BELOW the
 * Anthropic prompt-cache boundary. This is intentional. Contributions to the cached prefix
 * (`stable`) would invalidate the cache whenever a module is toggled, and the cache-assembly
 * block in `payloadBuilder.ts` is required to stay byte-identical (guarded by
 * `payloadCacheStability.test.ts`). A `stable` slot is a deliberate future decision, not an
 * oversight — see `Project 2 - Additive Moddability/00_PLAN.md` §4.
 */
export type ContributionSlot = 'final-user';

/**
 * Debug-trace metadata a contribution may declare. The arbiter derives `tokens`, `preview`,
 * `included` and `position` itself, so a contributor states only the three things it actually
 * knows. Omit entirely to emit no trace (correct for contributions whose constituent parts
 * already trace themselves, e.g. the composite volatile block).
 */
export interface ContributionTraceMeta {
    /** Human-readable origin shown in the debug panel, e.g. `'Director'`. */
    source: string;
    /** Reuses the existing payload-trace taxonomy. */
    classification: PayloadTrace['classification'];
    /** Why this block is in the prompt. */
    reason: string;
}

/**
 * One rendered contribution, ready for assembly.
 */
export interface ContributionSpec {
    /**
     * Stable unique identifier, dot-namespaced: `director.brief`, `mod.grimdark.tone`.
     * Referenced by `suppresses`, so renaming an id is a breaking change for anything
     * that suppresses it.
     */
    id: string;

    /** Slot this contribution targets. */
    slot: ContributionSlot;

    /**
     * Sort key within the slot; ascending. Built-ins use spaced values (100, 200, …) so mods
     * can slot between them without renumbering. Ties keep declaration order (stable sort).
     */
    order: number;

    /**
     * The rendered text. An empty string means "inactive this turn" — the contribution is
     * dropped before suppression is computed, so an inactive contribution suppresses nothing.
     */
    text: string;

    /** Provenance. Used by the UI and to decide whether a budget is mandatory. */
    source: 'builtin' | 'mod';

    /**
     * Maximum tokens this contribution may occupy. `undefined` means unbounded.
     *
     * Unbounded is the honest default for built-ins: today the directive blocks (Director
     * Brief, watchdog, Absolute Command) have NO ceiling — `computeBudgets` allocates only
     * stable/world/volatile/npc/enemy. Leaving built-ins unbounded is what keeps the
     * migration byte-identical. Mod-authored contributions are required to declare a budget
     * (enforced at load time, not here).
     */
    budget?: number;

    /**
     * Ids this contribution removes from the prompt when it is active.
     *
     * Makes precedence data instead of open-coded conditionals. Encodes today's rules:
     * Absolute Command suppresses GM_REMINDER and the watchdog nudge; the Director Brief
     * supersedes the watchdog nudge.
     *
     * SEMANTICS — single pass, no cascade: suppression is computed once from the set of
     * contributions that rendered non-empty text. A contribution that is itself suppressed
     * still exerts its own suppression. This is deterministic, cycle-free, and matches
     * current behaviour exactly (today no suppressor is ever itself suppressed). Documented
     * rather than made cleverer, because cascade resolution can oscillate and nothing needs it.
     */
    suppresses?: readonly string[];

    /** Optional debug-trace metadata; omit to emit no trace. */
    trace?: ContributionTraceMeta;
}

/** What the arbiter returns. */
export interface AssembledContributions {
    /** Contributions joined with a blank line, in `order`. */
    text: string;
    /** Traces for included contributions that declared trace metadata, in `order`. */
    traces: PayloadTrace[];
    /** Ids included, in final order. Diagnostics only. */
    included: string[];
    /** Contributions removed by suppression, with the id that removed them. Diagnostics only. */
    suppressed: { id: string; by: string }[];
    /** Contributions trimmed to fit their budget. Diagnostics only. */
    trimmed: { id: string; fromTokens: number; toTokens: number }[];
}
