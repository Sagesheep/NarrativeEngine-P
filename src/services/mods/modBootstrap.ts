import { fetchMods } from './modClient';
import { modToContributionModule } from './modAdapter';
import type { LifecycleMod } from './lifecycle/lifecycleHost';
import { createLifecycleHost } from './lifecycle/lifecycleHost';
import { createLifecycleFaultStore } from './lifecycle/lifecycleFaults';
import type { LifecycleStateStore, ModEnablementMap } from './lifecycle/lifecycleTypes';
import { createNativeLoader } from './native/nativeLoader';
import type { ModFault, ValidatedMod } from './modTypes';
import { setExtensionModules } from '../payload/contributions/extensions';
import { postTurnTracks } from '../turn/tracks';
import { modToComputeTrack } from './computeTrack';
import { emitCoreEvent } from './events';
import { useAppStore } from '../../store/useAppStore';

/**
 * Project 2 / Phase 1.5 — loads installed mods and registers them as
 * contribution modules, compute tracks, and native-tier lifecycle hooks.
 *
 * This is the only place the mod layer meets the payload layer, and it pushes
 * rather than pulls (see `contributions/extensions.ts`). Call `refreshMods()`
 * at app start and again whenever the user installs, edits, or removes a mod
 * file — the server reads disk per request, so no restart is needed on either
 * side.
 *
 * Phase 1.5 wiring:
 *   • The `createNativeLoader` builds the asset URLs and `import()`s them.
 *   • The `createLifecycleHost` owns hook firing, fault containment, and CSS
 *     mount/unmount (via the native loader).
 *   • `refreshMods` runs the load cycle for every enabled mod with a `native`
 *     block, in the loader's resolved order.
 *
 * The lifecycle host and native loader are module-level singletons, created
 * lazily on first `refreshMods`. Tests that need a fresh instance use
 * `vi.resetModules()` and re-import; the `__resetLifecycleHost` seam is
 * exported for the bootstrap tests so they do not have to reach into module
 * state.
 */

let lastResult: { mods: readonly ValidatedMod[]; faults: readonly ModFault[] } = {
    mods: [],
    faults: [],
};

interface LifecycleWiring {
    readonly host: ReturnType<typeof createLifecycleHost>;
    readonly nativeLoader: ReturnType<typeof createNativeLoader>;
    readonly faultStore: ReturnType<typeof createLifecycleFaultStore>;
    readonly stateStore: LifecycleStateStore;
}

let lifecycleWiring: LifecycleWiring | undefined;

/**
 * Lazily create the lifecycle host + native loader. Module-level so a single
 * `latched`/`strikes`/cache state survives across `refreshMods` calls within
 * a session, mirroring the sandbox policy's behaviour (a mod's strikes
 * accumulate across loads until it succeeds or latches).
 */
function getLifecycleWiring(): LifecycleWiring {
    if (lifecycleWiring) return lifecycleWiring;
    const faultStore = createLifecycleFaultStore();
    const nativeLoader = createNativeLoader();
    const stateStore = createIdbLifecycleStateStore();
    const host = createLifecycleHost({
        loadHooks: (mod) => nativeLoader.load(mod),
        stateStore,
        faultStore,
        nativeLoader,
    });
    lifecycleWiring = { host, nativeLoader, faultStore, stateStore };
    return lifecycleWiring;
}

/**
 * `idb-keyval`-backed `LifecycleStateStore`. The same store the settings slice
 * uses, namespaced under `nn_mod_seen_` so a mod's "have I been installed
 * before" record survives across app loads (Phase 1.4 §3 — `install` fires
 * once per mod id, never again). Lazy-imported so this module stays testable
 * without a DOM.
 */
