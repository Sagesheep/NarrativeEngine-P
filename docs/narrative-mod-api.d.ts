// Type declarations for the Narrative Engine mod API — `getContext()` v1.
//
// This is the artefact that lets a mod author — human or model — write against
// the surface without reading the app's source. It is the thing that lets an
// AI write a correct mod on the first try, which per the PM is the normal
// authoring path (Phase 2.3 §2.3).
//
// THE ONE RULE: a mod talks to the `ModContext` object. A mod NEVER imports
// from `src/`. If that rule holds, the host can refactor behind the surface
// forever. If it breaks — even once, even for a first-party mod — the store
// becomes a public API and the modularity epic dies a second death.
//
// Nothing enforces this rule at runtime under the trust model. It holds
// because the context is better than the alternative, and because the
// consequence of breaking it is written down here. Accept that.
//
// Versioning: `ctx.api.version` equals the app version. A mod declares the
// version it needs in its manifest `appVersion` field (`">=X.Y.Z"` or `"*"`);
// the loader rejected any mismatch BEFORE any mod code ran, so by the time a
// `ModContext` exists, compatibility was settled. There is no separate
// `apiVersion` and no manifest schema change for this (API.md §2).
//
// This file is type-only. It compiles a mod's TypeScript against the surface
// without dragging in any runtime from the app. A mod's `tsconfig.json` can
// reference it with a `paths` entry:
//
//   {
//     "compilerOptions": {
//       "paths": { "@narrative-engine/mod-api": ["../path/to/narrative-mod-api.d.ts"] }
//     }
//   }
//
// Or a mod may copy this file into its own folder and ship it. The shape is
// frozen for the major version (Phase 9.2 ratifies); additive-only within a
// major version (API.md §9).

// ─── Host types (re-exported so a mod does not need a second .d.ts) ────────

export type AiTier = 'lite' | 'pro' | 'max';

export type ModelRole =
    | 'story'
    | 'utility'
    | 'auxiliary'
    | 'summariser'
    | 'raw-auxiliary'
    | 'raw-summariser';

export interface ModelRequest {
    prompt: string;
    signal?: AbortSignal;
    maxTokens?: number;
    temperature?: number;
    priority?: 'high' | 'normal' | 'low';
    trackingLabel?: string;
    timeoutMs?: number;
}

export interface ModelResponse {
    content: string;
}

export interface ChatMessage {
    id: string;
    role: 'user' | 'assistant' | 'system';
    name?: string;
    content: string;
    timestamp?: number;
}

export interface ArchiveIndexEntry {
    sceneId: string;
    summary?: string;
    importance?: number;
}

/**
 * `API.md` §4.4 — `data.chapters`, a projection of the host's
 * `ArchiveChapter`. The internal-only fields stay internal and refactorable;
 * `sealedAt` is normalised to `number | null` so "which chapter is open"
 * is answerable. **Absent, deliberately:** any chapter write — sealing,
 * elevation and summary depth are core's (`CONTRACT.md` L3).
 */
export interface ModChapter {
    readonly chapterId: string;
    readonly title: string;
    readonly sealedAt: number | null;
    readonly sceneIds: readonly string[];
    readonly summary: string;
}

export interface TimelineEvent {
    sceneId: string;
    summary?: string;
}

export interface NPCEntry {
    id: string;
    name: string;
}

export interface LoreChunk {
    id: string;
    header: string;
    content: string;
}

export interface DivergenceRegister {
    entries: readonly DivergenceEntry[];
    chapterToggles: Record<string, boolean>;
    categoryToggles: Record<string, boolean>;
    lastUpdatedSceneId: string;
    lastUpdatedAt: number;
    version: number;
}

export interface DivergenceEntry {
    id: string;
    chapterId: string;
    category: string;
    text: string;
    sceneRef: string;
    npcIds: string[];
    pinned: boolean;
    source: 'auto' | 'manual';
}

export interface PlayerCharacter {
    id: string;
    name: string;
}

export interface CharacterProfile {
    name: string;
    hp: number;
    stats: {
        str: number;
        dex: number;
        con: number;
        int: number;
        wis: number;
        cha: number;
    };
}

