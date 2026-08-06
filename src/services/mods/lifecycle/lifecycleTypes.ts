/**
 * Phase 1.4 — lifecycle hook types.
 *
 * The seven hook names are fixed by MANIFEST.md §3.1 and Phase 1.4 §2. The
 * firing moments and ordering are this phase's; the argument shape is now
 * Phase 2.3's `ModContext` (previously an opaque `unknown` token per
 * MANIFEST.md §10's deferral to 2.2). The host passes whatever the caller
 * supplies through to each hook; a mod author's TypeScript sees the real
 * `ModContext` shape from Phase 2.3's `modContext.ts`.
 *
 * `NativeModHooks` is what Phase 1.5's native loader produces after
 * `import()`-ing a mod's `native.js` and resolving the named exports from
 * `manifest.native.hooks`. Phase 1.4 consumes that interface and fires the
 * hooks; the seam between this phase and 1.5 is the `LoadModHooks` function
 * passed into `createLifecycleHost`.
 */
import type { ModContext } from '../modContext';
import type { ModFault } from '../modTypes';

export type LifecycleHookName =
    | 'install'
    | 'update'
    | 'activate'
    | 'enable'
    | 'disable'
    | 'delete'
    | 'clean';

/** The complete, ordered set — used for validation and tests. */
export const LIFECYCLE_HOOK_NAMES: readonly LifecycleHookName[] = [
    'install',
    'update',
    'activate',
    'enable',
    'disable',
    'delete',
    'clean',
] as const;

/**
 * The mod context object. Phase 2.3 narrowed this from `unknown` to the real
 * `ModContext` shape from `modContext.ts`. The host passes whatever the caller
 * supplies through to each hook — it never introspects the object, only
 * carries it. A native mod's `activate`/`enable`/`disable`/etc. now receives
 * the same surface a sandboxed compute hook does (`API.md` §1.1 — one shape,
 * two commit points), so a mod that has both a compute hook and a native UI
 * panel can share one helper module between them.
 *
 * Re-exported here so the lifecycle host's call sites have one import for
 * both the hook names and the context shape. The source of truth is
 * `../modContext`; this is a re-export, not a redefinition.
 */
export type { ModContext };

/**
 * Phase 4.0 — a factory that builds a `ModContext` for one mod. The lifecycle
 * host calls it per-mod inside the load cycle (and for `enable`/`disable`),
 * so each hook receives a context whose `mod.id` matches the hook's mod
 * (`API.md` §3 — the object is per-mod so table access resolves to this
 * mod's namespace). The factory may return `undefined` for a mod whose
 * context cannot be built (e.g. no active campaign at load time); a hook
 * that needs state guards against `undefined` (`MANIFEST.md` §10).
 *
 * Phase 4.2 / `MOUNTS.md` §3.1 — `loadIndex` is the mod's resolved load
 * index (the position in the loader's resolved `mods[]` array). The mount
 * registry sorts mod entries by `(loadIndex, withinModIndex)` so a
 * mid-session enable inserts at its proper place (§3.2). Optional in the
 * factory input because the factory predates 4.2; the bootstrap supplies
 * it when it has the resolved list.
 */
export type ModContextFactory = (mod: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly folder?: string;
    readonly loadIndex?: number;
}) => ModContext | undefined;

/**
 * A single lifecycle hook. May be async; the host awaits it under a timeout.
 * A hook that throws or rejects is contained as a fault, never fatal
 * (Phase 1.4 §3).
 *
 * The context is `ModContext | undefined` rather than `ModContext` because the
 * bootstrap does not yet construct a `ModContext` for the install/update/
 * activate load cycle — that wiring lands with the lifecycle-context phase
 * that follows 2.3. A mod's `activate` hook today receives `undefined` when
 * fired from the load cycle, and a real `ModContext` when fired from a path
 * that has one (the explicit `enable`/`disable` code paths will pass one
 * once they are wired). A mod that wants to read host state should guard
 * against `undefined`; a mod that only logs (like the example fixture) does
 * not need to.
 */
export type NativeHookFn = (ctx: ModContext | undefined) => void | Promise<void>;

/**
 * The resolved exports of a mod's `native.js`, keyed by hook name. Every
 * entry is optional — a mod declaring no hooks produces an empty object and
 * behaves exactly as mods do today (Phase 1.4 §3 "Every hook is optional").
 */
export type NativeModHooks = Partial<Record<LifecycleHookName, NativeHookFn>>;

/**
 * Phase 1.5's seam. Given a validated mod, return its resolved native hooks
 * (or `undefined` if the mod has no `native` entry). The host never imports
 * mod code itself — that is 1.5's job, and the server never evaluates native
 * source (MANIFEST.md §4). Returns `undefined` for a mod with no `native`
 * block so the host can short-circuit without a runtime fault.
 */
export type LoadModHooks = (mod: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly native?: { readonly js: string; readonly css?: string; readonly hooks?: Record<string, string> };
    readonly folder?: string;
}) => Promise<NativeModHooks | undefined> | NativeModHooks | undefined;

/**
 * The recorded "seen" state for one mod id. Drives `install` (no record) and
 * `update` (version differs from the recorded string). Persisted across app
 * loads so `install` fires once per mod id, never again (MANIFEST.md §3.1).
 */
export interface ModSeenRecord {
    readonly lastSeenVersion: string;
}

/**
 * Persistent map of mod id → seen record. Provided as an interface so tests
 * use an in-memory implementation and the real one uses idb-keyval (the same
 * store the settings slice uses), keeping the host pure and testable.
 */
export interface LifecycleStateStore {
    get(modId: string): Promise<ModSeenRecord | undefined>;
    set(modId: string, record: ModSeenRecord): Promise<void>;
    clear(): Promise<void>;
}

export type LifecycleFaultKind =
    | 'threw'
    | 'deadline'
    | 'missing-export'
    | 'load'
    | 'disabled-dep';

export interface LifecycleFaultRecord extends ModFault {
    readonly modId: string;
    readonly kind: LifecycleFaultKind;
    readonly hook: LifecycleHookName | 'load';
    readonly strikes: number;
    readonly latched: boolean;
}

export interface LifecycleFaultStore {
    add(record: LifecycleFaultRecord): void;
    getFaults(): readonly ModFault[];
    getRecords(): readonly LifecycleFaultRecord[];
    subscribe(listener: () => void): () => void;
    clear(): void;
}

/**
 * The result of running one hook for one mod. Tests assert against this; the
 * running app ignores it (faults are already in the store and surfaced in
 * Extensions before the call returns).
 */
export interface HookRunResult {
    readonly modId: string;
    readonly hook: LifecycleHookName;
    readonly ok: boolean;
    readonly skipped?: boolean;
    readonly reason?: string;
}

/**
 * The result of one load cycle (the install/update/activate pass that fires
 * at app load for each enabled mod). Aggregated so a caller can verify the
 * whole pass without re-reading the fault store.
 */
export interface LoadCycleResult {
    readonly runs: readonly HookRunResult[];
    readonly faultedModIds: readonly string[];
}

/** The enablement map — `settings.moduleEnabled` keyed by `mod.<id>`. */
export type ModEnablementMap = Record<string, boolean>;