function createIdbLifecycleStateStore(): LifecycleStateStore {
    const keyFor = (modId: string) => `nn_mod_seen_${modId}`;
    return {
        async get(modId) {
            const { get: idbGet } = await import('idb-keyval');
            const value = await idbGet(keyFor(modId));
            if (typeof value === 'object' && value !== null && 'lastSeenVersion' in value) {
                return value as { lastSeenVersion: string };
            }
            return undefined;
        },
        async set(modId, record) {
            const { set: idbSet } = await import('idb-keyval');
            await idbSet(keyFor(modId), record);
        },
        async clear() {
            const { keys: idbKeys, del: idbDel } = await import('idb-keyval');
            const allKeys = await idbKeys();
            for (const key of allKeys) {
                if (typeof key === 'string' && key.startsWith('nn_mod_seen_')) {
                    await idbDel(key);
                }
            }
        },
    };
}

/**
 * The narrow mod view the lifecycle host needs. `LifecycleMod` is a
 * read-only view of `ValidatedMod` carrying only the fields the host reads.
 * `dependencies` is defaulted to `{}` defensively — the loader always sets
 * it, but a test fixture or a future code path might not, and the host's
 * `Object.keys(mod.dependencies)` would throw on `undefined`.
 */
function toLifecycleMod(mod: ValidatedMod): LifecycleMod {
    return {
        id: mod.id,
        name: mod.name,
        version: mod.version,
        file: mod.file,
        dependencies: mod.dependencies ?? {},
        folder: mod.folder,
        native: mod.native,
    };
}

function registerComputeTracks(mods: readonly ValidatedMod[]): void {
    for (const track of postTurnTracks.list()) {
        if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) {
            postTurnTracks.unregister(track.id);
        }
    }
    for (const mod of mods) {
        if (mod.compute && typeof mod.computeSource === 'string') {
            postTurnTracks.register(modToComputeTrack(mod));
        }
    }
}

/**
 * Read the enablement map from the store. `moduleEnabled` is the existing
 * "absent means enabled" map keyed by `mod.<id>` (see `ExtensionsTab.tsx`).
 * Read at call time so a settings change between refreshes takes effect on
 * the next `refreshMods` without re-wiring.
 */
function readEnablement(): ModEnablementMap {
    try {
        return useAppStore.getState().settings?.moduleEnabled ?? {};
    } catch {
        // In tests without a store provider, every mod is enabled (absent
        // means enabled). This path is defensive — the store is wired before
        // `refreshMods` runs in the running app.
        return {};
    }
}

/**
 * Phase 3.2 / `EVENTS.md` §6.1 — `app.ready` fires once per page load, on the
 * FIRST completed `refreshMods()`. Every later completion is `app.modsChanged`.
 * Module-level, like `lifecycleWiring`, so the distinction survives across
 * refreshes within a session; `__resetLifecycleHost` clears it for the tests.
 */
let appReadyEmitted = false;

/**
 * `modIds` is the enabled, successfully-loaded set (§6.1). It is a collection,
 * and it is allowed under the payload rule because there is no mod list anywhere
 * on `ModContext` — a mod cannot read it any other way.
 */
function enabledModIds(mods: readonly ValidatedMod[]): string[] {
    const enablement = readEnablement();
    return mods.filter((mod) => enablement[`mod.${mod.id}`] !== false).map((mod) => mod.id);
}

function emitModSetEvent(mods: readonly ValidatedMod[], faults: readonly ModFault[]): void {
    const payload = { modIds: enabledModIds(mods), faultCount: faults.length };
    if (appReadyEmitted) {
        emitCoreEvent('app.modsChanged', payload);
        return;
    }
    appReadyEmitted = true;
    emitCoreEvent('app.ready', payload);
}

/**
 * Fetch the installed mods and register them.
 *
 * NEVER THROWS. A failure to reach the server, or a malformed response, leaves the previously
 * registered modules in place and is reported as a fault — an unreachable mods endpoint must not
 * be able to stop the app from running turns.
 */
