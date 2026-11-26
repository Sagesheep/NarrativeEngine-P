/**
 * Phase 7.4 — the budget claim registry.
 *
 * `computeBudgets` (`budgets.ts`) used to allocate token budgets by feature
 * name, hardcoded in one function. That made `payloadBuilder` know every
 * feature by name, which is exactly the god-node shape the previous epic
 * fought for prompt text and the contribution registry fixed. This file is the
 * same cure applied to budgets.
 *
 * A budget is claimed by id, not hardcoded. Core's four **structural** claims
 * register at module load below (the same numbers `computeBudgets` used); a
 * subsystem claims its own beside its renderer (Phase 7.5); mods claim through
 * `ctx.budgets.claim`. The registry is name-blind — it never branches on which
 * id it is holding. It holds allocation functions; the budget map is the
 * result of running them all.
 *
 * Mirrors `tierBlockRegistry.ts` (Phase 7.3) and `contributions/registry.ts`
 * (Project 2): the same generic-store shape, the same "default-as-plugin"
 * principle. Built-ins register first; subsystems and mods register through
 * their own entry points; the consumer walks one list.
 *
 * **Phase 7.5 moved the one feature-named claim out.** The four that remain —
 * `stable`, `world`, `volatile`, `npc` — are parts of the prompt's structure,
 * not features that can leave: every campaign has a preamble, a world block,
 * volatile state and an NPC floor whether or not any subsystem is installed.
 * A claim named after something that *can* leave belongs with the thing that
 * leaves, so the one such claim now registers from the subsystem that owns it,
 * next to the renderer that spends it.
 *
 * **Byte-identical with zero mods.** Every claim reproduces the exact numbers
 * `computeBudgets` produced — same formulae, same inputs, same floor/ceiling
 * behaviour — and `budgetByteIdentical.test.ts` is the proof at 8k / 32k / 128k.
 */

/**
 * The inputs every allocation function receives. Exactly the three values
 * `computeBudgets` used to compute the five built-in budgets from:
 *
 *   - `limit` — `settings.contextLimit`, the provider's context window.
 *   - `remainingAfterRules` — `limit - rulesBudget`, where `rulesBudget` is
 *     `floor(limit * (rulesBudgetPct ?? 0.10))`.
 *   - `hasDeepContext` — whether a deep-context summary is present; the
 *     stable/world split differs between the shallow and deep shapes.
 *
 * A claim that needs none of these (e.g. a mod claiming a fixed 200 tokens)
 * ignores the argument entirely. A claim that wants to scale with the
 * provider window uses `limit` or `remainingAfterRules` exactly as the
 * built-ins do.
 */
export interface BudgetAllocationContext {
    readonly limit: number;
    readonly remainingAfterRules: number;
    readonly hasDeepContext: boolean;
}

/**
 * One claimed budget.
 *
 * `allocate` is a pure function of the allocation context. It MUST NOT read
 * app state, the store, or the facade — the registry calls it during
 * `buildPayload`, and the same determinism that keeps the cache prefix stable
 * applies here. Built-in claims close over constants; mod claims close over
 * the numbers their manifest declared.
 */
export interface BudgetClaim {
    /** Stable unique id. Core: `stable`, `world`, `volatile`, `npc`. Mods: `mod.<modId>.<name>`. */
    readonly id: string;
    /** Provenance. `builtin` for the five core claims; `mod` for everything else. */
    readonly source: 'builtin' | 'mod';
    /** Which mod declared this claim. Present on mod claims; absent on built-ins. */
    readonly modId?: string;
    /** Display name for the block view / extensions screen. */
    readonly name: string;
    /** One-line description for the extensions screen. */
    readonly description: string;
    /** Pure function of the allocation context. Returns the token count this claim reserves. */
    readonly allocate: (ctx: BudgetAllocationContext) => number;
}