export interface InventoryItem {
    id: string;
    name: string;
    category: string;
    quantity: number;
    description?: string;
    equipped?: boolean;
}

export interface LocationEntry {
    id: string;
    name: string;
    broadLocation: string;
    features: string[];
    firstSeenScene: string;
    lastSeenScene: string;
    source: 'llm' | 'manual';
}

export interface LocationSuggestion {
    name: string;
    connectedTo?: string;
    context?: string;
    firstSeen: number;
}

/** A patch over the host's GameContext. Only `arcDigest` is currently supported. */
export interface GameContextPatch {
    arcDigest?: string;
}

export type SceneStakes = 'low' | 'medium' | 'high' | 'climactic' | 'unknown';

export interface ModEvents {
    'app.ready': { readonly modIds: readonly string[]; readonly faultCount: number; readonly replayed?: true };
    'app.modsChanged': { readonly modIds: readonly string[]; readonly faultCount: number };
    'campaign.opened': { readonly campaignId: string; readonly replayed?: true };
    'campaign.closing': { readonly campaignId: string; readonly nextCampaignId: string | null };
    'turn.start': { readonly turnId: string; readonly campaignId: string | null; readonly playerInput: string; readonly tier: AiTier | undefined };
    'turn.payloadBuilt': { readonly turnId: string; readonly campaignId: string | null; readonly messageCount: number; readonly tokenEstimate: number };
    'turn.generated': { readonly turnId: string; readonly campaignId: string | null; readonly messageId: string; readonly text: string; readonly sceneStakes: SceneStakes };
    'turn.aborted': { readonly turnId: string; readonly campaignId: string | null; readonly messageId: string };
    'turn.failed': { readonly turnId: string; readonly campaignId: string | null; readonly messageId: string; readonly reason: string };
    'turn.committed': { readonly turnId: string | null; readonly campaignId: string; readonly messageId: string; readonly sceneId: string };
    'turn.commitFailed': { readonly turnId: string | null; readonly campaignId: string; readonly messageId: string };
    'message.swiped': { readonly campaignId: string; readonly messageId: string; readonly index: number; readonly total: number; readonly generated: boolean };
    'message.continued': { readonly campaignId: string; readonly messageId: string; readonly addedText: string };
    'message.edited': { readonly campaignId: string; readonly messageId: string; readonly role: 'user' | 'assistant' | 'system' | 'tool'; readonly pending: boolean };
    'message.deleted': { readonly campaignId: string; readonly messageIds: readonly string[] };
    'archive.sceneAppended': { readonly campaignId: string; readonly sceneId: string; readonly messageId: string | null };
    'archive.chapterSealed': { readonly campaignId: string; readonly chapterId: string; readonly title: string; readonly trigger: 'auto' | 'manual' };
    'settings.changed': { readonly changedKeys: readonly string[] };
    'settings.tierChanged': { readonly tier: AiTier | undefined; readonly previous: AiTier | undefined };
    'settings.presetChanged': { readonly presetId: string; readonly name: string };
}

export type CoreEventName = keyof ModEvents;
export type ModScopedEventName = `mod.${string}`;
export type AnyEventName = CoreEventName | ModScopedEventName;
export type ModEventPayload = Readonly<Record<string, unknown>>;
export type PayloadFor<E extends AnyEventName> = E extends CoreEventName ? ModEvents[E] : ModEventPayload;

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

// ─── The surface (API.md §3) ────────────────────────────────────────────────