export async function refreshMods(): Promise<{
    mods: readonly ValidatedMod[];
    faults: readonly ModFault[];
}> {
    try {
        const { mods, faults } = await fetchMods();
        setExtensionModules(mods.map(modToContributionModule));
        registerComputeTracks(mods);
        // Phase 1.5 — run the lifecycle load cycle for every enabled mod
        // with a `native` block. The host fires install/update/activate in
        // the loader's resolved order, contains faults per-mod, and mounts
        // CSS for mods whose activate succeeds. The result is best-effort:
        // a faulted lifecycle hook is surfaced in Extensions and does not
        // stop the rest of the refresh.
        try {
            const wiring = getLifecycleWiring();
            const enablement = readEnablement();
            await wiring.host.runLoadCycle({
                mods: mods.map(toLifecycleMod),
                enablement,
            });
        } catch (lifecycleError) {
            // The host itself never throws (it contains faults), but a
            // misconfigured store or wiring could. Surface as a fault and
            // carry on — the rest of the refresh still took effect.
            console.warn('[mods] lifecycle load cycle failed:', lifecycleError);
        }
        lastResult = { mods, faults };
        // Phase 3.2 / `EVENTS.md` §6.1 — the last line of the only function that
        // turns "mods on disk" into "mods running". Emitting earlier would fire
        // before `activate`; later there is no boundary at all, because
        // `refreshMods` is called fire-and-forget from `App.tsx`.
        //
        // The FIRST completed refresh is `app.ready` (sticky, §4.4 — replayed so
        // a mod enabled mid-session can still observe that the app is up); every
        // subsequent one is `app.modsChanged`, which is how a suite mod notices a
        // sibling arrived or left. Its own `activate` cannot tell it about anyone
        // else.
        emitModSetEvent(mods, faults);
    } catch (error) {
        lastResult = {
            mods: lastResult.mods,
            faults: [
                ...lastResult.faults.filter((f) => f.file !== '<loader>'),
                {
                    file: '<loader>',
                    reason: `Could not load mods: ${error instanceof Error ? error.message : String(error)}`,
                },
            ],
        };
    }
    return lastResult;
}

/**
 * Phase 1.5 — enable a mod's native tier. Called by the Extensions screen
 * when the user toggles a native mod on. The host fires `enable` then
 * `activate`, mounts CSS on success, and forgets the cached module on
 * disable (see `lifecycleHost.ts`). The install-time warning from
 * `TRUST.md` §D is Phase 6.1's responsibility, not this layer's.
 */
export async function enableNativeMod(mod: ValidatedMod): Promise<void> {
    const wiring = getLifecycleWiring();
    await wiring.host.enable({ mod: toLifecycleMod(mod) });
    // Phase 3.2 / `EVENTS.md` §11 site 2 — after `host.enable(…)` resolves, so
    // the arriving mod's own `activate` has already run and its listeners are
    // registered by the time its siblings are told it is here.
    emitCoreEvent('app.modsChanged', {
        modIds: enabledModIds(lastResult.mods),
        faultCount: lastResult.faults.length,
    });
}

/**
 * Phase 1.5 — disable a mod's native tier. Called by the Extensions screen
 * when the user toggles a native mod off. The host fires `disable`,
 * unmounts CSS, and forgets the cached module so a re-enable re-imports.
 */
export async function disableNativeMod(mod: ValidatedMod): Promise<void> {
    const wiring = getLifecycleWiring();
    await wiring.host.disable({ mod: toLifecycleMod(mod) });
    // Phase 3.2 / `EVENTS.md` §11 site 3 — after `host.disable(…)` resolves, so
    // the departing mod's listeners are already torn down (`lifecycleHost`'s
    // `disable` calls `modEventBus.disposeModListeners`) and it cannot receive
    // the announcement of its own removal.
    emitCoreEvent('app.modsChanged', {
        modIds: enabledModIds(lastResult.mods),
        faultCount: lastResult.faults.length,
    });
}

/** The last known load result, without re-fetching. For the extensions screen. */
export function getLastModLoad(): { mods: readonly ValidatedMod[]; faults: readonly ModFault[] } {
    return lastResult;
}

/**
 * Test seam: drop the lifecycle wiring so a fresh `refreshMods` creates new
 * singletons. The bootstrap tests use this to assert idempotent registration
 * without leaking module state across cases.
 */
export function __resetLifecycleHost(): void {
    lifecycleWiring = undefined;
    // Phase 3.2 — a fresh wiring is a fresh page load as far as `app.ready` is
    // concerned, so the next `refreshMods` emits `ready` again rather than
    // `modsChanged`.
    appReadyEmitted = false;
}