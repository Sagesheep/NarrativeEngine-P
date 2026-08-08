/**
 * Phase 2.3 — `buildModContext(mod, facade)`.
 *
 * The implementation of the `getContext()` v1 surface designed in `API.md` (Phase
 * 2.2). A mod talks to a `ModContext`; a mod NEVER imports from `src/`. The
 * host constructs one `ModContext` per mod per lease and hands it over at every
 * lifecycle hook, compute run, and (Phase 4+) render.
 *
 * This file is a **wrapper over `hostFacade.ts`**, not a parallel implementation
 * (2.3 §2.4). `HostFacade` stays internal and carries fields `ModContext` does
 * not expose; that gap is the point of the exercise. The frozen/cloned reads
 * stay frozen (2.3 §3) — `cloneAndFreeze` in `hostFacade.ts:176` is the existing
 * discipline and it is kept here.
 *
 * The surface is exactly the one in `API.md` §3. No extra fields, no "while we're
 * here" additions. If something is missing, that is a change to `API.md` first.
 *
 * Version: `ctx.api.version` equals the app version. The loader already rejected
 * a mismatch on `appVersion` before any mod code ran (`API.md` §2), so by the
 * time a `ModContext` exists, compatibility was settled.
 */

import type {
    AiTier,
    ArchiveChapter,
    ArchiveIndexEntry,
    CharacterProfile,
    ChatMessage,
    DivergenceRegister,
    GameContext,
    InventoryItem,
    LoreChunk,
    LocationEntry,
    LocationSuggestion,
    NPCEntry,
    PlayerCharacter,
    TimelineEvent,
} from '../../types';
import type {
    HostFacade,
    ModelRequest,
    ModelResponse,
    ModelRole,
} from '../turn/hostFacade';
import { APP_VERSION } from '../../version';
import { SUPPRESSIBLE_BUILTIN_IDS } from '../payload/contributions/builtins';
import { trackModSubscription } from './reactiveReads';
import { reactiveFaultStore, formatReactiveFaultReason } from './reactiveFaults';
import type { AnyEventName, CoreEventName, ModEventOwner, ModEventPayload, ModEvents, ModScopedEventName } from './events';
import { modEventBus } from './events';
import type { ModMountsApi } from './mounts/mountTypes';
import { buildModMountsApi } from './mounts/mountContextMounts';
import type { ModMacrosApi } from './macros/macroTypes';
import { buildModContextMacros } from './macros/macroContextMacros';
import type { ModFactsApi } from './facts/factTypes';
import { buildModContextFacts } from './facts/factContextFacts';

/**
 * `API.md` §3.1 — the mod's own identity, as the host sees it. The object is
 * per-mod so table access resolves to this mod's namespace without the mod
 * naming itself (2.3 §3). `folder` is **absent**: a mod knowing its own disk
 * path is one `fetch` away from reading files the table API deliberately
 * mediates (`CONTRACT.md` permanent prohibitions).
 */
export interface ModIdentity {
    readonly id: string;
    readonly name: string;
    readonly version: string;
}

/**
 * `API.md` §3.2 — the surface itself. `version` equals the app version; the
 * loader rejected any mismatch on `appVersion` before this object exists.
 * `commitPoint` says when writes land — `'on-return'` for sandboxed compute
 * hooks (the journal applies atomically on clean return), `'immediate'` for
 * native hooks and native UI.
 *
 * Phase 5.3 — `suppressibleIds` publishes the built-in contribution ids a mod
 * may suppress. It is the complement of `PROTECTED_SUPPRESSION_IDS` and is
 * derived from the built-in module list (`builtins.ts`'s
 * `SUPPRESSIBLE_BUILTIN_IDS`), so the published set is always exactly what the
 * loader and the arbiter enforce. A mod asks this rather than guessing — the
 * four toggleable blocks today are `writer.cot`, `director.brief`,
 * `gm.reminder`, `watchdog.nudge`, and extending the set is a deliberate
 * decision the work order's §2 item 3 governs.
 */
