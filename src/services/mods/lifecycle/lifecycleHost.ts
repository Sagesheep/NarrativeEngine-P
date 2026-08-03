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

/** A mod, as the host needs to see it. A narrow read-only view of `ValidatedMod`. */
export interface LifecycleMod {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly file: string;
    readonly dependencies: Record<string, string>;
    readonly native?: { readonly js: string; readonly hooks?: Record<string, string> };
}

export interface LifecycleHostOptions {
    readonly loadHooks: LoadModHooks;
    readonly stateStore: LifecycleStateStore;
    readonly faultStore?: LifecycleFaultStore;
    readonly deadlineMs?: number;
}

export interface LifecycleHost {
    runLoadCycle(input: {
        readonly mods: readonly LifecycleMod[];
        readonly enablement: ModEnablementMap;
        readonly ctx?: ModContext;
    }): Promise<LoadCycleResult>;
    enable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
    }): Promise<HookRunResult>;
    disable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
    }): Promise<HookRunResult>;
    remove(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
    }): Promise<HookRunResult>;
    clean(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
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
        readonly ctx: ModContext;
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
     * the app still starts. The host does NOT latch on a load fault — the
     * next load cycle (after the user fixes the file and rescans) should get
     * another chance, and a load is not a hook run.
     */
    async function resolveHooks(mod: LifecycleMod): Promise<ResolvedHooks | undefined> {
        const cached = resolved.get(mod.id);
        if (cached) return cached;
        let hooks: NativeModHooks | undefined;
        try {
            hooks = await loadHooks(mod);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            faultStore.add({
                modId: mod.id,
                file: mod.file,
                kind: 'load',
                hook: 'load',
                strikes: 0,
                latched: false,
                reason: formatLifecycleFaultReason({
                    modName: mod.name,
                    kind: 'load',
                    hook: 'load',
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
    }): Promise<LoadCycleResult> {
        const ctx = input.ctx;
        const runs: HookRunResult[] = [];
        const faultedModIds: string[] = [];

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

            const resolvedHooks = await resolveHooks(mod);
            if (!resolvedHooks) continue;

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
            const ranInstall: HookRunResult[] = [];
            if (!seen && hooks.install) {
                const r = await runOneHook({ mod, hookName: 'install', fn: hooks.install, ctx });
                ranInstall.push(r);
            }
            if (seen && seen.lastSeenVersion !== mod.version && hooks.update) {
                const r = await runOneHook({ mod, hookName: 'update', fn: hooks.update, ctx });
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
                const r = await runOneHook({ mod, hookName: 'activate', fn: hooks.activate, ctx });
                activateRan = r.ok && !r.skipped;
                runs.push(r);
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
    }): Promise<HookRunResult> {
        const ctx = input.ctx;
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
    }): Promise<HookRunResult> {
        const enableResult = await fireUserHook({
            mod: input.mod,
            hookName: 'enable',
            ctx: input.ctx,
        });
        if (!enableResult.ok) return enableResult;
        // `activate` follows `enable` regardless of whether `enable` was
        // skipped (a mod with no `enable` hook still activates on toggle-on).
        return fireUserHook({ mod: input.mod, hookName: 'activate', ctx: input.ctx });
    }

    async function disable(input: {
        readonly mod: LifecycleMod;
        readonly ctx?: ModContext;
    }): Promise<HookRunResult> {
        return fireUserHook({ mod: input.mod, hookName: 'disable', ctx: input.ctx });
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
    }): Promise<HookRunResult> {
        return fireUserHook({ mod: input.mod, hookName: 'delete', ctx: input.ctx });
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
    }): Promise<HookRunResult> {
        return fireUserHook({ mod: input.mod, hookName: 'clean', ctx: input.ctx });
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
function runUnderDeadline(fn: NativeHookFn, ctx: ModContext, deadlineMs: number): Promise<void> {
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