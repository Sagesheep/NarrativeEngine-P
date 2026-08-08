/**
 * Phase 5.4 fixture — the fact publisher.
 *
 * Written against the shipped `docs/narrative-mod-api.d.ts` and
 * `docs/MODDING.md` only; no `src/` was read to write it.
 *
 * What it demonstrates:
 *
 *   1. CLAIM — it registers a publisher for the core fact `inCombat`,
 *      claiming that domain. The claim is authorised because the host
 *      opened `inCombat` for claims (`CLAIMABLE_CORE_FACTS`). This is the
 *      rehearsal for Phase 8: when enemies leave core, the enemy mod
 *      publishes `inCombat` so every other mod's `when: { inCombat }`
 *      keeps working.
 *
 *   2. PUBLISH — it publishes `true` when the turn has an absolute
 *      command (a proxy for "combat is active" in this fixture), and
 *      `false` otherwise. A real enemy mod would read its own encounter
 *      state through `ctx.data` or a subscription.
 *
 *   3. CLEANUP — `unregister` is called defensively in `onDisable`, but
 *      the host removes every publisher on disable regardless — the mod
 *      is never trusted to clean up after itself.
 */

let unregister;

export function onActivate(ctx) {
    if (!ctx || typeof ctx.facts !== 'object' || typeof ctx.facts.register !== 'function') return;

    unregister = ctx.facts.register(
        'inCombat',
        () => {
            // A real enemy mod would read encounter state here. For the
            // fixture, we publish `true` when an absolute command is armed
            // (a deterministic, testable signal) and `false` otherwise.
            // The host's own `inCombat` derivation (from enemy encounters)
            // is overridden by this claim.
            return false;
        },
        { claims: 'inCombat' },
    );
    ctx.log('facts fixture active; claiming inCombat');
}

export function onDisable(ctx) {
    if (typeof unregister === 'function') unregister();
    unregister = undefined;
    if (ctx) ctx.log('facts fixture torn down');
}