export interface ModApi {
    readonly version: string;
    readonly commitPoint: 'immediate' | 'on-return';
    /**
     * The built-in contribution ids a mod may suppress this session. Frozen.
     * The loader's `PROTECTED_SUPPRESSION_IDS` is its complement — naming one
     * of those is still rejected with a reason, and the set here is advisory, not
     * an enforcement surface: it tells a mod what it may target.
     */
    readonly suppressibleIds: readonly string[];
}

/**
 * `API.md` §4.4 — `data.chapters`, a projection of the host's
 * `ArchiveChapter` (`src/types/archive.ts:55-76`). The archive/LOD subsystem
 * is the least settled part of the app and freezing `ArchiveChapter`
 * mid-flight is a real cost, so the entry ships as `ModChapter` — the same
 * technique `ModLocation` uses. The internal-only fields (`sceneRange`,
 * `keywords`, `npcs`, `majorEvents`, `unresolvedThreads`, `tone`, `themes`,
 * `sceneCount`, `synopsis`, `abstractTitle`, `literalTitle`,
 * `invalidated`, `_lastSeenSessionId`) stay internal and stay refactorable.
 * `sealedAt` is normalised to `number | null` so "which chapter is open"
 * is answerable without knowing the host spells it as an absent optional.
 *
 * **Absent, deliberately:** any chapter write. Sealing, elevation and
 * summary depth are core's (`CONTRACT.md` L3 "may not touch"), and the
 * archive track is excluded from the registry for data-loss safety. A mod
 * reads chapters; it never seals one.
 */
export interface ModChapter {
    readonly chapterId: string;
    readonly title: string;
    /** Normalised: a sealed chapter has a timestamp; an open one is `null`. */
    readonly sealedAt: number | null;
    /** The chapter's scene range, e.g. `['001', '024']`. */
    readonly sceneIds: readonly string[];
    /** The chapter summary text (may be empty for an unsummarised chapter). */
    readonly summary: string;
}

/**
 * `API.md` §4 — frozen, cloned reads. `cloneAndFreeze` (`hostFacade.ts:176`)
 * is the existing discipline and it stays: a mod must never be able to mutate
 * host state by writing to a read. Live values arrive through `subscribe`
 * (§6.4, Phase 2.4), never by unfreezing this.
 */
export interface ModData {
    readonly campaignId: string | null;
    readonly playerInput: string;
    readonly messages: readonly ChatMessage[];
    readonly archiveIndex: readonly ArchiveIndexEntry[];
    readonly chapters: readonly ModChapter[];
    readonly timeline: readonly TimelineEvent[];
    readonly npcLedger: readonly NPCEntry[];
    readonly onStageNpcIds: readonly string[];
    readonly loreChunks: readonly LoreChunk[];
    readonly divergenceRegister: DivergenceRegister;
    readonly playerCharacter: PlayerCharacter | null;
    readonly characterSheet: CharacterProfile;
    readonly inventory: readonly InventoryItem[];
    readonly location: ModLocation;
}

/**
 * `API.md` §4.1 — the derived `data.location` entry. The only entry not lifted
 * from a `HARVEST.md` gap row; its justification is mechanical: every other
 * whole-replacement write on the surface has a paired read, and
 * `setLocationLedger` was the exception. `currentPlaceId` / `currentFeature`
 * ride along because they are the ledger's cursor (§4.2).
 */
export interface ModLocation {
    readonly currentPlaceId: string | null;
    readonly currentFeature: string | null;
    readonly ledger: readonly LocationEntry[];
}

/**
 * `API.md` §4.3 — `ctx.config`. Only `aiTier` is exposed; the other nine
 * `FacadeConfig` fields (contextLimit, archive/LOD knobs) are absent (§7.5) —
 * a mod's prompt budget is enforced by the host from its manifest `budget`
 * field, so a mod never needs to compute one.
 */
export interface ModConfig {
    readonly aiTier: AiTier | undefined;
}

