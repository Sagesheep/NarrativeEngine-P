/**
 * Phase 5.2 — the pre-prompt / generation interceptor registry.
 *
 * The specification is `Upgrade/EPIC Project - Full Modularity/Phase 5.2 -
 * Pre-prompt generation interceptor - Frontier-high.md`. The contract types
 * and the five decisions live in `interceptorTypes.ts`; this module owns the
 * store, the run, the validation, and the fault containment.
 *
 * ┌─ THE FOUR LOAD-BEARING CONSTRAINTS (Phase 5.2 §3) ─────────────────────┐
 * │                                                                        │
 * │ 1. PROMPT CACHE STABILITY. Interceptor output is a `ContributionSpec`   │
 * │    with `slot: 'final-user'`, and `ContributionSlot` HAS no other       │
 * │    member (`contributions/types.ts`). The final user message sits below │
 * │    the Anthropic cache boundary, so an interceptor cannot move the      │
 * │    stable prefix — not by policy, by construction. Suppression is       │
 * │    likewise resolved inside the arbiter, which only ever sees           │
 * │    final-user specs. `payloadCacheStability.test.ts` stays green by     │
 * │    design, and Phase 5.2 asserts it explicitly with interceptors        │
 * │    registered and firing.                                              │
 * │                                                                        │
 * │ 2. THE PROTECTED IDS ARE NOT NEGOTIABLE. A suppression naming one of    │
 * │    `PROTECTED_SUPPRESSION_IDS` is dropped with a surfaced reason. A mod │
 * │    never deletes the player's own words. The rejection lives HERE and   │
 * │    not in the arbiter, because `assemble.ts` may never branch on which  │
 * │    contribution it is holding — the no-feature-names rule at the top of │
 * │    that file is the reason the contribution registry exists.            │
 * │                                                                        │
 * │ 3. DETERMINISM. Two identical turns with the same mods produce the same │
 * │    payload. Interceptors are collected in resolved load order (never in │
 * │    completion order), each mod's contributions keep their returned      │
 * │    order, and the arbiter's sort is stable. Concurrency is an execution │
 * │    detail that never reaches the output.                               │
 * │                                                                        │
 * │ 4. A FAILING INTERCEPTOR MUST NOT FAIL THE TURN. Every call is wrapped: │
 * │    a throw, a rejection, a deadline overrun, a malformed return, and a  │
 * │    mid-turn disable all produce a fault plus the un-intercepted result  │
 * │    for that mod. The other mods' interceptions still land.              │
 * └────────────────────────────────────────────────────────────────────────┘
 *
 * Teardown is host-owned, at the same `lifecycleHost.disable` call site that
 * already disposes subscriptions, event listeners, mounts and macros. The mod
 * is never trusted to unregister itself.
 */
import type { ContributionSpec } from '../../payload/contributions/types';
import { DEFAULT_MOD_CONTRIBUTION_BUDGET } from '../../payload/contributions/registry';
import { PROTECTED_SUPPRESSION_IDS } from '../modTypes';
import { interceptorFaultStore, formatInterceptorFaultReason } from './interceptorFaults';
import type {
    InterceptorRegistryMod,
    PromptContribution,
    PromptInterception,
    PromptInterceptionResult,
    PromptInterceptor,
    PromptInterceptorInput,
} from './interceptorTypes';
import { INTERCEPTOR_DEADLINE_MS } from './interceptorTypes';

/**
 * The id shape the loader already enforces for a declarative contribution
 * (`modLoader.js` `ID_REGEX`). Interceptor-returned ids follow the same rule
 * so `mod.<modId>.<id>` stays an unambiguous three-part name — a dot inside
 * the bare id would make the namespaced id ambiguous.
 */
const CONTRIBUTION_ID_REGEX = /^[a-zA-Z0-9_-]+$/;

/** The set form of the protected list, for O(1) rejection. */
const PROTECTED_IDS: ReadonlySet<string> = new Set(PROTECTED_SUPPRESSION_IDS);

interface RegisteredInterceptor {
    readonly modId: string;
    readonly modName: string;
    readonly file: string;
    readonly loadIndex: number;
    readonly fn: PromptInterceptor;
}

