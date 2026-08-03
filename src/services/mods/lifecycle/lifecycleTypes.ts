/**
 * Phase 1.4 — lifecycle hook types.
 *
 * The seven hook names are fixed by MANIFEST.md §3.1 and Phase 1.4 §2. The
 * firing moments and ordering are this phase's; the argument shape is NOT —
 * MANIFEST.md §10 defers `ModContext` to Phase 2.2, so it is carried here as
 * an opaque token. The host passes whatever the caller supplies through to
 * each hook; a mod author's TypeScript sees `unknown` until 2.2 narrows it.
 *
 * `NativeModHooks` is what Phase 1.5's native loader produces after
 * `import()`-ing a mod's `native.js` and resolving the named exports from
 * `manifest.native.hooks`. Phase 1.4 consumes that interface and fires the
 * hooks; the seam between this phase and 1.5 is the `LoadModHooks` function
 * passed into `createLifecycleHost`.
 */
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
 * The mod context object. Phase 2.2 owns the shape; this phase only carries
 * it. Declared as `unknown` so no caller can reach into it by accident.
 */
export type ModContext = unknown;

/**
 * A single lifecycle hook. May be async; the host awaits it under a timeout.
 * A hook that throws or rejects is contained as a fault, never fatal
 * (Phase 1.4 §3).
 */
export type NativeHookFn = (ctx: ModContext) => void | Promise<void>;

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
    readonly native?: { readonly js: string; readonly hooks?: Record<string, string> };
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