/**
 * `API.md` §5 — writes. Twelve of `FacadeWrites`' fourteen. Every one goes
 * through the same callback the app itself uses (`hostFacade.ts:298-313`) — no
 * direct store writes, ever (2.3 §3). Whole-replacement writes
 * (`setCharacterSheet`, `setInventory`, `setLocationLedger`,
 * `setDivergenceRegister`) are paired with their reads.
 *
 * Writes on `ctx.write` stay **synchronous and void**: the store callbacks are
 * synchronous (`hostFacade.ts:298-313`) and the journal append is synchronous.
 * A promise there would promise a durability we do not deliver (`API.md` §1.2).
 */
export interface ModWrites {
    updateContext(patch: Partial<GameContext>): void;
    updateNPC(id: string, patch: Partial<NPCEntry>): void;
    archiveNPC(id: string, turn: number, reason: string): void;
    restoreNPC(id: string): void;
    addNpcSuggestions(names: string[], context?: string): void;
    addMessage(msg: ChatMessage): void;
    updatePlayerCharacter(patch: Partial<PlayerCharacter>): void;
    setCharacterSheet(profile: CharacterProfile): void;
    setInventory(items: InventoryItem[]): void;
    setLocationLedger(locations: LocationEntry[]): void;
    addLocationSuggestions(suggestions: LocationSuggestion[]): void;
    setDivergenceRegister(register: DivergenceRegister): void;
}

/**
 * `API.md` §6.1 — model access. Reused wholesale from `hostFacade.ts:128-132`,
 * including role brokering, availability, and the JSON retry. No endpoint, no
 * provider config, no credential ever crosses the surface — `CONTRACT.md`
 * grants no credential or provider-transport capability at any rung.
 *
 * Native mods get the same caps as sandboxed ones (`API.md` §6.1 decision). The
 * accounting unit is the **lease** — one handed-out `ModContext`. `refresh()`
 * returns a new lease with a fresh budget.
 */
export interface ModModel {
    call(role: ModelRole, req: ModelRequest): Promise<ModelResponse>;
    callJson(role: ModelRole, req: ModelRequest, options?: { retries?: number }): Promise<unknown>;
    available(role: ModelRole): boolean;
}

/**
 * `API.md` §6.2 — tables. Confirmed carried over unchanged in grammar and
 * shape, with one scoping decision and one narrowing:
 *
 *   • Scope: the mod's OWN declared tables, and nothing else. `name` is the
 *     bare declared name — `ctx.table.read('arcs')`, not
 *     `ctx.table.read('mod.arc.arcs')` — because the object already knows
 *     which mod it belongs to (2.3 §3). The fully-qualified own name is
 *     ACCEPTED as an alias, so existing capability strings keep working.
 *   • Host table routes leave the surface (`API.md` §8.1) — a narrowing of a
 *     shipped, undocumented surface, for a data-corruption reason.
 *
 * `subscribe` is declared here and implemented in Phase 2.4. It is on the type
 * so Phase 2.4 implements a decision rather than invents one.
 */
export interface ModTables {
    read(name: string): Promise<unknown>;
    write(name: string, rows: unknown): Promise<void>;
    subscribe(name: string, listener: (rows: unknown) => void): () => void;
}

/**
 * Phase 3.3 — events interface on the context object.
 */
export interface ModEventsApi {
    on<E extends CoreEventName>(event: E, listener: (payload: ModEvents[E]) => void): () => void;
    on(event: ModScopedEventName, listener: (payload: ModEventPayload) => void): () => void;
    on(event: AnyEventName, listener: (payload: any) => void): () => void;

    off<E extends CoreEventName>(event: E, listener: (payload: ModEvents[E]) => void): void;
    off(event: ModScopedEventName, listener: (payload: ModEventPayload) => void): void;
    off(event: AnyEventName, listener: (payload: any) => void): void;

    once<E extends CoreEventName>(event: E, listener: (payload: ModEvents[E]) => void): () => void;
    once(event: ModScopedEventName, listener: (payload: ModEventPayload) => void): () => void;
    once(event: AnyEventName, listener: (payload: any) => void): () => void;