/**
 * The object handed to a mod at every lifecycle hook, compute run, and (Phase
 * 4+) render. The host constructs one per mod per lease; `refresh()` returns
 * a new lease with a fresh model budget.
 *
 * Phase 4.2 / `MOUNTS.md` §8.1 — `mounts` is the mount-point surface. Six
 * named methods, one per region. Native-tier only: registration needs a
 * callback (a closure), a closure needs a module, and a module is `native.js`
 * — so a sandboxed compute hook's `ctx.mounts` throws "native-tier only"
 * (`MOUNTS.md` §8.1, same ruling `EVENTS.md` §5.1 made for the bus).
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
     * Phase 5.4 — `facts` is the fact publication surface. One method
     * (`register`), per-mod so the host owns the qualification and the
     * teardown on `disable`. Native-tier only: registration needs a
     * closure (the publisher), a closure needs a module, and a module
     * is `native.js` — so `ctx.facts.register` throws "native-tier only"
     * on the worker side.
     */
    readonly facts: ModFactsApi;
    /**
     * Phase 7.4 — `budgets` is the budget claim surface. One method
     * (`claim`), per-mod so the host owns the qualification
     * (`mod.<modId>.<id>`) and the teardown on `disable`. Native-tier only:
     * registration needs a closure (the allocator), a closure needs a
     * module, and a module is `native.js` — so `ctx.budgets.claim` throws
     * "native-tier only" on the worker side.
     */
    readonly budgets: ModBudgetsApi;
    /**
     * Phase 7.4 — `tokens` is the tokenizer surface. One method (`count`),
     * exposing the host's tokenizer (cl100k_base BPE) so a mod can do
     * token-accurate trimming of its own contributions. Native-tier only:
     * the tokenizer is a pure function, but exposing it through the
     * sandbox boundary would require an RPC per call (the `js-tiktoken`
     * encoder cannot be marshalled to a Worker), which is too expensive
     * for the line-by-line trim pattern that needs it — so
     * `ctx.tokens.count` throws "native-tier only" on the worker side.
     */
    readonly tokens: ModTokensApi;
    readonly signal: AbortSignal;
    subscribe<K extends keyof ModData>(key: K, listener: (value: ModData[K]) => void): () => void;
    refresh(): Promise<ModContext>;
    log(...args: unknown[]): void;
}

/** `API.md` §3.1 — the mod's own identity. `folder` is absent on purpose. */
export interface ModIdentity {
    readonly id: string;
    readonly name: string;
    readonly version: string;
}

/** `API.md` §3.2 — the surface itself. `version` equals the app version. */
export interface ModApi {
    readonly version: string;
    /** `'on-return'` for sandboxed compute, `'immediate'` for native hooks/UI. */
    readonly commitPoint: 'immediate' | 'on-return';
    /**
     * Phase 5.3 — the built-in contribution ids a mod may suppress. The
     * complement of the structural ids (`user.message`, `volatile.block`,
     * `askgm.brief`, `absolute.command`), which a mod may NEVER suppress.
     *
     * Advisory, not an enforcement surface: naming an id outside this list
     * that is not protected is still applied verbatim — it simply does
     * nothing because no live contribution carries that id. Naming a
     * protected id is rejected with a reason. Read this to know what the
     * host will actually let you remove.
     *
     * Frozen. The set grows deliberately, governed by the work order's rules;
     * a built-in that nothing can survive without is structural and stays
     * off this list.
     */
    readonly suppressibleIds: readonly string[];
}

/** `API.md` §4 — frozen, cloned reads. Live values arrive through `subscribe`. */
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

/** `API.md` §4.1 — the derived location entry. Whole-replacement write paired. */
export interface ModLocation {
    readonly currentPlaceId: string | null;
    readonly currentFeature: string | null;
    readonly ledger: readonly LocationEntry[];
}

/** `API.md` §4.3 — only `aiTier` is exposed. */
export interface ModConfig {
    readonly aiTier: AiTier | undefined;
}

/**
 * `API.md` §5 — writes. Synchronous and void: the store callbacks are
 * synchronous. A promise here would promise a durability we do not deliver.
 *
 * Whole-replacement writes are paired with their read:
 *   - `setCharacterSheet` ← `data.characterSheet`
 *   - `setInventory` ← `data.inventory`
 *   - `setLocationLedger` ← `data.location.ledger`
 *   - `setDivergenceRegister` ← `data.divergenceRegister`
 *
 * `updateContext` is PROVISIONAL — its only supported key is `arcDigest`,
 * which a mod itself introduced. Phase 5.4 ("mods publish facts") is its
 * replacement. A mod that writes other keys is reaching into host internals
 * the surface deliberately did not publish.
 */