/**
 * The result of running every registered claim. The budget map is keyed by
 * claim id; `rulesBudget` is separate (it is taken off the top before any
 * claim runs, and has always been computed separately from the feature
 * budgets). `get(id)` returns `0` for an unregistered id, which is the
 * "absent means no allocation" contract — exactly what Phase 7.5's "absence
 * must be quiet" requires. A subsystem that leaves takes its claim with it and
 * the read that resolved it silently returns zero; a segment handed a zero
 * budget renders nothing (`volatileSegments.ts`), so one unregistration is the
 * whole of the removal.
 */
export interface BudgetMap {
    /** The rules budget, taken off the top before any claim runs. Unchanged. */
    readonly rulesBudget: number;
    /** Per-claim allocations. Core: `stable`, `world`, `volatile`, `npc`. Mods: `mod.<id>.<name>`. */
    readonly get: (id: string) => number;
    /** Every claim id that returned a non-zero allocation, in registration order. Diagnostics only. */
    readonly claimedIds: readonly string[];
}

export interface BudgetClaimRegistry {
    /** Register a claim. Throws on duplicate id — always a packaging bug. */
    register(claim: BudgetClaim): void;
    /** Remove a claim by id. Returns whether it was present. */
    unregister(id: string): boolean;
    /** Remove every claim declared by `modId`. Used on mod disable/uninstall. */
    unregisterMod(modId: string): void;
    /** All registered claims, in registration order. For the block view. */
    list(): readonly BudgetClaim[];
    /** Look up a single claim by id. */
    get(id: string): BudgetClaim | undefined;
    /**
     * Compute the budget map. Runs every registered claim's `allocate`
     * function against the same allocation context, in registration order,
     * and returns a `BudgetMap` that exposes them by id. Pure: given the same
     * registry state and the same inputs, the same map.
     */
    compute(limit: number, rulesBudgetPct: number | undefined, hasDeepContext: boolean): BudgetMap;
    /** Drop all claims. Test/teardown only. */
    clear(): void;
}

export function createBudgetClaimRegistry(): BudgetClaimRegistry {
    const claims = new Map<string, BudgetClaim>();
    const order: string[] = [];

    return {
        register(claim) {
            if (claims.has(claim.id)) {
                throw new Error(`[budgets] duplicate claim id: ${claim.id}`);
            }
            claims.set(claim.id, claim);
            order.push(claim.id);
        },

        unregister(id) {
            const removed = claims.delete(id);
            if (removed) {
                const idx = order.indexOf(id);
                if (idx >= 0) order.splice(idx, 1);
            }
            return removed;
        },

        unregisterMod(modId) {
            for (const id of [...order]) {
                if (claims.get(id)?.modId === modId) {
                    claims.delete(id);
                    const idx = order.indexOf(id);
                    if (idx >= 0) order.splice(idx, 1);
                }
            }
        },

        list() {
            return order.map((id) => claims.get(id)!);
        },

        get(id) {
            return claims.get(id);
        },

        compute(limit, rulesBudgetPct, hasDeepContext) {
            const rulesBudget = Math.floor(limit * (rulesBudgetPct ?? 0.10));
            const remainingAfterRules = limit - rulesBudget;
            const ctx: BudgetAllocationContext = { limit, remainingAfterRules, hasDeepContext };
            const allocations = new Map<string, number>();
            const claimedIds: string[] = [];
            for (const id of order) {
                const claim = claims.get(id)!;
                let amount: number;
                try {
                    amount = claim.allocate(ctx);
                } catch {
                    // A throwing claim is treated as zero — absence is quiet
                    // (Phase 7.5 §3). The trim logic downstream handles a
                    // zero budget by dropping the block, which is the right
                    // default for a misbehaving claim. Built-ins never throw
                    // (they close over constants); this is the mod path's
                    // belt-and-braces.
                    amount = 0;
                }
                if (!Number.isFinite(amount) || amount < 0) amount = 0;
                amount = Math.floor(amount);
                allocations.set(id, amount);
                if (amount > 0) claimedIds.push(id);
            }
            return {
                rulesBudget,
                get: (id: string) => allocations.get(id) ?? 0,
                claimedIds,
            };
        },

        clear() {
            claims.clear();
            order.length = 0;
        },
    };
}