    emit(name: string, payload: ModEventPayload): void;
}

/**
 * `API.md` §3 — the full surface handed to a mod.
 *
 * Phase 4.2 / `MOUNTS.md` §8.1 — `mounts` is defined here and implemented in
 * 4.2. Six named methods, one per region, each returning a `MountHandle` the
 * host also tears down on `disable`. Native-tier only: registration needs a
 * callback (a closure), a closure needs a module, and a module is `native.js`
 * (`MOUNTS.md` §8.1 — same ruling `EVENTS.md` §5.1 made for the bus).
 *
 * Phase 5.1 — `macros` is defined here and implemented in 5.1. One method
 * (`register`), per-mod so the host owns the qualification
 * (`mod.<modId>.<name>`) and the teardown on `disable`. Native-tier only:
 * registration needs a closure (the resolver), a closure needs a module,
 * and a module is `native.js` — same ruling mounts/events made. A sandboxed
 * compute mod is handed one snapshot and one journal and cannot hold a
 * closure across to prompt assembly, so the sandbox binding does not
 * construct a `ModMacrosApi` and a call from sandbox code is a `TypeError`.
 */
export interface ModContext {
    readonly mod: ModIdentity;
    readonly api: ModApi;
    readonly data: ModData;
    readonly config: ModConfig;
    readonly write: ModWrites;
    readonly model: ModModel;
    readonly table: ModTables;
    readonly events: ModEventsApi;
    readonly mounts: ModMountsApi;
    readonly macros: ModMacrosApi;
    /**
     * Phase 5.4 — `facts` is defined here and implemented in 5.4. One
     * method (`register`), per-mod so the host owns the qualification
     * (`mod.<modId>.<name>`) and the teardown on `disable`. Native-tier
     * only: registration needs a closure (the publisher), a closure
     * needs a module, and a module is `native.js` — same ruling
     * mounts/macros/events/interceptors made. A sandboxed compute mod is
     * handed one snapshot and one journal and cannot hold a closure
     * across to the next turn, so the sandbox binding does not construct
     * a `ModFactsApi` and a call from sandbox code is a `TypeError`.
     */
    readonly facts: ModFactsApi;
    readonly signal: AbortSignal;
    subscribe<K extends keyof ModData>(key: K, listener: (value: ModData[K]) => void): () => void;
    refresh(): Promise<ModContext>;
    log(...args: unknown[]): void;
}

/**
 * The mod identity a `ModContext` is being built for. A narrow view of
 * `ValidatedMod` carrying only the fields the context reads. The loader always
 * sets `id`/`name`/`version`; `folder` is carried so the per-mod table adapter
 * can resolve the mod's own declared tables through the host's default adapter.
 */
export interface ModContextMod {
    readonly id: string;
    readonly name: string;
    readonly version: string;
    /** The loader-set folder name; used by the default table adapter. */
    readonly folder?: string;
}

/**
 * `API.md` §1.1 — one shape, two commit points. Sandboxed compute hooks land
 * writes on clean return (`'on-return'`); native hooks and native UI land them
 * immediately (`'immediate'`). The context says which, so a mod that reads back
 * what it just wrote knows whether to expect the old or new value
 * (`sandboxTypes.ts:68-73`).
 */
export type ModCommitPoint = 'immediate' | 'on-return';

/**
 * The fully-qualified own-table prefix for a mod: `mod.<modId>.`. A mod's
 * compute capability string is `table:read:mod.<modId>.<name>` today
 * (`mods/arc/compute.js:422`); the per-mod adapter accepts both the bare
 * `<name>` and the fully-qualified `mod.<modId>.<name>` as the same table
 * (`API.md` §6.2).
 */
const OWN_TABLE_PREFIX = 'mod.';