export interface ModWrites {
    /** PROVISIONAL — only `arcDigest` is supported. Replaced by Phase 5.4. */
    updateContext(patch: GameContextPatch): void;
    updateNPC(id: string, patch: Partial<NPCEntry>): void;
    archiveNPC(id: string, turn: number, reason: string): void;
    restoreNPC(id: string): void;
    addNpcSuggestions(names: string[], context?: string): void;
    addMessage(msg: ChatMessage): void;
    updatePlayerCharacter(patch: Partial<PlayerCharacter>): void;
    /** Whole-replacement — pair with `data.characterSheet`. */
    setCharacterSheet(profile: CharacterProfile): void;
    /** Whole-replacement — pair with `data.inventory`. */
    setInventory(items: InventoryItem[]): void;
    /** Whole-replacement — pair with `data.location.ledger`. */
    setLocationLedger(locations: LocationEntry[]): void;
    addLocationSuggestions(suggestions: LocationSuggestion[]): void;
    /** Whole-replacement — pair with `data.divergenceRegister`. */
    setDivergenceRegister(register: DivergenceRegister): void;
}

/** `API.md` §6.1 — model access. Same caps as the sandbox. No credentials. */
export interface ModModel {
    call(role: ModelRole, req: ModelRequest): Promise<ModelResponse>;
    callJson(role: ModelRole, req: ModelRequest, options?: { retries?: number }): Promise<unknown>;
    available(role: ModelRole): boolean;
}

/**
 * `API.md` §6.2 — tables. `name` is the mod's OWN declared table — the object
 * already knows which mod it belongs to. The fully-qualified own name
 * (`'mod.<id>.<name>'`) is accepted as an alias. Cross-mod table access is
 * absent by design; a silent read of another mod's table is a dependency the
 * manifest cannot express and the loader cannot order.
 *
 * `subscribe` is Phase 2.4.
 */
export interface ModTables {
    read(name: string): Promise<unknown>;
    write(name: string, rows: unknown): Promise<void>;
    subscribe(name: string, listener: (rows: unknown) => void): () => void;
}

// ─── Mount points (Phase 4.2 / MOUNTS.md) ───────────────────────────────────
//
// `ctx.mounts` — the mount-point surface. A mod registers its UI from its
// `activate` hook through this object. Six named methods, one per region;
// each returns a `MountHandle` the host also tears down on disable. The
// payload shape genuinely differs per region, so the surface is six names
// rather than one `register(regionId, …)` — an unknown region is a compile
// error in this `.d.ts` rather than a runtime fault.
//
// Native-tier only. Registration needs a callback (a closure), a closure
// needs a module, and a module is `native.js` — a sandboxed compute hook's
// `ctx.mounts` throws "native-tier only" (`MOUNTS.md` §8.1). A suite that
// wants both ships a `native` entry beside its `compute` entry.
//
// See `Upgrade/EPIC Project - Full Modularity/MOUNTS.md` for the full
// contract (regions, ordering, budget, isolation, teardown).

/**
 * The closed `tone` set. Mapped to host tokens by the host; a chrome entry
 * may not specify an arbitrary colour.
 */
export type ChromeTone = 'default' | 'active' | 'warn' | 'danger';

/**
 * The state a chrome entry's optional `state()` returns. Re-read on every
 * render of the row the entry lives in, and on `MountHandle.update()`. Must
 * be cheap and synchronous. Every field is optional; an entry that has no
 * dynamic state returns `undefined` (no `state()` at all).
 */
export interface ChromeState {
    readonly icon?: string;
    readonly label?: string;
    readonly tooltip?: string;
    readonly badge?: number | string;
    readonly active?: boolean;
    readonly disabled?: boolean;
    readonly hidden?: boolean;
    readonly busy?: boolean;
    readonly tone?: ChromeTone;
}

/**
 * A chrome entry. The host renders the element; the mod supplies data and
 * callbacks. `id` is the only field the mod controls that is visible to the
 * host's ordering logic; the host qualifies it to `mod.<modId>.<entryId>`,
 * so two mods cannot collide and a mod cannot impersonate a built-in.
 *
 * `icon` is a lucide name (e.g. `'Swords'`, `'Syringe'`), not a component —
 * the host resolves it, so the entry stays serialisable and the mod's button
 * is visually native. An unknown name is a fault plus a neutral fallback
 * glyph, never a blank button.
 *
 * `label` / `tooltip` run through the host's i18n lookup in the mod's
 * namespace (`mod.<modId>.<key>`). A literal string misses the lookup and
 * renders as itself.
 */
