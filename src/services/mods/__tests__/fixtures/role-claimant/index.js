/**
 * Phase 7.1.1 fixture — the service-role claimant.
 *
 * `ROLES.md` §10 is the worked example this file implements; the work order's
 * done-when item 1 asks for a mod that "declares `roles`, provides it from
 * `activate`, and its answer — not core's — reaches the payload."
 *
 * What it demonstrates:
 *
 *   1. DECLARE — `manifest.json` carries `"roles": ["memory.recall"]`. The
 *      declaration is what Mod Management can show before the mod is ever
 *      enabled (`ROLES.md` §3.2); a `provide()` without it is rejected.
 *
 *   2. PROVIDE — `activate` calls `ctx.roles.provide('memory.recall', ask)`.
 *      Native tier only: providing a role needs a closure that survives across
 *      asks, and a closure needs a module.
 *
 *   3. ANSWER — ids only, never scenes (`ROLES.md` §6.1). The host fetches the
 *      prose, applies the exclusions, the token budget and the pinned chapters.
 *      This provider returns the archive index in REVERSE order, capped at two:
 *      deterministic, and impossible to confuse with core's relevance ranking,
 *      which is what makes "the mod's answer, not core's" observable.
 *
 *   4. CLEANUP — `onDisable` calls the returned unregister defensively. The
 *      host revokes the lease on disable regardless; a mod is never trusted to
 *      clean up after itself.
 */

const MAX_SCENES = 2;

let unprovide;

export function onActivate(ctx) {
    if (!ctx || typeof ctx.roles !== 'object' || typeof ctx.roles.provide !== 'function') return;

    unprovide = ctx.roles.provide('memory.recall', (input) => {
        const index = Array.isArray(input?.archiveIndex) ? input.archiveIndex : [];
        const sceneIds = index
            .map((entry) => entry.sceneId)
            .filter((sceneId) => typeof sceneId === 'string')
            .reverse()
            .slice(0, MAX_SCENES);
        return { sceneIds };
    });

    if (typeof ctx.log === 'function') ctx.log('role fixture active; providing memory.recall');
}

export function onDisable(ctx) {
    if (typeof unprovide === 'function') unprovide();
    unprovide = undefined;
    if (ctx && typeof ctx.log === 'function') ctx.log('role fixture torn down');
}
