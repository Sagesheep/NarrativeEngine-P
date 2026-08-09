/**
 * Phase 1.4 — the lifecycle hook host.
 *
 * Owns the seven hooks from MANIFEST.md §3.1: `install`, `update`,
 * `activate`, `enable`, `disable`, `delete`, `clean`. The host:
 *
 *   • runs `install`/`update`/`activate` at app load, in the loader's
 *     resolved order (Phase 1.3 §6.3), for each ENABLED mod;
 *   • runs `enable` (followed by `activate`) and `disable` on user toggle;
 *   • runs `delete` before a folder is removed from within the app;
 *   • runs `clean` only on an explicit user action with confirmation
 *     (Phase 6.4 decides WHEN that action is offered; this phase provides the
 *     seam only — Phase 1.4 §5 stop condition);
 *   • contains a throwing or never-resolving hook as a surfaced fault, the
 *     way `sandboxFaults.ts` contains a compute fault (Phase 1.4 §3);
 *   • awaits every hook under a 5s timeout, so a hanging hook cannot hang
 *     the app (§3). Async hooks are awaited, never fire-and-forget —
 *     otherwise `install` would race `activate` (§3);
 *   • skips a mod whose dependency is disabled, with its own fault kind,
 *     distinct from a load rejection (MANIFEST.md §6.4: "Whether a
 *     dependency is enabled is runtime state, not load state");
 *   • latches a mod's hooks off for the rest of the session after 3
 *     consecutive faulted runs, mirroring `SANDBOX_FAULT_STRIKES`.
 *
 * The seam to Phase 1.5 is `LoadModHooks`: the host never imports mod code.
 * 1.5 supplies a function that `import()`s the manifest's `native.js` and
 * resolves the named exports; the host only fires them. A mod with no
 * `native` block yields `undefined` from the loader and the host skips it —
 * existing mods (which declare no hooks) behave identically (§4 done-when).
 *
 * The seam to Phase 2.2 is `ModContext`: the host carries whatever the
 * caller supplies through to each hook. The shape is deliberately not this
 * phase's to decide (MANIFEST.md §10).
 */
import type {
    HookRunResult,
    LifecycleFaultKind,
    LifecycleFaultStore,
    LoadCycleResult,
    LoadModHooks,
    ModContext,
    ModContextFactory,
    ModEnablementMap,
    ModSeenRecord,
    NativeHookFn,
    NativeModHooks,
    LifecycleStateStore,
} from './lifecycleTypes';
import {
    formatLifecycleFaultReason,
    LIFECYCLE_DEADLINE_MS,
    LIFECYCLE_FAULT_STRIKES,
} from './lifecycleFaults';
import type { NativeLoader, NativeMissingExportError } from '../native/nativeLoader';
import { disposeAllModSubscriptions, disposeModSubscriptions } from '../reactiveReads';
import { eventFaultStore, modEventBus } from '../events';
import { disableModMounts, enableModMounts, clearAllModMounts } from '../mounts/mountRegistry';
import { disableModMacros, enableModMacros, clearAllModMacros } from '../macros/macroRegistry';
import { disableModFacts, enableModFacts, clearAllModFacts } from '../facts/factRegistry';
import {
    clearAllModInterceptors,
    disableModInterceptors,
    enableModInterceptors,
    registerModInterceptor,
} from '../interceptors';
import { checkModRoles, clearAllModRoleLeases, disableModRoles, enableModRoles, serviceRoles } from '../../roles';