/**
 * The module-level singleton, mirroring `postTurnTracks` (`tracks/index.ts`)
 * and `modTierBlocks` (`aiTier.ts`). Built-in claims register here at module
 * load (see `registerBuiltinClaims`); mod claims register here through the
 * bootstrap (`modBootstrap.ts` → `registerBudgetClaims` via
 * `budgetRegistry.ts`).
 */
export const budgetClaims = createBudgetClaimRegistry();

// ── Core structural claims ───────────────────────────────────────────────────
//
// The four claims below reproduce the EXACT formulae the old `computeBudgets`
// used — same numbers, same proportions, same floor/ceiling behaviour.
// `budgetByteIdentical.test.ts` (8k / 32k / 128k) is the proof. Each claim
// closes over constants only; the allocation functions are pure.
//
// These four are structural: the preamble, the world block, volatile state and
// the NPC floor exist in every campaign regardless of which subsystems are
// installed. Anything that can be uninstalled claims its budget from its own
// module instead, so uninstalling it removes the claim with it (Phase 7.5).
//
// Registration happens once at module load. The guard keeps `vi.resetModules()`
// in tests from double-registering on re-import. `clear()` on the registry
// (test/teardown only) wipes built-ins too; `ensureBuiltinClaims()` re-runs
// the next time a budget is computed, so a test that calls `clear()` and
// then `compute()` gets the built-ins back. This is the same discipline
// `tracks/index.ts` uses for built-in tracks.

let builtinRegistered = false;

/**
 * Register the four core structural budget claims exactly once. Idempotent —
 * calling it twice is a no-op. Called at module load and after a `clear()`
 * in `computeBudgets` so they always survive a test teardown.
 *
 * Detects a cleared registry (test teardown called `clear()`): if the flag
 * says "registered" but the registry has none of them, re-registers. This
 * keeps them alive across `vi.resetModules()` cycles AND across `clear()`
 * calls in the same module instance.
 *
 * The unregister sweep below touches ONLY the four ids this function owns. It
 * must never name a claim registered elsewhere: doing so would silently drop a
 * subsystem's or a mod's claim every time a test cleared the registry, and the
 * symptom (a block that renders at a zero budget) would look like a trimming
 * bug rather than a registration one.
 */
export function ensureBuiltinClaims(): void {
    if (builtinRegistered && budgetClaims.get('stable') !== undefined) return;
    builtinRegistered = true;
    // If they are already registered (e.g. double import), the `register` call
    // below would throw. Guard by unregistering first.
    for (const id of ['stable', 'world', 'volatile', 'npc']) {
        if (budgetClaims.get(id) !== undefined) budgetClaims.unregister(id);
    }
    budgetClaims.register({
        id: 'stable',
        source: 'builtin',
        name: 'Stable preamble',
        description: 'Rules, canon state, header index, starter prompt, and the writer reasoning framework. Cacheable; trimmed only as a warning.',
        allocate: ({ remainingAfterRules, hasDeepContext }) =>
            Math.floor(remainingAfterRules * (hasDeepContext ? 0.15 : 0.25)),
    });
    budgetClaims.register({
        id: 'world',
        source: 'builtin',
        name: 'World context',
        description: 'Archive recall, lore chunks, semantic facts, timeline events, divergence register, and the on-stage NPC block.',
        allocate: ({ remainingAfterRules, hasDeepContext }) => {
            const npc = Math.floor(remainingAfterRules * 0.05);
            return Math.floor(remainingAfterRules * (hasDeepContext ? 0.60 : 0.40)) - npc;
        },
    });
    budgetClaims.register({
        id: 'volatile',
        source: 'builtin',
        name: 'Volatile state',
        description: 'Location, scene note, profile, inventory, and the scene notebook. Below the cache boundary.',
        allocate: ({ remainingAfterRules }) =>
            Math.floor(remainingAfterRules * 0.10),
    });
    budgetClaims.register({
        id: 'npc',
        source: 'builtin',
        name: 'NPC floor',
        description: 'Guaranteed slice for the [ACTIVE NPC CONTEXT] block, decoupled from the world budget.',
        allocate: ({ remainingAfterRules }) =>
            Math.floor(remainingAfterRules * 0.05),
    });
}
ensureBuiltinClaims();