/** One interceptor per mod — the manifest carries exactly one name (`MANIFEST.md` §3). */
const byMod = new Map<string, RegisteredInterceptor>();

/** Mods whose lease has been revoked (disabled). A late result is discarded. */
const revokedMods = new Set<string>();

/** The namespaced spec id for an interceptor contribution. Mirrors `modAdapter.ts:modSpecId`. */
export function interceptorSpecId(modId: string, contributionId: string): string {
    return `mod.${modId}.${contributionId}`;
}

/**
 * Register a mod's `native.generateInterceptor`.
 *
 * Called by the lifecycle host after the mod's `activate` has run cleanly —
 * the same gate `native.css` mounting uses. Never throws: a re-registration
 * (a rescan while the mod is enabled) replaces the previous function, which
 * is what a re-imported module should do.
 */
export function registerModInterceptor(mod: InterceptorRegistryMod, fn: PromptInterceptor): void {
    if (typeof fn !== 'function') return;
    revokedMods.delete(mod.id);
    byMod.set(mod.id, {
        modId: mod.id,
        modName: mod.name,
        file: mod.file ?? `mod:${mod.id}`,
        loadIndex: typeof mod.loadIndex === 'number' && Number.isFinite(mod.loadIndex) ? mod.loadIndex : 0,
        fn,
    });
}

/**
 * Phase 5.2 — host-owned teardown. `disable` removes the mod's interceptor at
 * the same call site that already disposes subscriptions, event listeners,
 * mounts and macros. The lease is revoked so a call already in flight when
 * the user toggled the mod off has its result discarded rather than folded
 * into a payload the mod is no longer part of.
 *
 * Clears the mod's fault record too, so a re-enable starts clean in the
 * Extensions list (matches `mountFaultStore` / `macroFaultStore`).
 */
export function disableModInterceptors(modId: string): boolean {
    revokedMods.add(modId);
    const removed = byMod.delete(modId);
    interceptorFaultStore.clearMod(modId);
    return removed;
}

/** Allow a mod to register again after a re-enable. Mirrors `enableModMacros`. */
export function enableModInterceptors(modId: string): void {
    revokedMods.delete(modId);
}

/** `lifecycleHost.reset()` — clear ALL interceptors. Test/teardown only. */
export function clearAllModInterceptors(): void {
    byMod.clear();
    revokedMods.clear();
    interceptorFaultStore.clear();
}

/**
 * Whether any mod has registered an interceptor.
 *
 * The turn path calls this BEFORE awaiting anything, so a zero-interceptor
 * app pays not even a microtask — the same discipline `emitCoreEventLazy`
 * uses for the bus, and the reason the Phase 0.2 base-app gate stays
 * byte-identical rather than merely equivalent.
 */
export function hasPromptInterceptors(): boolean {
    return byMod.size > 0;
}

/** The registered mod ids in resolved run order. Diagnostics and tests. */
export function listPromptInterceptors(): readonly string[] {
    return orderedInterceptors().map((entry) => entry.modId);
}

/** Test helper: whether a mod's lease is revoked. */
export function isModInterceptorsRevoked(modId: string): boolean {
    return revokedMods.has(modId);
}

/**
 * Phase 5.2 §2.5 — run order. The loader's resolved load order, ties broken
 * on mod id ascending, which is what the loader already guarantees upstream
 * (`MOUNTS.md` §3.1's inheritance, verified in Phase 4.9.3 item 4). Sorted on
 * every run rather than kept sorted, because the map is tiny and a sort that
 * cannot go stale is worth more than the microseconds.
 */
function orderedInterceptors(): readonly RegisteredInterceptor[] {
    return [...byMod.values()].sort((a, b) =>
        a.loadIndex !== b.loadIndex ? a.loadIndex - b.loadIndex : a.modId.localeCompare(b.modId));
}

/**
 * Deep-freeze the input record. Shallow in practice (every field is a scalar)
 * but frozen explicitly so a mod that tries to stash and mutate it gets a
 * silent no-op in sloppy mode and a `TypeError` in strict — the same posture
 * the event bus takes with its payloads (`EVENTS.md` §3).
 */