/** A mod, as the host needs to see it. A narrow read-only view of `ValidatedMod`. */
export interface LifecycleMod {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly file: string;
    readonly dependencies: Record<string, string>;
    readonly native?: {
        readonly js: string;
        readonly css?: string;
        readonly hooks?: Record<string, string>;
        /**
         * Phase 5.2 / MANIFEST.md §3 — the name of the exported function the
         * pre-prompt interceptor calls. Resolved by the native loader after a
         * clean `activate` and registered with the interceptor registry.
         */
        readonly generateInterceptor?: string;
    };
    /**
     * Phase 1.5 / MANIFEST.md §6.6 — the mod's folder name, so the native
     * loader can build the asset URL that the browser `import()`s. Required
     * for any mod with a `native` block; optional for declarative-only mods.
     */
    readonly folder?: string;
    /**
     * Phase 5.2 / MANIFEST.md §6.3 — the mod's resolved load index. The load
     * cycle derives it from the array position; a mid-session `enable` carries
     * it here, because that call has one mod, not the whole list. Interceptor
     * run order is this index, exactly as mount order is (`MOUNTS.md` §3.1).
     */
    readonly loadIndex?: number;
    readonly roles?: readonly string[];
}

export interface LifecycleHostOptions {
    readonly loadHooks: LoadModHooks;
    readonly stateStore: LifecycleStateStore;
    readonly faultStore?: LifecycleFaultStore;
    readonly deadlineMs?: number;
    /**
     * Phase 1.5 — the native-tier loader. Optional: when absent, the host
     * uses `noNativeHooks` and behaves exactly as Phase 1.4 did (no native
     * imports, no CSS). When present, the host:
     *   • mounts `native.css` after `activate` fires successfully (idempotent);
     *   • unmounts `native.css` after `disable` fires (idempotent);
     *   • forgets the cached module on `disable` so a re-enable re-imports.
     * The `loadHooks` seam still owns `import()`; this loader only handles
     * the CSS side-effects and the module-cache invalidation that the host
     * owns but the `LoadModHooks` function does not.
     */
    readonly nativeLoader?: NativeLoader;
}