export interface ModContextBuildOptions {
    /**
     * The mod this context is being built for. The object is per-mod, so table
     * access resolves to this mod's namespace without the mod naming itself.
     */
    readonly mod: ModContextMod;
    /**
     * `'on-return'` for sandboxed compute hooks (the journal applies atomically
     * on clean return), `'immediate'` for native hooks and native UI. Defaults
     * to `'immediate'` because native-tier leases are the common case post-1.5.
     */
    readonly commitPoint?: ModCommitPoint;
    /**
     * The host facade this context wraps. Not a parallel implementation: this
     * is `hostFacade.ts`'s output, with the fields `ModContext` does not expose
     * kept internal.
     */
    readonly facade: HostFacade;
    /**
     * The location state read through `TurnCallbacks.getFreshLocationState()`
     * (`turnOrchestrator.ts:33-37`). Populated by the caller that has the
     * callbacks in scope; the facade itself does not reach the callbacks, so
     * the derived `data.location` entry (§4.2) needs this passed in.
     */
    readonly locationState?: {
        readonly currentPlaceId: string | null;
        readonly currentFeature: string | null;
        readonly ledger: readonly LocationEntry[];
    };
    /**
     * Injectable `refresh()` for tests. Production wires this to the
     * facade's `refresh()` plus a fresh `buildModContext` call, so a native mod
     * holding a stale closure has one obvious way to get current (`API.md` §6.3).
     */
    readonly refresh?: () => Promise<ModContext>;
    /**
     * Phase 4.2 / `MOUNTS.md` §3.1 — the mod's resolved load index. The
     * loader returns `mods[]` in resolved order; the registry reads an index
     * it is handed rather than computing one. The mount registry sorts mod
     * entries by `(loadIndex, withinModIndex)` so a mid-session enable
     * inserts at its proper place (§3.2). Default `0` — correct for a
     * single-mod test; production supplies the real index.
     */
    readonly loadIndex?: number;
    /**
     * Phase 4.2 — injectable `mounts` API for tests. Production builds the
     * real `ModMountsApi` from the mod identity and `loadIndex` via
     * `buildModMountsApi`. A test that wants to assert a registration call
     * passes a spy here.
     */
    readonly mounts?: ModMountsApi;
    /**
     * Phase 5.1 — injectable `macros` API for tests. Production builds the
     * real `ModMacrosApi` from the mod identity via
     * `buildModContextMacros`. A test that wants to assert a registration
     * call passes a spy here.
     */
    readonly macros?: ModMacrosApi;
    /**
     * Phase 5.4 — injectable `facts` API for tests. Production builds the
     * real `ModFactsApi` from the mod identity via
     * `buildModContextFacts`. A test that wants to assert a registration
     * call passes a spy here.
     */
    readonly facts?: ModFactsApi;
}

/**
 * Build a per-mod `ModContext` from a `HostFacade`. A wrapper, not a parallel
 * implementation (2.3 §2.4): the facade's `data`/`config`/`write`/`model`/
 * `table`/`signal`/`log` are reused; `ModContext` only narrows the surface.
 *
 * The returned object is `Object.freeze`-d, like the facade. The reads are
 * already frozen by `cloneAndFreeze`; the writes are bound callbacks that
 * cannot be reassigned.
 */