export interface ChromeEntry {
    readonly id: string;
    readonly icon: string;
    readonly label: string;
    readonly tooltip?: string;
    onSelect(ctx: ModContext): void | Promise<void>;
    state?(): ChromeState;
}

/**
 * The handle a registration call returns. `update()` re-reads `state()`
 * (cheap; safe to call from a 2.4 subscription). `remove()` unregisters —
 * also called by the host on disable, so a mod does not need to call it.
 */
export interface MountHandle {
    update(): void;
    remove(): void;
}

/**
 * The mount-point surface. `header` and `composer` are the two chrome rows
 * (Phase 4.2). `messageAction`, `rail`, `messageBelow` and `window` land in
 * 4.3–4.5.
 */
export interface ModMountsApi {
    header(entry: ChromeEntry): MountHandle;
    composer(entry: ChromeEntry): MountHandle;
    messageAction(entry: ChromeEntry): MountHandle;
    rail(panel: RailPanel): MountHandle;
    messageBelow(slot: MessageContentSlot): MountHandle;
    window(win: WindowDeclaration): WindowHandle;
}

/** `MOUNTS.md` §8.3 — content mount shapes (4.3–4.5). */
export interface RailPanel {
    readonly id: string;
    readonly title: string;
    readonly icon?: string;
    mount(node: HTMLElement, ctx: ModContext): void | (() => void);
}

export interface MessageRef {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly sceneId: string | null;
}

export interface MessageContentSlot {
    readonly id: string;
    mount(node: HTMLElement, ctx: ModContext, message: MessageRef): void | (() => void);
}

export interface WindowDeclaration {
    readonly id: string;
    readonly title: string;
    readonly defaultSize: { width: number; height: number };
    readonly minSize?: { width: number; height: number };
    readonly resizable?: boolean;
    mount(node: HTMLElement, ctx: ModContext): void | (() => void);
}

export interface WindowHandle extends MountHandle {
    open(): void;
    close(): void;
    focus(): void;
}

// ─── Macros (Phase 5.1) ────────────────────────────────────────────────────
//
// A mod registers a name and a resolver through `ctx.macros.register()`; the
// host expands `{{name}}` during prompt assembly. The host qualifies the
// name to `mod.<modId>.<name>`, so two mods cannot collide and a mod cannot
// shadow a built-in slot (`{{location}}`, `{{npcs}}`).
//
// Native-tier only — same ruling mounts/events made: registration needs a
// closure (the resolver), a closure needs a module, and a module is
// `native.js`. A sandboxed compute mod cannot hold a closure across to
// prompt assembly, so `ctx.macros.register` throws "native-tier only" on
// the worker side.

/**
 * A macro resolver. Pure and synchronous: it runs during prompt assembly,
 * which is on the hot path of every turn. Reading host state through
 * `ctx.data.*` is fine; mutating or awaiting is not.
 *
 * Returns the string the `{{name}}` slot expands to. Returning `''` is the
 * defined "inactive this turn" path. Throwing is contained: the slot
 * expands to `''` plus a surfaced fault naming the mod.
 */
export type MacroResolver = () => string;

/**
 * `ctx.macros` — the macro registration surface. One method. The host
 * owns the qualification (`mod.<modId>.<name>`) and the teardown on
 * `disable`; the mod is never trusted to call `unregister()`.
 */
export interface ModMacrosApi {
    /**
     * Register a macro. Shadowing a built-in slot (`location`, `npcs`) is
     * rejected with a fault. Never throws: a shadow / duplicate /
     * revoked-lease registration records a fault and returns a no-op
     * `unregister`.
     */
    register(name: string, resolver: MacroResolver): () => void;
}

