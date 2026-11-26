/**
 * Phase 1.4 — test fixtures for the lifecycle host.
 *
 * A test mod that records each hook call in order, so a test can assert the
 * seven hooks fire at the right moment and in the right order (Phase 1.4 §4
 * done-when). Mirrors the style of the sandbox corpus tests: real behaviour,
 * no mocks of the unit under test.
 */
import type {
    LifecycleHookName,
    LifecycleStateStore,
    LoadModHooks,
    ModSeenRecord,
    NativeHookFn,
    NativeModHooks,
} from './lifecycleTypes';
import type { LifecycleMod } from './lifecycleHost';

export interface RecordedCall {
    readonly modId: string;
    readonly hook: LifecycleHookName;
    readonly ctx: unknown;
}

/**
 * A recording mod. Each hook the host fires appends to `calls`. Tests read
 * `calls` to assert ordering and timing. `hookImpls` lets a test override a
 * single hook (e.g. to make one throw) while keeping the recording.
 */
export interface RecordingMod {
    readonly mod: LifecycleMod;
    readonly calls: RecordedCall[];
    readonly hookImpls: NativeModHooks;
    /** Reset between tests. */
    reset(): void;
}

export interface RecordingModOptions {
    readonly id: string;
    readonly name?: string;
    readonly version?: string;
    readonly dependencies?: Record<string, string>;
    /** Override one hook's behaviour while still recording the call. */
    readonly overrides?: Partial<Record<LifecycleHookName, NativeHookFn>>;
    /** When true, the mod declares NO native block (behaves as mods do today). */
    readonly noNative?: boolean;
}

export function makeRecordingMod(options: RecordingModOptions): RecordingMod {
    const calls: RecordedCall[] = [];
    const overrides = options.overrides ?? {};
    const id = options.id;

    const wrap = (hook: LifecycleHookName): NativeHookFn | undefined => {
        const override = overrides[hook];
        if (override) return (ctx) => {
            calls.push({ modId: id, hook, ctx });
            return override(ctx);
        };
        return (ctx) => {
            calls.push({ modId: id, hook, ctx });
        };
    };

    const hookImpls: NativeModHooks = {};
    (['install', 'update', 'activate', 'enable', 'disable', 'delete', 'clean'] as const).forEach(
        (hook) => {
            const fn = wrap(hook);
            if (fn) hookImpls[hook] = fn;
        },
    );

    const mod: LifecycleMod = {
        id,
        name: options.name ?? `Test Mod ${id}`,
        version: options.version ?? '1.0.0',
        file: `${id}/manifest.json`,
        dependencies: options.dependencies ?? {},
        native: options.noNative ? undefined : { js: 'index.js', hooks: {} },
    };

    return {
        mod,
        calls,
        hookImpls,
        reset: () => { calls.length = 0; },
    };
}

/**
 * Build a `LoadModHooks` that returns the recording mod's `hookImpls`. This
 * is the Phase 1.5 seam, faked in tests — the real 1.5 will `import()` the
 * mod's `native.js` and resolve the named exports. Returns `undefined` for
 * a mod with no `native` block, matching the host's contract (a no-native
 * mod has no hooks to fire — "behaves identically" rule, Phase 1.4 §3).
 */
export function recordingLoader(mods: readonly RecordingMod[]): LoadModHooks {
    const byId = new Map(mods.map((m) => [m.mod.id, m]));
    return (mod) => {
        const rec = byId.get(mod.id);
        if (!rec) return undefined;
        if (!rec.mod.native) return undefined;
        return rec.hookImpls;
    };
}

/**
 * In-memory `LifecycleStateStore` for tests. Real implementation will use
 * idb-keyval (the same store the settings slice uses).
 */
export function makeInMemoryStateStore(initial?: Record<string, ModSeenRecord>): LifecycleStateStore {
    const store = new Map<string, ModSeenRecord>(
        Object.entries(initial ?? {}).map(([k, v]) => [k, { ...v }]),
    );
    return {
        async get(modId) { return store.get(modId); },
        async set(modId, record) { store.set(modId, { ...record }); },
        async clear() { store.clear(); },
    };
}

/** Convenience: assert that `calls` matches the given hook sequence exactly. */
export function callSequence(calls: readonly RecordedCall[]): LifecycleHookName[] {
    return calls.map((c) => c.hook);
}