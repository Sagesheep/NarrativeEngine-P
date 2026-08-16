import { fetchMods } from './modClient';
import { clearModData } from './modTables';
import { modToContributionModule } from './modAdapter';
import type { LifecycleMod } from './lifecycle/lifecycleHost';
import { createLifecycleHost } from './lifecycle/lifecycleHost';
import { createLifecycleFaultStore } from './lifecycle/lifecycleFaults';
import type { LifecycleStateStore, ModContextFactory, ModEnablementMap } from './lifecycle/lifecycleTypes';
import { createNativeLoader } from './native/nativeLoader';
import type { ModFault, ValidatedMod } from './modTypes';
import { setExtensionModules } from '../payload/contributions/extensions';
import { registerModTranslations } from '../../i18n';
import { postTurnTracks } from '../turn/tracks';
import { modTierBlocks } from '../turn/aiTier';
import { modToComputeTrack } from './computeTrack';
import { modToTierEntries } from './tierEntryAdapter';
import { emitCoreEvent } from './events';
import { useAppStore } from '../../store/useAppStore';
import { buildHostFacade } from '../turn/hostFacade';
import { buildCommitCallbacks, rebuildStateFromLiveStore } from '../turn/pendingCommit';
import { buildModContext } from './modContext';
import { setRoleModuleEnabled } from '../roles';
import { isModEnabled } from './modEnablement';

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
        dev: mod.dev === true,
        folder: mod.folder,
        native: mod.native,
        roles: mod.roles ?? [],
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
 * `data.location.ledger` is `[]` (`API.md` §4.2). It is passed as a *getter*
 * (`getLocationState`), not a value — this context is long-lived, and a
 * captured value survives `refresh()` and goes stale for the session.
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
function buildNativeModContext(mod: {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    readonly folder?: string;
    readonly loadIndex?: number;
    readonly roles?: readonly string[];
}): ReturnType<ModContextFactory> {
    try {
        const store = useAppStore.getState();
        // The native lifecycle fires outside any turn — there is no
        // `state.input` to recover. The standing facade carries `''` for
        // `playerInput` (the same value `rebuildStateFromLiveStore` defaults
        // to), and a mod that needs the live input reads it through
        // `ctx.subscribe('playerInput')` or awaits a `turn.start` event.
        const state = rebuildStateFromLiveStore(store, '');
        const activeCampaignId = state.activeCampaignId ?? '';
        const callbacks = buildCommitCallbacks(activeCampaignId, store);
        // `getState`/`getCallbacks` let `facade.refresh()` rebuild from the
        // LIVE store. Without them, refresh reuses the snapshot captured here
        // at activate time — so a mod that activated before a campaign was
        // open (empty `data.chapters`, `data.npcLedger`, `data.messages`)
        // would see that empty snapshot on every click forever, even after a
        // campaign loaded. The Arc Engine's "Inject Arc" button is the worked
        // example: `onSelect` reads `modCtx.data.*` and `modCtx.table.read`,
        // and a stale context yields no anchor so the click silently no-ops.
        // `getCallbacks` re-derives from the current `activeCampaignId` so a
        // campaign switch mid-session routes writes to the right campaign.
        const facade = buildHostFacade(state, callbacks, {
            reactiveStore: useAppStore,
            getState: () => {
                const liveStore = useAppStore.getState();
                return rebuildStateFromLiveStore(liveStore, '');
            },
            getCallbacks: () => {
                const liveStore = useAppStore.getState();
                const liveCampaignId = (rebuildStateFromLiveStore(liveStore, '').activeCampaignId) ?? '';
                return buildCommitCallbacks(liveCampaignId, liveStore);
            },
        });
        // Read LIVE, on every build, for the same reason `getState`/
        // `getCallbacks` above are live: this context outlives the moment it
        // was created. The previous code read `locationState` once, here, and
        // handed the value to `buildModContext` — and `refresh()` passed that
        // same captured value through, so `data.location.ledger` was the one
        // field `refresh()` could not refresh. A mod activating before a
        // campaign opened saw an empty ledger for the rest of the session.
        const readLocationState = () => {
            const liveStore = useAppStore.getState();
            const liveCampaignId = rebuildStateFromLiveStore(liveStore, '').activeCampaignId ?? '';
            const fresh = buildCommitCallbacks(liveCampaignId, liveStore).getFreshLocationState?.();
            if (!fresh || !fresh.activeCampaignId) return undefined;
            return {
                currentPlaceId: fresh.context.currentPlaceId ?? null,
                currentFeature: fresh.context.currentFeature ?? null,
                ledger: fresh.locationLedger ?? [],
            };
        };
        return buildModContext({
            mod: { id: mod.id, name: mod.name, version: mod.version, folder: mod.folder },
            facade,
            commitPoint: 'immediate',
            getLocationState: readLocationState,
            loadIndex: mod.loadIndex,
            declaredRoles: mod.roles,
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
 * Phase 7.3 — register mod-declared tier entries from every validated mod.
 *
 * Unlike `registerComputeTracks` (which must filter because `postTurnTracks`
 * holds both built-in and mod tracks), `modTierBlocks` holds ONLY mod entries
 * — built-ins live in the `TIER_BLOCKS` constant in `aiTier.ts`. So a full
 * clear is correct and simpler than filtering: every entry in the registry
 * came from a mod, and re-registration starts from a clean slate.
 *
 * Enablement is a separate layer, exactly as it is for compute tracks: a
 * disabled mod's tier entry stays registered (so the block view can show it)
 * but its automation does not run. `tierAllows` answers the tier gate only;
 * the `moduleEnabled` toggle is consulted elsewhere (§4 "a tier gates
 * automation, not capability").
 */
function registerTierEntries(mods: readonly ValidatedMod[]): void {
    modTierBlocks.clear();
    for (const mod of mods) {
        if (Array.isArray(mod.tierEntries) && mod.tierEntries.length > 0) {
            for (const entry of modToTierEntries(mod)) {
                modTierBlocks.register(entry);
            }
        }
    }
}

/**
 * Phase 6.2 — read the user's load-order override from settings.
 * `settings.modLoadOrder` is a `string[]` of mod ids in the user's chosen
 * order. The server's topological sort uses it as the primary tiebreak;
 * the dependency graph is still a hard constraint. An absent or empty
 * list is the manifest default — `undefined` is returned so the query
 * param is omitted entirely, keeping the zero-mod path unchanged.
 */
function readUserLoadOrder(): string[] | undefined {
    try {
        const order = useAppStore.getState().settings?.modLoadOrder;
        return Array.isArray(order) && order.length > 0 ? [...order] : undefined;
    } catch {
        return undefined;
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
        const enablement = useAppStore.getState().settings?.moduleEnabled ?? {};
        setRoleModuleEnabled(enablement);
        return enablement;
    } catch {
        // In tests without a store provider, every mod is enabled (absent
        // means enabled). This path is defensive — the store is wired before
        // `refreshMods` runs in the running app.
        setRoleModuleEnabled({});
        return {};
    }
}

/**
 * MANIFEST.md §2 — the mods that may register with the prompt-facing
 * registries, given the enablement map.
 *
 * A dev mod is off unless explicitly switched on (`isModEnabled`), and that
 * half of the rule has to hold in places that have never heard of a mod: the
 * payload builder gates contribution modules with a bare
 * `moduleEnabled?.[id] !== false` on a plain string id, and it does so
 * deliberately — `extensions.ts` is emphatic that the payload layer must not
 * import the mod layer. So the filter happens HERE, on the way in, rather than
 * by teaching three downstream registries a rule they should not have to know.
 *
 * NOT the same as filtering by enablement generally. A DISABLED NORMAL MOD IS
 * STILL PUSHED: `registerTierEntries` documents that a disabled mod's tier
 * entry stays registered so the block view can show what it would cost, and the
 * downstream `!== false` gate already reads that case correctly. Only a dev mod
 * is dropped, because it is the only case the downstream rule gets WRONG — an
 * absent entry reads as enabled there and as disabled here.
 *
 * An earlier version of this wrote the default into `settings.moduleEnabled`
 * instead, so every reader would see an explicit `false`. That lost a race:
 * `App.tsx` fires `loadSettings()` and `refreshMods()` in the same tick, and
 * `loadSettings` REPLACES `settings` wholesale rather than merging, so a seed
 * written first was silently discarded. Filtering needs no write and cannot
 * race — with an empty map, a dev mod reads as disabled, which is the answer
 * that map should give.
 */
function promptFacingMods(
    mods: readonly ValidatedMod[],
    enablement: ModEnablementMap,
): ValidatedMod[] {
    return mods.filter((mod) => !mod.dev || isModEnabled(mod, enablement));
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
    return mods.filter((mod) => isModEnabled(mod, enablement)).map((mod) => mod.id);
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
        // Phase 6.2 — pass the user's load-order override so the server's
        // topological sort uses it as the primary tiebreak. The dependency
        // graph is still a hard constraint; the override only reorders mods
        // that are simultaneously ready.
        const userOrder = readUserLoadOrder();
        const { mods, faults } = await fetchMods(userOrder);
        // MANIFEST.md §2 — a switched-off fixture must not reach the prompt.
        // The downstream registries gate on a bare `!== false`, which reads an
        // absent entry as enabled; that is right for a normal mod and wrong for
        // a dev one, so the dev half of the rule is applied here. See
        // `promptFacingMods`. Translations are registered for ALL mods: a
        // string map costs nothing, and registering it unconditionally means a
        // fixture switched on mid-session has its labels before it renders.
        const registrable = promptFacingMods(mods, readEnablement());
        registerModTranslations(mods);
        setExtensionModules(registrable.map(modToContributionModule));
        registerComputeTracks(registrable);
        registerTierEntries(registrable);
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
        roles: mod.roles,
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

/**
 * Phase 6.4 / `DATA_POLICY.md` §3 — the clean action, in the order the
 * contract fixes (`MANIFEST.md` §7.2):
 *
 *   1. the mod's `clean` hook runs, removing data the host does not know it
 *      owns (context keys, caches, anything outside its declared tables);
 *   2. **then the host removes the mod's provisioned tables itself,
 *      unconditionally** — whether `clean` returned, threw, timed out, or was
 *      never declared. A declarative or sandboxed mod cannot declare hooks at
 *      all, and still gets a complete clear;
 *   3. the store drops the mod's in-memory rows so the UI stops serving data
 *      that is no longer on disk.
 *
 * Step 2 does not depend on step 1's result on purpose. A mod that throws in
 * `clean` must not be able to keep its data alive — that would hand a broken
 * mod a veto over the user's decision to erase it.
 *
 * This is the ONLY caller of `clearModData`, and it is reachable only from an
 * explicit user action with a confirmation. It is never called from a toggle,
 * from delete-detection, or from an app update.
 *
 * Throws if the server clear fails: the caller must be able to tell the user
 * the data is still there. A failing `clean` hook does NOT throw — the host
 * contains it as a surfaced fault, as it does everywhere else.
 */
export async function cleanModData(mod: ValidatedMod): Promise<string[]> {
    const wiring = getLifecycleWiring();
    try {
        await wiring.host.clean({
            mod: toLifecycleMod(mod, loadIndexOf(mod.id)),
            ctxForMod: buildNativeModContextWithLoadIndex(),
        });
    } catch (error) {
        // `host.clean` contains its own faults; this catch is for a wiring
        // failure. Either way the host's own clear still has to happen.
        console.warn(`[mods] clean hook failed for ${mod.id}:`, error);
    }
    const campaignId = useAppStore.getState().activeCampaignId;
    if (!campaignId) return [];
    const removed = await clearModData(campaignId, mod.id);
    useAppStore.getState().clearModTables(mod.id);
    return removed;
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