// ─── The pre-prompt interceptor (Phase 5.2) ────────────────────────────────
//
// A mod names one exported function in its manifest:
//
//   "native": { "js": "index.js", "generateInterceptor": "interceptPrompt" }
//
// The host calls it ONCE PER TURN, after it knows every input the prompt
// consumes and before assembly begins. There is no `ctx.interceptors.
// register()`: the interceptor is declared, not registered, so the host can
// see it without running any code.
//
// What it may do: ADD blocks and SUPPRESS permitted ones. What it may not do:
// rewrite the player's message, edit an existing block's text, or reorder
// assembly. `user.message`, `volatile.block`, `askgm.brief` and
// `absolute.command` are structural and can never be suppressed — naming one
// is refused with a reason in Settings → Extensions, and the rest of your
// interception still lands.
//
// Four rules worth knowing before you write one:
//
//   1. It gets ONE argument, and it is not a `ModContext`. Building a fresh
//      context per turn per mod would clone the message list on the hot path.
//      Subscribe in `activate` (`ctx.subscribe`) and read the closure here.
//   2. It runs under a hard deadline (1.5 s). It is not the place for a model
//      call — compute off the turn path, publish to your own table, read the
//      table here.
//   3. Its output is budgeted like any other mod contribution. Declare a
//      `budget` or take the default.
//   4. It must be deterministic. Two identical turns with the same mods must
//      produce the same payload; the host guarantees run order, you guarantee
//      the rest.
//
// Throwing, hanging, or returning nonsense is contained: the fault is shown in
// Extensions and the turn continues with the un-intercepted payload.

/** The frozen view of the turn's inputs handed to `generateInterceptor`. */
export interface PromptInterceptorInput {
    /** Correlates with the `turn.start` / `turn.committed` event payloads. */
    readonly turnId: string;
    readonly campaignId: string | null;
    readonly tier: string | undefined;
    /**
     * The player's input for this turn, as the prompt will carry it — engine
     * roll, loot and one-shot injections included. `turn.start`'s
     * `playerInput` is the raw pre-injection text; these differ on purpose.
     */
    readonly playerInput: string;
    /** True when the Director produced a Brief for this turn. */
    readonly hasDirectorBrief: boolean;
    /** True when the deterministic watchdog nudge is armed this turn. */
    readonly hasWatchdogNudge: boolean;
    /** True when the player armed an Absolute Command for this turn. */
    readonly hasAbsoluteCommand: boolean;
}

/** One block a mod contributes for this turn. */
export interface PromptContribution {
    /**
     * Bare id — letters, digits, `_` and `-`. The host qualifies it to
     * `mod.<modId>.<id>`, so you cannot collide with a built-in.
     */
    readonly id: string;
    /** The text. `''` means "inactive this turn"; the block is dropped. */
    readonly text: string;
    /**
     * Position in the final user message, ascending. Built-ins are spaced
     * 100…800 (world state 100, CoT 200, Director Brief 300, GM reminder 400,
     * watchdog 500, ask-GM 600, player message 700, absolute command 800), so
     * you can slot between any two. Absent → 0.
     */
    readonly order?: number;
    /** Token ceiling. Absent → the host's default for mod contributions. */
    readonly budget?: number;
}

/** What an interceptor may return. Returning nothing is the quiet path. */
export interface PromptInterception {
    readonly contributions?: readonly PromptContribution[];
    /**
     * Contribution ids to remove from THIS turn's prompt — the point of the
     * hook, since a manifest's `suppresses` is either always on or always off.
     * Naming a structural id is refused with a reason.
     */
    readonly suppress?: readonly string[];
}

/** The function `native.generateInterceptor` names. May be async. */
export type PromptInterceptor = (
    input: PromptInterceptorInput,
) => PromptInterception | null | void | Promise<PromptInterception | null | void>;

// ─── Fact publication (Phase 5.4) ──────────────────────────────────────────
//
// A mod publishes facts that drive `when` conditions — the same four facts
// the host computes (`inCombat`, `location`, `sceneTags`, `onStageNpcNames`).
// The point: when a subsystem leaves core (Phase 8, enemies), the mod that
// owns it can keep publishing `inCombat` so every other mod's
// `when: { inCombat }` keeps working.
//
// A mod claims a core fact by registering a publisher with `claims:
// 'inCombat'`. The host must have opened the name for claims (today only
// `inCombat` is open). Two mods claiming the same fact is a conflict,
// resolved by `loading_order` and surfaced — not silently picked.
//
// Native-tier only — same ruling mounts/macros/interceptors made.
// A throwing publisher is contained: the fact yields no value (no match)
// plus a surfaced fault. The turn never breaks.

