/**
 * Phase 5.2 fixture — the pre-prompt / generation interceptor.
 *
 * Written against the shipped `docs/narrative-mod-api.d.ts` and
 * `docs/MODDING.md` only; no `src/` was read to write it. This is the mod a
 * modder's first interceptor should look like.
 *
 * What it demonstrates, one branch each:
 *
 *   1. ADDITIVE — a computed block that a static `contributions[]` entry could
 *      not produce, because its text depends on the turn (the turn id, and
 *      whether the Director spoke this turn).
 *   2. SUBTRACTIVE — it suppresses `gm.reminder`, but ONLY on turns where the
 *      Director produced a Brief. That conditionality is the whole reason the
 *      hook exists: `suppresses` in a manifest is either always on or always
 *      off.
 *   3. REJECTED — it also asks to suppress `user.message`, which is protected.
 *      The host drops that one with a reason in Extensions and honours the
 *      rest of the interception. This is here ON PURPOSE, as a fixture for the
 *      "attempting to touch a protected id is rejected with a reason"
 *      guarantee. A real mod would not do this.
 *   4. QUIET — on a turn where the player armed an Absolute Command, it
 *      returns nothing at all. A mod that has nothing to say says nothing.
 *
 * The interceptor is PURE with respect to host state: it reads the frozen
 * input it was handed and module-scope state its `activate` set up, and it
 * writes nothing. Writing during prompt assembly is not a supported thing to
 * do — the turn has not happened yet.
 */

/**
 * Live host state, kept current by a Phase 2.4 subscription rather than read
 * inside the interceptor.
 *
 * The interceptor gets ONE argument — the frozen view of the turn's inputs —
 * and no `ctx`. That is deliberate: building a fresh mod context per
 * interceptor per turn would clone the message list on the hot path.
 * The supported way to have live host state at interception time is the one
 * every other mod surface already uses — subscribe in `activate`, read the
 * closure in the hook.
 *
 * Phase 5.3 — `suppressibleIds` is read in `activate` (it is on `ctx.api`, not
 * on the interceptor's frozen input). The host publishes the set so a mod can
 * ask what it may suppress rather than guessing from a static document.
 */
let messageCount = 0;
let unsubscribe;
let suppressibleIds = [];

export function onActivate(ctx) {
    // A mod with no context (no active campaign yet at load) simply starts
    // with its defaults; the subscription is set up on the next activate.
    if (!ctx || typeof ctx.subscribe !== 'function') return;

    messageCount = ctx.data.messages.length;
    // Phase 5.3 — read the published suppressible set. A Megumin-class mod
    // that stands up a parallel director system uses this to decide which
    // built-in blocks it may turn off, rather than hard-coding the four ids
    // and silently breaking when the set grows.
    suppressibleIds = Array.isArray(ctx.api.suppressibleIds) ? [...ctx.api.suppressibleIds] : [];
    unsubscribe = ctx.subscribe('messages', (messages) => {
        messageCount = Array.isArray(messages) ? messages.length : 0;
    });
    ctx.log('interceptor fixture active; messages =', messageCount, 'suppressible =', suppressibleIds.join(','));
}

export function onDisable(ctx) {
    // Defensive only — the host disposes every subscription on disable and
    // removes the interceptor itself. Calling an unsubscribe twice is a no-op.
    if (typeof unsubscribe === 'function') unsubscribe();
    unsubscribe = undefined;
    if (ctx) ctx.log('interceptor fixture torn down');
}

/**
 * `native.generateInterceptor` — the pre-prompt hook.
 *
 * Fires once per turn, after the app knows every input the payload consumes
 * and before assembly begins. Must return within the host's deadline; may be
 * async, but should not be doing anything slow enough to need it.
 */
export function interceptPrompt(input) {
    // Branch 4 — the quiet path. Under an Absolute Command the player has
    // explicitly overridden the GM's standing instructions, and a mod piling
    // more directives on top of that is exactly the wrong reflex.
    if (input.hasAbsoluteCommand) return;

    const lines = [
        '[SCENE LEDGER]',
        `turn ${input.turnId} · ${messageCount} messages so far`,
    ];
    if (input.hasWatchdogNudge) {
        lines.push('the watchdog flagged NPC agency drift this turn — hold the line on it');
    }

    return {
        // Branch 1 — additive.
        contributions: [
            {
                id: 'scene-ledger',
                // 450: after the GM reminder (400), before the watchdog nudge
                // (500). Built-ins are spaced by 100 precisely so a mod can
                // slot between two of them without anything being renumbered.
                order: 450,
                budget: 120,
                text: lines.join('\n'),
            },
        ],
        suppress: [
            // Branch 2 — subtractive, and conditional on this turn. When the
            // Director has authored a Brief, the standing GM reminder is
            // redundant with it, so this mod drops the reminder. On a turn
            // with no Brief the reminder stays.
            //
            // Phase 5.3 — the target is checked against the published
            // `ctx.api.suppressibleIds` captured in `activate`. A mod that
            // reads the list rather than hard-coding the id keeps working
            // when the set grows or the id is reclassified.
            ...((input.hasDirectorBrief && suppressibleIds.includes('gm.reminder'))
                ? ['gm.reminder']
                : []),
            // Branch 3 — the deliberate rejection. `user.message` is
            // protected; the host refuses it with a reason and keeps
            // everything above. Do not copy this line into a real mod.
            'user.message',
        ],
    };
}