function freezeInput(input: PromptInterceptorInput): PromptInterceptorInput {
    return Object.freeze({ ...input });
}

class InterceptorDeadlineError extends Error {
    constructor(deadlineMs: number) {
        super(`[interceptor] deadline exceeded (${deadlineMs} ms)`);
        this.name = 'InterceptorDeadlineError';
    }
}

/**
 * Run one interceptor under the deadline. Modelled on `lifecycleHost`'s
 * `runUnderDeadline`: `Promise.race` so a hanging interceptor's promise is
 * orphaned rather than awaited, and the host returns control regardless.
 */
function runUnderDeadline(
    fn: PromptInterceptor,
    input: PromptInterceptorInput,
    deadlineMs: number,
): Promise<PromptInterception | null | void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new InterceptorDeadlineError(deadlineMs)), deadlineMs);
    });
    // `Promise.resolve().then(...)` so a SYNCHRONOUS throw from the
    // interceptor becomes a rejection rather than escaping into the caller.
    const call = Promise.resolve().then(() => fn(input));
    return Promise.race([call, deadline]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

/**
 * Turn one mod's returned interception into specs plus attributed
 * suppressions, rejecting what the contract forbids.
 *
 * Total by construction: every rejection is a fault plus a dropped item, and
 * the rest of the mod's interception still lands. That is the same posture
 * `modAdapter.toSpec` takes with a hostile file shape.
 */
function projectInterception(
    entry: RegisteredInterceptor,
    interception: PromptInterception,
): PromptInterceptionResult {
    const specs: ContributionSpec[] = [];
    const suppress: { id: string; by: string }[] = [];

    const fault = (kind: 'invalid' | 'protected', id: string | undefined, message?: string): void => {
        interceptorFaultStore.add({
            modId: entry.modId,
            file: entry.file,
            kind,
            id,
            reason: formatInterceptorFaultReason({ modName: entry.modName, kind, id, message }),
        });
    };

    const rawContributions = Array.isArray(interception.contributions) ? interception.contributions : [];
    const seen = new Set<string>();
    for (const raw of rawContributions as readonly PromptContribution[]) {
        if (raw === null || typeof raw !== 'object') {
            fault('invalid', undefined, 'not an object');
            continue;
        }
        const id = (raw as { id?: unknown }).id;
        if (typeof id !== 'string' || !CONTRIBUTION_ID_REGEX.test(id)) {
            fault('invalid', typeof id === 'string' ? id : undefined,
                'id must contain only letters, digits, "_" and "-"');
            continue;
        }
        if (seen.has(id)) {
            // Do not silently first-win a duplicate: name it, the way
            // `MANIFEST.md` §6.1's duplicate-id voice does. The first one is
            // kept, because dropping both would lose a block the author
            // certainly meant to send.
            fault('invalid', id, 'returned twice in one interception');
            continue;
        }
        const text = (raw as { text?: unknown }).text;
        if (typeof text !== 'string') {
            fault('invalid', id, 'text must be a string');
            continue;
        }
        seen.add(id);

        const order = (raw as { order?: unknown }).order;
        const budget = (raw as { budget?: unknown }).budget;
        specs.push({
            id: interceptorSpecId(entry.modId, id),
            slot: 'final-user',
            order: typeof order === 'number' && Number.isFinite(order) ? order : 0,
            text,
            source: 'mod',
            // Stamp the default here rather than relying on the contribution
            // registry: these specs bypass `registry.collect` (they are
            // per-turn, not per-module), and an unbounded third-party block
            // appended to the final user message is exactly what the arbiter's
            // budget exists to prevent.
            budget: typeof budget === 'number' && Number.isFinite(budget) && budget >= 0
                ? budget
                : DEFAULT_MOD_CONTRIBUTION_BUDGET,
            trace: {
                source: entry.modName,
                classification: 'world_context',
                reason: `Prompt interceptor contribution "${id}" from ${entry.modName}`,
            },
        });
    }

    const rawSuppress = Array.isArray(interception.suppress) ? interception.suppress : [];
    const seenSuppress = new Set<string>();
    for (const victimId of rawSuppress) {
        if (typeof victimId !== 'string' || victimId === '') {
            fault('invalid', undefined, 'suppress must contain only non-empty contribution ids');
            continue;
        }
        if (PROTECTED_IDS.has(victimId)) {
            // The one rule that is absolute. Rejected with a reason; the rest
            // of the interception still lands (Phase 5.2 §3).
            fault('protected', victimId);
            continue;
        }
        if (seenSuppress.has(victimId)) continue;
        seenSuppress.add(victimId);
        suppress.push({ id: victimId, by: `mod.${entry.modId}` });
    }

    return { specs, suppress };
}

/**
 * Phase 5.2 §2.1 — the hook. Runs every registered interceptor for this turn
 * and returns what the payload builder should fold in.
 *
 * Execution is CONCURRENT; collection is ORDERED. The two are independent and
 * both matter:
 *
 *   • Concurrent, so the stage's wall time is bounded by the slowest single
 *     interceptor (≤ `INTERCEPTOR_DEADLINE_MS`) rather than by the sum. Five
 *     broken mods cost one deadline, not five. Interceptors may not write, so
 *     there is nothing for concurrency to interleave badly.
 *   • Ordered, so two identical turns produce the same payload regardless of
 *     which interceptor happened to resolve first. Results are re-assembled
 *     from the sorted entry list, never from completion order.
 *
 * Returns `undefined` when there is nothing to fold in — the caller then
 * passes no `interception` option to `buildPayload` at all, which is what
 * keeps the zero-mod payload byte-identical.
 */
export async function runPromptInterceptors(
    rawInput: PromptInterceptorInput,
    options: { readonly deadlineMs?: number } = {},
): Promise<PromptInterceptionResult | undefined> {
    const entries = orderedInterceptors();
    if (entries.length === 0) return undefined;

    const deadlineMs = options.deadlineMs ?? INTERCEPTOR_DEADLINE_MS;
    const input = freezeInput(rawInput);

    const settled = await Promise.all(entries.map(async (entry) => {
        try {
            const result = await runUnderDeadline(entry.fn, input, deadlineMs);
            return { entry, result, error: undefined as unknown };
        } catch (error) {
            return { entry, result: undefined, error };
        }
    }));

    const specs: ContributionSpec[] = [];
    const suppress: { id: string; by: string }[] = [];

    for (const { entry, result, error } of settled) {
        // A mod disabled while its interceptor was in flight does not get to
        // contribute to the payload of the turn it was removed during.
        if (revokedMods.has(entry.modId)) {
            interceptorFaultStore.add({
                modId: entry.modId,
                file: entry.file,
                kind: 'revoked',
                reason: formatInterceptorFaultReason({ modName: entry.modName, kind: 'revoked' }),
            });
            continue;
        }

        if (error !== undefined) {
            const timedOut = error instanceof Error && error.name === 'InterceptorDeadlineError';
            interceptorFaultStore.add({
                modId: entry.modId,
                file: entry.file,
                kind: timedOut ? 'timeout' : 'threw',
                reason: formatInterceptorFaultReason({
                    modName: entry.modName,
                    kind: timedOut ? 'timeout' : 'threw',
                    message: error instanceof Error ? error.message : String(error),
                    deadlineMs,
                }),
            });
            continue;
        }

        // The quiet path: a mod with nothing to say this turn.
        if (result === null || result === undefined) continue;
        if (typeof result !== 'object') {
            interceptorFaultStore.add({
                modId: entry.modId,
                file: entry.file,
                kind: 'invalid',
                reason: formatInterceptorFaultReason({
                    modName: entry.modName,
                    kind: 'invalid',
                    message: `returned ${typeof result}, expected an object or nothing`,
                }),
            });
            continue;
        }

        const projected = projectInterception(entry, result);
        specs.push(...projected.specs);
        suppress.push(...projected.suppress);
    }

    if (specs.length === 0 && suppress.length === 0) return undefined;
    return { specs, suppress };
}