export function buildModContext(options: ModContextBuildOptions): ModContext {
    const { mod, facade } = options;
    const commitPoint: ModCommitPoint = options.commitPoint ?? 'immediate';

    const api: ModApi = Object.freeze({
        version: APP_VERSION,
        commitPoint,
        // Phase 5.3 — publish the suppressible set. Frozen at module load by
        // `builtins.ts`; the freeze here is belt-and-braces so a mod that stashes
        // `ctx.api` cannot mutate the published list through it.
        suppressibleIds: SUPPRESSIBLE_BUILTIN_IDS,
    });

    const identity: ModIdentity = Object.freeze({
        id: mod.id,
        name: mod.name,
        version: mod.version,
    });

    const data: ModData = Object.freeze(buildModData(facade, options.locationState));
    const config: ModConfig = Object.freeze({ aiTier: facade.config.aiTier });
    const write: ModWrites = Object.freeze(buildModWrites(facade));
    const model: ModModel = Object.freeze({
        call: (role: ModelRole, req: ModelRequest) => facade.model.call(role, req),
        callJson: (role: ModelRole, req: ModelRequest, opts?: { retries?: number }) => facade.model.callJson(role, req, opts),
        available: (role: ModelRole) => facade.model.available(role),
    });
    const bindSubscription = (key: string, listener: (value: unknown) => void, source: (notify: (value: unknown) => void) => () => void): (() => void) => {
        let active = true;
        const rawUnsubscribe = source((value) => {
            if (!active) return;
            try {
                listener(value);
            } catch (error) {
                reactiveFaultStore.add({
                    modId: mod.id,
                    key,
                    kind: 'threw',
                    file: `mod:${mod.id}`,
                    reason: formatReactiveFaultReason({
                        modName: mod.name,
                        key,
                        message: error instanceof Error ? error.message : String(error),
                    }),
                });
            }
        });
        const trackedUnsubscribe = trackModSubscription(mod.id, facade.data.activeCampaignId, () => {
            active = false;
            rawUnsubscribe();
        });
        if (facade.signal.aborted) trackedUnsubscribe();
        else facade.signal.addEventListener('abort', trackedUnsubscribe, { once: true });
        return trackedUnsubscribe;
    };

    const table: ModTables = Object.freeze({
        read: (name: string) => facade.table.read(resolveOwnTableName(mod.id, name)),
        write: (name: string, rows: unknown) => facade.table.write(resolveOwnTableName(mod.id, name), rows),
        subscribe: (name: string, listener: (rows: unknown) => void) => {
            const resolved = resolveOwnTableName(mod.id, name);
            const source = facade.table.subscribe
                ? (notify: (value: unknown) => void) => facade.table.subscribe!(resolved, notify)
                : facade.subscribe
                    ? (notify: (value: unknown) => void) => facade.subscribe!(`table:${resolved}`, notify)
                    : undefined;
            if (!source) throw new Error(`[mod:${mod.id}] table.subscribe is implemented in Phase 2.4; live host source unavailable`);
            return bindSubscription(`table:${resolved}`, listener, source);
        },
    });

    const owner: ModEventOwner = Object.freeze({
        modId: mod.id,
        modName: mod.name,
        file: (mod as { file?: string }).file ?? `mod:${mod.id}`,
    });

    const events: ModEventsApi = Object.freeze({
        on: (event: AnyEventName, listener: (payload: any) => void) => {
            const rawUnsubscribe = modEventBus.on(event as any, listener, owner);
            if (facade.signal.aborted) {
                rawUnsubscribe();
                return () => {};
            }
            const onAbort = () => rawUnsubscribe();
            facade.signal.addEventListener('abort', onAbort, { once: true });
            return () => {
                facade.signal.removeEventListener('abort', onAbort);
                rawUnsubscribe();
            };
        },
        off: (event: AnyEventName, listener: (payload: any) => void) => {
            modEventBus.off(event, listener);
        },
        once: (event: AnyEventName, listener: (payload: any) => void) => {
            const rawUnsubscribe = modEventBus.once(event as any, listener, owner);
            if (facade.signal.aborted) {
                rawUnsubscribe();
                return () => {};
            }
            const onAbort = () => rawUnsubscribe();
            facade.signal.addEventListener('abort', onAbort, { once: true });
            return () => {
                facade.signal.removeEventListener('abort', onAbort);
                rawUnsubscribe();
            };
        },
        emit: (name: string, payload: ModEventPayload) => {
            modEventBus.emitFromMod(owner, name, payload);
        },
    });

    const refreshImpl = options.refresh ?? (() => Promise.resolve(buildModContext({
        mod,
        facade: facade.refresh(),
        commitPoint,
        locationState: options.locationState,
        loadIndex: options.loadIndex,
    })));

    // Phase 4.2 / `MOUNTS.md` §8.1 — `ctx.mounts`. Native-tier only: a
    // sandboxed compute hook is handed a snapshot and a journal and cannot
    // hold a closure across a render, so the sandbox binding (Part A of
    // Phase 4.0) does not construct a `ModMountsApi` and this code does not
    // run for it. The real API is built from the mod identity and load index
    // so registrations sort by `(loadIndex, withinModIndex)` (§3.2) and the
    // host owns teardown on disable (§8.5). A test may inject a spy.
    const contextRef: { current: ModContext | undefined } = { current: undefined };
    const mounts: ModMountsApi = options.mounts ?? buildModMountsApi({
        mod: { id: mod.id, name: mod.name },
        loadIndex: options.loadIndex ?? 0,
        faultFile: `mod:${mod.id}`,
        getContext: () => contextRef.current,
    });

    // Phase 5.1 — `ctx.macros`. Native-tier only: a sandboxed compute hook
    // is handed a snapshot and a journal and cannot hold a closure across
    // to prompt assembly, so the sandbox binding (Part A of Phase 4.0) does
    // not construct a `ModMacrosApi` and this code does not run for it. The
    // real API is built from the mod identity so the host owns the
    // qualification (`mod.<modId>.<name>`) and the teardown on `disable`. A
    // test may inject a spy.
    const macros: ModMacrosApi = options.macros ?? buildModContextMacros({
        mod: { id: mod.id, name: mod.name },
        faultFile: `mod:${mod.id}`,
    });

    // Phase 5.4 — `ctx.facts`. Native-tier only: a sandboxed compute hook
    // is handed a snapshot and a journal and cannot hold a closure across
    // to the next turn, so the sandbox binding (Part A of Phase 4.0) does
    // not construct a `ModFactsApi` and this code does not run for it. The
    // real API is built from the mod identity and load index so the host
    // owns the qualification (`mod.<modId>.<name>`) and the teardown on
    // `disable`. A test may inject a spy.
    const facts: ModFactsApi = options.facts ?? buildModContextFacts({
        mod: { id: mod.id, name: mod.name, loadIndex: options.loadIndex ?? 0 },
        faultFile: `mod:${mod.id}`,
    });

    const context: ModContext = Object.freeze({
        mod: identity,
        api,
        data,
        config,
        write,
        model,
        table,
        events,
        mounts,
        macros,
        facts,
        signal: facade.signal,
        subscribe: <K extends keyof ModData>(key: K, listener: (value: ModData[K]) => void) => {
            const source = facade.subscribe;
            if (!source) throw new Error(`[mod:${mod.id}] ctx.subscribe is implemented in Phase 2.4; live host source unavailable`);
            return bindSubscription(String(key), listener as (value: unknown) => void, (notify) => source(String(key), notify));
        },
        refresh: refreshImpl,
        log: (...args: unknown[]) => facade.log(`[mod:${mod.id}]`, ...args),
    });
    contextRef.current = context;
    return context;
}

