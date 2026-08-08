import { fetchMods } from './modClient';
import { modToContributionModule } from './modAdapter';
import type { LifecycleMod } from './lifecycle/lifecycleHost';
import { createLifecycleHost } from './lifecycle/lifecycleHost';
import { createLifecycleFaultStore } from './lifecycle/lifecycleFaults';
import type { LifecycleStateStore, ModContextFactory, ModEnablementMap } from './lifecycle/lifecycleTypes';
import { createNativeLoader } from './native/nativeLoader';
import type { ModFault, ValidatedMod } from './modTypes';
import { setExtensionModules } from '../payload/contributions/extensions';
import { postTurnTracks } from '../turn/tracks';
import { modToComputeTrack } from './computeTrack';
import { emitCoreEvent } from './events';
import { useAppStore } from '../../store/useAppStore';
import { buildHostFacade } from '../turn/hostFacade';
import { buildCommitCallbacks, rebuildStateFromLiveStore } from '../turn/pendingCommit';
import { buildModContext } from './modContext';

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
function toLifecycleMod(mod: ValidatedMod, loadIndex?: number): LifecycleMod {
    return {
        id: mod.id,
        name: mod.name,
        version: mod.version,
        file: mod.file,
        dependencies: mod.dependencies ?? {},
        folder: mod.folder,
        native: mod.native,
        // Phase 5.2 / MANIFEST.md §6.3 — the resolved load index, which decides
        // prompt-interceptor run order the same way it decides mount order. The
        // load cycle passes the array position; the enable/disable path looks it
        // up from the last known resolved list (`loadIndexOf`).
        loadIndex,
    };
}

/**
 * Phase 5.2 — the mod's position in the last known resolved `mods[]` array.
 * `enableNativeMod` / `disableNativeMod` carry one mod, not the list, so the
 * index has to come from here. Mirrors `buildNativeModContextWithLoadIndex`,
 * which does exactly this for the mount registry.
 */
function loadIndexOf(modId: string): number {
    const index = lastResult.mods.findIndex((mod) => mod.id === modId);
    return index >= 0 ? index : 0;
}

/**
 * Phase 4.0 / `API.md` §8.6 item 3 — build a standing `ModContext` for a
 * native lifecycle hook. The hook fires outside any turn (at app load, or
 * on user toggle), so there is no live `TurnState`/`TurnCallbacks` to build
 * a facade from. The standing facade is reconstructed from the live store
 * the same way the crash-recovery path does (`rebuildStateFromLiveStore`,
 * extracted from `pendingCommit.ts:483`); the callbacks are the same
 * `buildCommitCallbacks` the commit path uses, which read live state at
 * call time. `commitPoint: 'immediate'` — native hooks land writes
 * immediately, not journalled (`API.md` §1.1).
 *
 * `locationState` is read through `getFreshLocationState()`, which
 * `buildCommitCallbacks` wires to `useAppStore.getState()`; without it,
 * `data.location.ledger` is `[]` (`API.md` §4.2).
 *
 * Phase 4.2 / `MOUNTS.md` §3.1 — `loadIndex` is the mod's resolved load
 * index, supplied by the bootstrap when it has the resolved `mods[]` array.
 * The mount registry sorts mod entries by `(loadIndex, withinModIndex)` so
 * a mid-session enable inserts at its proper place (§3.2).
 *
 * Returns `undefined` if the live store cannot be read (e.g. no provider
 * yet) — a mod's `activate` should guard against `undefined` (`MANIFEST.md`
 * §10). This is the stop-condition-respecting design: the standing facade
 * uses the same `TurnCallbacks` the commit path uses, not a null-object
 * shim invented for this path.
 */
function buildNativeModContext(mod: { readonly id: string; readonly name: string; readonly version: string; readonly folder?: string; readonly loadIndex?: number }): ReturnType<ModContextFactory> {
    try {
        const store = useAppStore.getState();
        // The native lifecycle fires outside any turn — there is no
        // `state.input` to recover. The standing facade carries `''` for
        // `playerInput` (the same value `rebuildStateFromLiveStore` defaults
        // to), and a mod that needs the live input reads it through
        // `ctx.subscribe('playerInput')` or awaits a `turn.start` event.
        const state = rebuildStateFromLiveStore(store, '');
        const callbacks = buildCommitCallbacks(state.activeCampaignId ?? '', store);
        const facade = buildHostFacade(state, callbacks, { reactiveStore: useAppStore });
        const freshLocation = callbacks.getFreshLocationState();
        const locationState = freshLocation && freshLocation.activeCampaignId
            ? {
                currentPlaceId: freshLocation.context.currentPlaceId ?? null,
                currentFeature: freshLocation.context.currentFeature ?? null,
                ledger: freshLocation.locationLedger ?? [],
            }
            : undefined;
        return buildModContext({
            mod: { id: mod.id, name: mod.name, version: mod.version, folder: mod.folder },
            facade,
            commitPoint: 'immediate',
            locationState,
            loadIndex: mod.loadIndex,
        });
    } catch (error) {
        // A failure to build the context must not stop the lifecycle. The
        // hook receives `undefined` and a mod that needs state guards.
        console.warn(`[mods] buildNativeModContext failed for ${mod.id}:`, error);
        return undefined;
    }
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
            // Phase 4.0 / `API.md` §8.6 item 3 — pass a per-mod context
            // factory so each native hook receives a `ModContext` whose
            // `mod.id` matches the hook's mod. The factory reads the live
            // store at call time, so a hook fired later in the same load
            // cycle sees the state an earlier hook wrote.
            await wiring.host.runLoadCycle({
                mods: mods.map((mod, index) => toLifecycleMod(mod, index)),
                enablement,
                ctxForMod: buildNativeModContext,
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
 * Build a `ModContextFactory` that closes over the current load index map.
 * The lifecycle host calls the factory per-mod on `enable`/`disable`
 * (mid-session toggles), where the load index is not the array position
 * (those calls carry one mod, not the whole list). The bootstrap computes
 * the map from the last known `mods[]` (resolved order) and the factory
 * reads it, so a mid-session enable inserts at the mod's proper place in
 * the mount registry's sort (`MOUNTS.md` §3.2).
 */
function buildNativeModContextWithLoadIndex(): ModContextFactory {
    const loadIndexMap = new Map<string, number>();
    lastResult.mods.forEach((mod, index) => loadIndexMap.set(mod.id, index));
    return (mod) => buildNativeModContext({
        id: mod.id,
        name: mod.name,
        version: mod.version,
        folder: mod.folder,
        loadIndex: loadIndexMap.get(mod.id) ?? 0,
    });
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
    await wiring.host.enable({ mod: toLifecycleMod(mod, loadIndexOf(mod.id)), ctxForMod: buildNativeModContextWithLoadIndex() });
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
    await wiring.host.disable({ mod: toLifecycleMod(mod, loadIndexOf(mod.id)), ctxForMod: buildNativeModContextWithLoadIndex() });
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