/** A fact publisher. Pure and synchronous — runs on the hot path. */
export type FactPublisher = () => unknown;

/**
 * `ctx.facts` — the fact publication surface. One method. The host owns
 * the qualification and the teardown on `disable`; the mod is never
 * trusted to call `unregister()`.
 */
export interface ModFactsApi {
    /**
     * Register a fact publisher.
     *
     * `name` is the fact name. For a namespaced mod fact the host
     * qualifies it to `mod.<modId>.<name>` (not read by `when` today).
     *
     * `claims` is optional. When supplied, it names a core fact this mod
     * is claiming ownership of (e.g. `'inCombat'`). The host must have
     * opened the name for claims. Only ONE mod may claim a given core
     * fact — a second is a conflict, resolved by `loading_order`.
     *
     * Never throws: a shadow / conflict / revoked / bad-args registration
     * records a fault and returns a no-op `unregister`.
     */
    register(name: string, publisher: FactPublisher, options?: { claims?: string }): () => void;
}

// ─── Phase 7.4 — Budget claims and the tokenizer ──────────────────────────
//
// A budget is claimed by id, not hardcoded. Built-in claims (`stable`,
// `world`, `volatile`, `npc`, `enemy`) register at module load; mods claim
// through `ctx.budgets.claim`. The host qualifies the id to
// `mod.<modId>.<id>` so a mod cannot collide with a built-in or another
// mod. The allocator is a pure function of `(limit, remainingAfterRules,
// hasDeepContext)` and runs once per `buildPayload`.
//
// The tokenizer (`ctx.tokens.count`) exposes the host's `countTokens`
// (cl100k_base BPE) so a mod can do token-accurate trimming of its own
// contributions — the priority-trim pattern `fitEnemyRecordsToBudget`
// established. Native-tier only: the encoder cannot be marshalled to a
// Worker, so a sandboxed mod calling `ctx.tokens.count` throws.

/**
 * The inputs every budget allocation function receives. Exactly the three
 * values `computeBudgets` used to compute the five built-in budgets from.
 * A claim that needs none of these ignores the argument entirely.
 */
export interface BudgetAllocationContext {
    /** `settings.contextLimit`, the provider's context window. */
    readonly limit: number;
    /** `limit - rulesBudget`, where `rulesBudget = floor(limit * (rulesBudgetPct ?? 0.10))`. */
    readonly remainingAfterRules: number;
    /** Whether a deep-context summary is present. */
    readonly hasDeepContext: boolean;
}

/** A budget allocation function. Pure: reads only the context and closed-over constants. */
export type BudgetAllocator = (ctx: BudgetAllocationContext) => number;

/**
 * `ctx.budgets` — the budget claim surface. One method. The host owns the
 * qualification and the teardown on `disable`; the mod is never trusted to
 * call `unregister()`.
 */
export interface ModBudgetsApi {
    /**
     * Claim a budget by id. The host qualifies it to `mod.<modId>.<id>`.
     * The allocator runs once per `buildPayload`; its result is exposed
     * through the budget map. Never throws: a shadow (claiming a built-in
     * id), duplicate, revoked, or bad-args registration records a fault
     * and returns a no-op `unregister`.
     */
    claim(
        id: string,
        allocator: BudgetAllocator,
        options?: { name?: string; description?: string },
    ): () => void;
}

/**
 * `ctx.tokens` — the tokenizer surface. One method. Exposes the host's
 * tokenizer (cl100k_base BPE) so a mod can do token-accurate trimming of
 * its own contributions.
 */
export interface ModTokensApi {
    /** Count the tokens in `text` using the host's tokenizer. Returns 0 for empty input. Pure and synchronous. */
    count(text: string): number;
}

// ─── Default-export helper ─────────────────────────────────────────────────
//
// A mod authored in TypeScript can declare its compute hook as:
//
//   import type { ModContext } from '@narrative-engine/mod-api';
//   export default async function myHook(ctx: ModContext): Promise<void> { ... }
//
// The host hands a `ModContext` to the hook at run time; the mod never
// constructs one itself. This default export is the type a mod's `default`
// export should match.

export type ModComputeHook = (ctx: ModContext) => void | Promise<void>;
export type NativeHook = (ctx: ModContext) => void | Promise<void>;