export interface LifecycleHost {
    runLoadCycle(input: {
        readonly mods: readonly LifecycleMod[];
        readonly enablement: ModEnablementMap;
        readonly ctx?: ModContext;
        /**
         * Phase 4.0 — per-mod context factory. When supplied, the host calls
         * it for each mod and passes the result to that mod's hooks; the
         * single `ctx` (above) is the fallback for callers that do not supply
         * a factory. The factory takes a narrow mod view so the bootstrap
         * does not have to expose `ValidatedMod` here.
         */
        readonly ctxForMod?: ModContextFactory;
    }): Promise<LoadCycleResult>;
    enable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult>;
    disable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult>;
    remove(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult>;
    clean(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult>;
    isLatched(modId: string): boolean;
    reset(): void;
}

/**
 * The default `LoadModHooks` for a mod with no `native` block, or for tests
 * that do not want to wire 1.5's import. Returns `undefined` so the host
 * short-circuits without recording a fault — a mod declaring no hooks
 * behaves exactly as mods do today (Phase 1.4 §3).
 */
export const noNativeHooks: LoadModHooks = (mod) => {
    if (!mod.native) return undefined;
    return undefined;
};

interface ResolvedHooks {
    readonly modId: string;
    readonly hooks: NativeModHooks;
}

export function createLifecycleHost(options: LifecycleHostOptions): LifecycleHost {
    const loadHooks = options.loadHooks;
    const stateStore = options.stateStore;
    const faultStore = options.faultStore ?? createNoopFaultStore();
    const deadlineMs = options.deadlineMs ?? LIFECYCLE_DEADLINE_MS;
    const nativeLoader = options.nativeLoader;

    // In-memory session state. `latched` is per-session; `strikes` accumulate
    // within a session and are cleared by `reset()`. A restart gives a mod a
    // fresh chance, matching the sandbox policy's behaviour.
    const strikes = new Map<string, number>();
    const latched = new Set<string>();
    // Cache of resolved hooks per mod id, so `enable` does not re-import.
    // `runLoadCycle` populates this; `disable` and `remove` read from it.
    const resolved = new Map<string, ResolvedHooks>();

    function recordFault(input: {
        readonly mod: LifecycleMod;
        readonly kind: LifecycleFaultKind;
        readonly hook: string;
        readonly message: string;
        readonly deadlineMsOverride?: number;
    }): void {
        const strikeCount = (strikes.get(input.mod.id) ?? 0) + 1;
        strikes.set(input.mod.id, strikeCount);
        const isLatched = strikeCount >= LIFECYCLE_FAULT_STRIKES;
        if (isLatched) latched.add(input.mod.id);
        const reason = formatLifecycleFaultReason({
            modName: input.mod.name,
            kind: input.kind,
            hook: input.hook,
            message: input.message,
            deadlineMs: input.deadlineMsOverride ?? deadlineMs,
            latched: isLatched,
        });
        faultStore.add({
            modId: input.mod.id,
            file: input.mod.file,
            kind: input.kind,
            hook: input.hook as never,
            strikes: strikeCount,
            latched: isLatched,
            reason,
        });
    }

    /**
     * Run one hook under the deadline. A hook that throws, rejects, or does
     * not settle within `deadlineMs` is contained as a fault and the host
     * carries on — never fatal (Phase 1.4 §3).
     *
     * Returns `true` on a clean run, `false` on a fault. A latched mod's
     * hooks are skipped (returns `true` with `skipped: true` so callers can
     * tell the difference in tests).
     */
    async function runOneHook(input: {
        readonly mod: LifecycleMod;
        readonly hookName: string;
        readonly fn: NativeHookFn;
        readonly ctx: ModContext | undefined;
    }): Promise<HookRunResult> {
        if (latched.has(input.mod.id)) {
            return { modId: input.mod.id, hook: input.hookName as never, ok: true, skipped: true };
        }
        try {
            await runUnderDeadline(input.fn, input.ctx, deadlineMs);
            // A clean run clears prior strikes — a hook that succeeded is not
            // on a fault streak. Matches `sandboxFaultPolicy.recordSuccess`.
            strikes.delete(input.mod.id);
            return { modId: input.mod.id, hook: input.hookName as never, ok: true };
        } catch (error) {
            const { kind, message } = classifyFault(error);
            recordFault({
                mod: input.mod,
                kind,
                hook: input.hookName,
                message,
                deadlineMsOverride: kind === 'deadline' ? deadlineMs : undefined,
            });
            return {
                modId: input.mod.id,
                hook: input.hookName as never,
                ok: false,
                reason: message,
            };
        }
    }

    /**
     * Resolve a mod's native hooks via the 1.5 seam. A mod with no `native`
     * block yields `undefined` and the host records nothing — the mod simply
     * has no hooks to fire, which is the "behaves identically" rule (§3).
     *
     * A faulted `import()` (Phase 1.5 §4) surfaces as a `load` fault here so
     * the app still starts. A `missing-export` error (the loader resolved the
     * module but a declared hook name does not match an exported function) is
     * surfaced with its own fault kind — the user sees "names a missing
     * export" rather than "load failed", because a missing export is a
     * manifest bug, not a network error.
     *
     * The host does NOT latch on a load or missing-export fault — the next
     * load cycle (after the user fixes the file and rescans) should get
     * another chance, and a load is not a hook run.
     */
    async function resolveHooks(mod: LifecycleMod): Promise<ResolvedHooks | undefined> {
        const cached = resolved.get(mod.id);
        if (cached) return cached;
        let hooks: NativeModHooks | undefined;
        try {
            hooks = await loadHooks(mod);
        } catch (error) {
            const isMissingExport = isNativeMissingExportError(error);
            const kind: LifecycleFaultKind = isMissingExport ? 'missing-export' : 'load';
            const message = error instanceof Error ? error.message : String(error);
            faultStore.add({
                modId: mod.id,
                file: mod.file,
                kind,
                hook: isMissingExport ? 'activate' : 'load',
                strikes: 0,
                latched: false,
                reason: formatLifecycleFaultReason({
                    modName: mod.name,
                    kind,
                    hook: isMissingExport ? 'activate' : 'load',
                    message,
                }),
            });
            return undefined;
        }
        if (!hooks) return undefined;
        const resolvedHooks: ResolvedHooks = { modId: mod.id, hooks };
        resolved.set(mod.id, resolvedHooks);
        return resolvedHooks;
    }

    /**
     * Phase 5.2 — resolve and register the mod's `native.generateInterceptor`.
     *
     * Called at the same moment `native.css` is mounted: after the mod's
     * `activate` has had its chance and did not fault. The gate is
     * `!hooks.activate || activateRan`, NOT bare `activateRan` — a mod may
     * declare an interceptor and no `activate` hook at all (nothing obliges it
     * to register anything at runtime), and such a mod must still get its
     * interceptor. A mod whose `activate` faulted does NOT: it is in a broken
     * state, and code from a broken mod does not belong in the path that
     * builds the prompt.
     *
     * Never throws. A manifest naming a missing export is surfaced as the same
     * `missing-export` fault a missing hook export gets, and the mod simply has
     * no interceptor — the turn path is unaffected.
     */
    async function attachInterceptor(mod: LifecycleMod, loadIndex: number): Promise<void> {
        if (!nativeLoader || !mod.native?.generateInterceptor) return;
        try {
            const fn = await nativeLoader.resolveInterceptor(mod);
            if (fn) {
                registerModInterceptor({ id: mod.id, name: mod.name, loadIndex, file: mod.file }, fn);
            }
        } catch (error) {
            const isMissingExport = isNativeMissingExportError(error);
            const kind: LifecycleFaultKind = isMissingExport ? 'missing-export' : 'load';
            const message = error instanceof Error ? error.message : String(error);
            faultStore.add({
                modId: mod.id,
                file: mod.file,
                kind,
                hook: 'generateInterceptor' as never,
                strikes: 0,
                latched: false,
                reason: formatLifecycleFaultReason({
                    modName: mod.name,
                    kind,
                    hook: 'generateInterceptor',
                    message,
                }),
            });
        }
    }

    /**
     * The dependency-enabled gate (MANIFEST.md §6.4). A mod whose dependency
     * is present but DISABLED must not activate; this is a runtime fault with
     * its own kind, not a load rejection. The dependency's enablement is read
     * from the enablement map the caller supplies.
     */
    function dependenciesEnabled(mod: LifecycleMod, enablement: ModEnablementMap): string[] {
        const disabled: string[] = [];
        for (const depId of Object.keys(mod.dependencies)) {
            const key = `mod.${depId}`;
            if (enablement[key] === false) disabled.push(depId);
        }
        return disabled;
    }

    async function runLoadCycle(input: {
        readonly mods: readonly LifecycleMod[];
        readonly enablement: ModEnablementMap;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<LoadCycleResult> {
        const ctxForMod = input.ctxForMod;
        const fallbackCtx = input.ctx;
        // Phase 4.2 / `MOUNTS.md` §3.1 — the load index is the position in
        // the loader's resolved `mods[]` array. The host receives `mods` in
        // resolved order (the loader forbids re-sorting, `modTypes.ts:341`),
        // so the index is the array position. Built once per load cycle and
        // passed to the context factory so the mount registry can sort mod
        // entries by `(loadIndex, withinModIndex)` (§3.2).
        const loadIndexMap = new Map<string, number>();
        input.mods.forEach((mod, index) => loadIndexMap.set(mod.id, index));
        const ctxFor = (mod: LifecycleMod): ModContext | undefined => {
            if (ctxForMod) {
                try {
                    return ctxForMod({
                        id: mod.id,
                        name: mod.name,
                        version: mod.version,
                        folder: mod.folder,
                        loadIndex: loadIndexMap.get(mod.id) ?? 0,
                        roles: mod.roles,
                    });
                } catch {
                    // A factory failure must not stop the load cycle; the hook
                    // receives `undefined` and a mod that needs state guards.
                    return undefined;
                }
            }
            return fallbackCtx;
        };
        const runs: HookRunResult[] = [];
        const faultedModIds: string[] = [];
        // A refresh is a new resolved mod set. Remove providers belonging to
        // mods that disappeared or became disabled before replaying activation.
        clearAllModRoleLeases();
        serviceRoles.clear();

        // Mods arrive in the loader's resolved order (Phase 1.3 §6.3). The
        // host fires hooks in that order, so a dependency activates before
        // its dependent — Phase 1.4 §3 "Order" and the done-when test.
        for (const mod of input.mods) {
            const enabled = input.enablement[`mod.${mod.id}`] !== false;
            if (!enabled) continue;

            const disabledDeps = dependenciesEnabled(mod, input.enablement);
            if (disabledDeps.length > 0) {
                faultStore.add({
                    modId: mod.id,
                    file: mod.file,
                    kind: 'disabled-dep',
                    hook: 'activate',
                    strikes: 0,
                    latched: false,
                    reason: formatLifecycleFaultReason({
                        modName: mod.name,
                        kind: 'disabled-dep',
                        hook: 'activate',
                        message: `dependency "${disabledDeps[0]}" is disabled`,
                    }),
                });
                faultedModIds.push(mod.id);
                continue;
            }

            enableModRoles(mod.id);

            const resolvedHooks = await resolveHooks(mod);
            if (!resolvedHooks) {
                checkModRoles({
                    mod,
                    declaredRoles: mod.roles ?? [],
                    faultFile: mod.file,
                });
                continue;
            }

            // install / update / activate fire in this order at every load.
            // `install` fires only the FIRST time a mod id is seen; `update`
            // fires when the version string differs from the recorded one
            // (MANIFEST.md §6.2 — string inequality, no ordering).
            let seen: ModSeenRecord | undefined;
            try {
                seen = await stateStore.get(mod.id);
            } catch {
                // A state-store failure must not stop activation; treat as
                // unseen so `install` fires and the mod still activates.
                seen = undefined;
            }

            const hooks = resolvedHooks.hooks;
            // Phase 4.0 — build the per-mod context once for this mod's
            // hooks. The factory may return `undefined` (e.g. no active
            // campaign at load time); hooks that need state guard against
            // `undefined` (`MANIFEST.md` §10).
            const modCtx = ctxFor(mod);
            const ranInstall: HookRunResult[] = [];
            if (!seen && hooks.install) {
                const r = await runOneHook({ mod, hookName: 'install', fn: hooks.install, ctx: modCtx });
                ranInstall.push(r);
            }
            if (seen && seen.lastSeenVersion !== mod.version && hooks.update) {
                const r = await runOneHook({ mod, hookName: 'update', fn: hooks.update, ctx: modCtx });
                ranInstall.push(r);
            }

            // Record the seen version after install/update so a later fault
            // in activate does not cause install to fire twice on next load.
            // If install/update faulted, still record — the user can rescan
            // to retry activate, and install firing again is worse.
            try {
                await stateStore.set(mod.id, { lastSeenVersion: mod.version });
            } catch {
                // Persisting the seen record is best-effort; a failure here
                // means install may fire again next load, which is benign.
            }

            let activateRan = false;
            if (hooks.activate) {
                const r = await runOneHook({ mod, hookName: 'activate', fn: hooks.activate, ctx: modCtx });
                activateRan = r.ok && !r.skipped;
                runs.push(r);
            }
            checkModRoles({
                mod,
                declaredRoles: mod.roles ?? [],
                faultFile: mod.file,
            });

            // Phase 1.5 — mount the mod's CSS after activate succeeds. A
            // faulted activate does NOT mount the stylesheet: the mod is in
            // a broken state and its CSS should not reach the page until the
            // user fixes it and rescans. `mountCss` is idempotent, so a
            // re-load that re-activates does not double-mount.
            if (activateRan && nativeLoader && mod.native?.css) {
                nativeLoader.mountCss(mod);
            }

            // Phase 5.2 — register the pre-prompt interceptor. See
            // `attachInterceptor` for why the gate is not bare `activateRan`.
            if (!hooks.activate || activateRan) {
                enableModInterceptors(mod.id);
                await attachInterceptor(mod, loadIndexMap.get(mod.id) ?? 0);
            }

            runs.push(...ranInstall.filter((r) => !r.ok || !r.skipped));

            // Collect faulted mod ids so a caller can tell which mods failed
            // without re-reading the fault store.
            const anyFaulted = ranInstall.some((r) => !r.ok) || (activateRan === false && !!hooks.activate);
            if (anyFaulted) faultedModIds.push(mod.id);
        }

        return { runs, faultedModIds };
    }

    async function fireUserHook(input: {
        readonly mod: LifecycleMod;
        readonly hookName: string;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult> {
        // Phase 4.0 — prefer the per-mod factory so the hook receives a
        // context whose `mod.id` matches the hook's mod. Falls back to the
        // single `ctx` for callers that do not supply a factory.
        const ctx = input.ctxForMod
            ? (() => {
                try {
                    return input.ctxForMod!({
                        id: input.mod.id,
                        name: input.mod.name,
                        version: input.mod.version,
                        folder: input.mod.folder,
                        loadIndex: input.mod.loadIndex,
                        roles: input.mod.roles,
                    });
                } catch {
                    return undefined;
                }
            })()
            : input.ctx;
        const resolvedHooks = await resolveHooks(input.mod);
        if (!resolvedHooks) {
            return {
                modId: input.mod.id,
                hook: input.hookName as never,
                ok: true,
                skipped: true,
            };
        }
        const fn = resolvedHooks.hooks[input.hookName as keyof NativeModHooks];
        if (!fn) {
            return {
                modId: input.mod.id,
                hook: input.hookName as never,
                ok: true,
                skipped: true,
            };
        }
        return runOneHook({ mod: input.mod, hookName: input.hookName, fn, ctx });
    }

    /**
     * `enable` is followed immediately by `activate` (MANIFEST.md §3.1).
     * Both run under the host's containment; a fault in either is surfaced.
     */
    async function enable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult> {
        enableModRoles(input.mod.id);
        // Phase 4.2 / `MOUNTS.md` §8.5 — clear the revoked lease before
        // `activate` runs, so the mod's new `activate` can register its
        // mounts again. `disable` revoked the lease; `enable` restores it.
        enableModMounts(input.mod.id);
        // Phase 5.1 — same discipline for macros: clear the revoked lease
        // before `activate` runs, so the mod's new `activate` can register
        // its macros again.
        enableModMacros(input.mod.id);
        // Phase 5.2 — same discipline for the prompt interceptor: `disable`
        // revoked the lease, `enable` restores it before `activate` runs.
        enableModInterceptors(input.mod.id);
        // Phase 5.4 — same discipline for fact publishers: `disable`
        // revoked the lease, `enable` restores it before `activate` runs.
        enableModFacts(input.mod.id);
        const enableResult = await fireUserHook({
            mod: input.mod,
            hookName: 'enable',
            ctx: input.ctx,
            ctxForMod: input.ctxForMod,
        });
        if (!enableResult.ok) {
            checkModRoles({
                mod: input.mod,
                declaredRoles: input.mod.roles ?? [],
                faultFile: input.mod.file,
            });
            return enableResult;
        }
        // `activate` follows `enable` regardless of whether `enable` was
        // skipped (a mod with no `enable` hook still activates on toggle-on).
        const activateResult = await fireUserHook({
            mod: input.mod,
            hookName: 'activate',
            ctx: input.ctx,
            ctxForMod: input.ctxForMod,
        });
        // Phase 1.5 — mount CSS after a successful enable+activate. Idempotent
        // (a re-enable does not double-mount), and only fires when activate
        // actually ran and succeeded — a skipped or faulted activate leaves
        // the page without the mod's CSS, matching the load-cycle behaviour.
        if (activateResult.ok && !activateResult.skipped && nativeLoader && input.mod.native?.css) {
            nativeLoader.mountCss(input.mod);
        }
        // Phase 5.2 — register the interceptor on a mid-session enable, on the
        // same gate the load cycle uses. `loadIndex` rides on the mod here
        // because this call carries one mod, not the resolved list.
        if (activateResult.ok) {
            await attachInterceptor(input.mod, input.mod.loadIndex ?? 0);
        }
        checkModRoles({
            mod: input.mod,
            declaredRoles: input.mod.roles ?? [],
            faultFile: input.mod.file,
        });
        return activateResult;
    }

    async function disable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult> {
        const result = await fireUserHook({
            mod: input.mod,
            hookName: 'disable',
            ctx: input.ctx,
            ctxForMod: input.ctxForMod,
        });
        // Phase 2.4: teardown is host-owned, even if the mod forgot to unsubscribe.
        disposeModSubscriptions(input.mod.id);
        // Phase 3.2 / `EVENTS.md` §5.4: the same discipline for event listeners.
        // Every subscription is attributed to the mod whose context created it
        // and **the host removes them here — the mod is never trusted to call
        // `off`.** Phase 4.9.4 will try deliberately to leak one.
        modEventBus.disposeModListeners(input.mod.id);
        // Phase 4.2 / `MOUNTS.md` §8.5: the same discipline for mount points.
        // Every mount the mod registered is removed here — the mod is never
        // trusted to call `remove()`. This is how 4.2's "no ghost entries" rule
        // and 4.5's "disabling a mod closes and destroys its windows" both fall
        // out of the existing teardown site rather than needing their own. The
        // mod's lease is revoked so a registration call from a stale closure
        // after disable is a no-op plus a fault.
        disableModMounts(input.mod.id);
        // Phase 5.1: the same discipline for macros. Every macro the mod
        // registered is removed here — the mod is never trusted to call
        // `unregister()`. The mod's lease is revoked so a registration call
        // from a stale closure after disable is a no-op plus a fault.
        disableModMacros(input.mod.id);
        // Phase 5.2: the same discipline for the prompt interceptor, and it is
        // the one where the lease matters most — a mod switched off mid-turn
        // must not contribute to the prompt of the turn it was removed during.
        // `disableModInterceptors` revokes the lease so an in-flight result is
        // discarded rather than folded in.
        disableModInterceptors(input.mod.id);
        // Phase 5.4: the same discipline for fact publishers. Every
        // publisher the mod registered is removed here — the mod is never
        // trusted to call `unregister()`. The mod's lease is revoked so a
        // register call from a stale closure after disable is a no-op plus
        // a fault, and a publisher in flight when the mod was toggled off
        // has its result discarded rather than merged.
        disableModFacts(input.mod.id);
        // Phase 7.1.1: roles are revoked at this same host-owned teardown
        // boundary so stale closures cannot answer later asks.
        disableModRoles(input.mod.id);
        // Phase 1.5 — unmount CSS after disable, regardless of whether the
        // disable hook itself threw. The mod is being switched off; its CSS
        // must leave the page even if its cleanup hook misbehaved, otherwise
        // a broken disable would leak the stylesheet for the rest of the
        // session. Idempotent.
        if (nativeLoader) {
            nativeLoader.unmountCss(input.mod.id);
            // Forget the cached module so a re-enable re-imports. A mod whose
            // `disable` ran has been torn down; its module namespace should
            // not survive into a fresh enable (mirrors the sandbox's per-run
            // isolation — a re-enabled mod should not see stale module state).
            nativeLoader.forget(input.mod.id);
            // Drop the resolved-hooks cache too, so the next enable re-resolves.
            resolved.delete(input.mod.id);
        }
        return result;
    }

    /**
     * `delete` fires before the folder is removed FROM WITHIN THE APP
     * (MANIFEST.md §3.1). It cannot fire when the user deletes the folder
     * with the app closed; the host detects the absence at next load. This
     * phase only provides the seam — the actual removal is 6.4's policy.
     */
    async function remove(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult> {
        return fireUserHook({ mod: input.mod, hookName: 'delete', ctx: input.ctx, ctxForMod: input.ctxForMod });
    }

    /**
     * `clean` is the mod's chance to remove data the host does not know it
     * owns. After `clean` returns (or times out, or throws), Phase 6.4
     * removes the mod's provisioned tables itself, unconditionally
     * (MANIFEST.md §7.2). This phase provides the seam only — §5 stop.
     */
    async function clean(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
        readonly ctxForMod?: ModContextFactory;
    }): Promise<HookRunResult> {
        return fireUserHook({ mod: input.mod, hookName: 'clean', ctx: input.ctx, ctxForMod: input.ctxForMod });
    }

    return {
        runLoadCycle,
        enable,
        disable,
        remove,
        clean,
        isLatched: (modId) => latched.has(modId),
        reset: () => {
            strikes.clear();
            latched.clear();
            resolved.clear();
            disposeAllModSubscriptions();
            // Phase 3.2 / `EVENTS.md` §5.4 — `reset()` is the same teardown call
            // site for the bus. Retained sticky payloads go too: a reset host is
            // a host that has not yet said the app is ready.
            modEventBus.reset();
            eventFaultStore.clear();
            // Phase 4.2 / `MOUNTS.md` §8.5 — same discipline for mount points.
            clearAllModMounts();
            // Phase 5.1 — same discipline for macros.
            clearAllModMacros();
            // Phase 5.2 — same discipline for prompt interceptors.
            clearAllModInterceptors();
            // Phase 5.4 — same discipline for fact publishers.
            clearAllModFacts();
            clearAllModRoleLeases();
            serviceRoles.clear();
            nativeLoader?.clear();
            faultStore.clear();
        },
    };
}

/**
 * Run `fn` under a deadline. Resolves with `fn`'s result, or rejects with a
 * deadline error if `fn` does not settle within `deadlineMs`. The deadline
 * is implemented with `Promise.race` so a hanging hook's promise is orphaned
 * rather than awaited — the host returns control to the caller regardless.
 */
function runUnderDeadline(fn: NativeHookFn, ctx: ModContext | undefined, deadlineMs: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((_, reject) => {
        timer = setTimeout(() => {
            reject(new LifecycleDeadlineError(deadlineMs));
        }, deadlineMs);
    });
    const call = Promise.resolve().then(() => fn(ctx));
    return Promise.race([call, deadline]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}

class LifecycleDeadlineError extends Error {
    constructor(deadlineMs: number) {
        super(`[lifecycle] deadline exceeded (${deadlineMs} ms)`);
        this.name = 'LifecycleDeadlineError';
    }
}

function classifyFault(error: unknown): {
    kind: LifecycleFaultKind;
    message: string;
} {
    if (error instanceof LifecycleDeadlineError) {
        return { kind: 'deadline', message: error.message };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { kind: 'threw', message };
}

/**
 * Narrow an unknown error to a `NativeMissingExportError`. Uses the duck-typed
 * `name` field rather than `instanceof` so a loader from a different module
 * instance (e.g. in tests with vi.resetModules) still classifies correctly.
 */
function isNativeMissingExportError(error: unknown): error is NativeMissingExportError {
    return error instanceof Error && (error as { name?: string }).name === 'NativeMissingExportError';
}

/** A no-op fault store for tests that do not care about surfaced faults. */
function createNoopFaultStore(): LifecycleFaultStore {
    return {
        add: () => {},
        getFaults: () => [],
        getRecords: () => [],
        subscribe: () => () => {},
        clear: () => {},
    };
}