/**
 * Build the `ModData` view from the facade's `FacadeData`. The facade's data is
 * already frozen by `cloneAndFreeze`; this maps the renamed fields
 * (`activeCampaignId` → `campaignId`, `input` → `playerInput`, the
 * `context.playerCharacter` / `context.inventoryItems` /
 * `characterProfileData` promotions to named entries) and the derived
 * `data.location` entry (§4.2).
 *
 * The whole `GameContext` blob is **not** exposed (§7.1) — publishing it makes
 * the campaign blob a public API and kills the ability to refactor behind the
 * surface. The five fields a measured consumer actually reaches for are
 * promoted to named entries here.
 */
function projectChapter(chapter: ArchiveChapter): ModChapter {
    return {
        chapterId: chapter.chapterId,
        title: chapter.title,
        sealedAt: typeof chapter.sealedAt === 'number' && Number.isFinite(chapter.sealedAt) ? chapter.sealedAt : null,
        sceneIds: chapter.sceneIds ?? [],
        summary: chapter.summary ?? '',
    };
}

function buildModData(
    facade: HostFacade,
    locationState?: {
        readonly currentPlaceId: string | null;
        readonly currentFeature: string | null;
        readonly ledger: readonly LocationEntry[];
    },
): ModData {
    const facadeData = facade.data;
    const context = facadeData.context as GameContext;
    const location: ModLocation = Object.freeze({
        currentPlaceId: locationState?.currentPlaceId ?? context.currentPlaceId ?? null,
        currentFeature: locationState?.currentFeature ?? context.currentFeature ?? null,
        ledger: Object.freeze([...(locationState?.ledger ?? [])]),
    });
    const chapters: readonly ModChapter[] = Object.freeze(
        (facadeData.chapters ?? []).map(projectChapter),
    );
    return {
        campaignId: facadeData.activeCampaignId,
        playerInput: facadeData.input,
        messages: facadeData.messages,
        archiveIndex: facadeData.archiveIndex,
        chapters,
        timeline: facadeData.timeline,
        npcLedger: facadeData.npcLedger,
        onStageNpcIds: facadeData.onStageNpcIds,
        loreChunks: facadeData.loreChunks,
        divergenceRegister: facadeData.divergenceRegister,
        playerCharacter: context.playerCharacter ?? null,
        characterSheet: context.characterProfileData,
        inventory: context.inventoryItems,
        location,
    };
}

