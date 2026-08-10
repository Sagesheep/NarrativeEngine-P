/**
 * Phase 7.9.3 fixture — the LOSING claimant.
 *
 * Checkpoint item 4: *"Two mods claim the same role. Load order decides (6.2),
 * the loser is not run."* That second clause is the one worth engineering for.
 * `activeProviderFor()` returning the winner proves who WOULD answer; it does
 * not prove the loser stayed still. So this provider counts every call it
 * receives, and the checkpoint asserts the count is zero across a real ask
 * through the real ask site.
 *
 * Its answer is deliberately distinguishable from both core's ranking and
 * `role-claimant`'s reversal: the FIRST index entry only. If arbitration ever
 * inverts, the fetched ids say so immediately rather than the test passing on a
 * coincidence.
 */

let unprovide;
let askCount = 0;

export function onActivate(ctx) {
    if (!ctx || typeof ctx.roles !== 'object' || typeof ctx.roles.provide !== 'function') return;

    unprovide = ctx.roles.provide('memory.recall', (input) => {
        askCount += 1;
        const index = Array.isArray(input?.archiveIndex) ? input.archiveIndex : [];
        const first = index.map((entry) => entry.sceneId).filter((id) => typeof id === 'string')[0];
        return { sceneIds: first ? [first] : [] };
    });
}

export function onDisable() {
    if (typeof unprovide === 'function') unprovide();
    unprovide = undefined;
}

/** Test surface: how many times this provider was actually asked. */
export function rivalAskCount() {
    return askCount;
}

export function resetRival() {
    askCount = 0;
}
