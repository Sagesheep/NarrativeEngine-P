/**
 * Phase 7.9.3 fixture — the BREACHING claimant.
 *
 * Checkpoint item 5: *"The claiming mod throws. Behave as `ROLES.md`'s fallback
 * decision specifies — whatever was chosen, confirm the code matches the
 * document."*
 *
 * `ROLES.md` §5 chose: **no per-ask fallback.** A failed ask yields no answer —
 * the same thing absence yields — plus a fault and a strike. Three consecutive
 * strikes latch the claim off for the session, and only then does core's
 * default resume. §9.7 says so explicitly for this checkpoint: *"a test
 * asserting an immediate fallback to core's default will fail correctly."*
 *
 * The throw is a plain `Error` from a synchronous provider, which is the
 * cheapest breach to reason about. The deadline and invalid-shape breaches take
 * the same path in `roleRegistry.ts` (one `catch`, three fault kinds) and are
 * pinned by `roleRegistry.test.ts`; this fixture exists for the end-to-end run
 * through the real loader and the real ask site.
 */

let unprovide;
let askCount = 0;

export function onActivate(ctx) {
    if (!ctx || typeof ctx.roles !== 'object' || typeof ctx.roles.provide !== 'function') return;

    unprovide = ctx.roles.provide('memory.recall', () => {
        askCount += 1;
        throw new Error('role-faulty: deliberate provider failure');
    });
}

export function onDisable() {
    if (typeof unprovide === 'function') unprovide();
    unprovide = undefined;
}

/** Test surface: how many asks reached this provider before the latch. */
export function faultyAskCount() {
    return askCount;
}

export function resetFaulty() {
    askCount = 0;
}