/**
 * Build the `ModWrites` view from the facade's `FacadeWrites`. Twelve of the
 * facade's fourteen writes — `addEnemySuggestions` and `onDirectorBriefPhase`
 * are deliberately absent (`API.md` §5.1). The two renamed writes
 * (`setCharacterProfileData` → `setCharacterSheet`, `setInventoryItems` →
 * `setInventory`) map to the same callbacks, so the capability string, the
 * write, and the read all agree (`API.md` §8.2).
 */
function buildModWrites(facade: HostFacade): ModWrites {
    return {
        updateContext: (patch) => facade.write.updateContext(patch),
        updateNPC: (id, patch) => facade.write.updateNPC(id, patch),
        archiveNPC: (id, turn, reason) => facade.write.archiveNPC(id, turn, reason),
        restoreNPC: (id) => facade.write.restoreNPC(id),
        addNpcSuggestions: (names, context) => facade.write.addNpcSuggestions(names, context),
        addMessage: (msg) => facade.write.addMessage(msg),
        updatePlayerCharacter: (patch) => facade.write.updatePlayerCharacter(patch),
        setCharacterSheet: (profile) => facade.write.setCharacterProfileData(profile),
        setInventory: (items) => facade.write.setInventoryItems(items),
        setLocationLedger: (locations) => facade.write.setLocationLedger(locations),
        addLocationSuggestions: (suggestions) => facade.write.addLocationSuggestions(suggestions),
        setDivergenceRegister: (register) => facade.write.setDivergenceRegister(register),
    };
}

/**
 * `API.md` §6.2 — resolve a mod-supplied table name to the namespaced name the
 * host adapter uses. The mod may pass the bare declared name (`'arcs'`) or the
 * fully-qualified own name (`'mod.arc.arcs'`); both resolve to the same table.
 * A name that is not the mod's own (e.g. `'mod.other.arcs'`) is rejected with a
 * mod-named error — cross-mod table access is absent by design (§7.5).
 *
 * The host's default table adapter (`hostFacade.ts:266-289`) routes by the
 * namespaced name; the per-mod resolution here is the only place that knows
 * which mod this context belongs to.
 */
function resolveOwnTableName(modId: string, name: string): string {
    if (typeof name !== 'string' || name.trim() === '') {
        throw new Error(`[mod:${modId}] table name must be a non-empty string`);
    }
    const trimmed = name.trim();
    const ownPrefix = OWN_TABLE_PREFIX + modId + '.';
    if (trimmed.startsWith(ownPrefix)) {
        return trimmed;
    }
    if (trimmed.startsWith(OWN_TABLE_PREFIX)) {
        // A `mod.*` name that is not this mod's own — cross-mod table access.
        throw new Error(`[mod:${modId}] a mod may not reach another mod's tables ("${trimmed}")`);
    }
    return OWN_TABLE_PREFIX + modId + '.' + trimmed;
}

export const createModContext = buildModContext;