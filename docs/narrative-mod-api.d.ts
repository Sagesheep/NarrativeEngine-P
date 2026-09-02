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
// Versioning — TWO axes, two jobs (Phase 9.2):
//
//   • `appVersion` (manifest, `">=X.Y.Z"` or `"*"`) is the FEATURE FLOOR: "I
//     need the build that added `ctx.oocSections`." `ctx.api.version` is the
//     app version it is compared against.
//   • `apiVersion` (manifest, one integer, absent = 1) is the GENERATION the
//     mod was written against. `ctx.api.apiVersion` is the generation this
//     build implements.
//
// Both are settled by the loader BEFORE any mod code runs: a mod whose floor
// is above this app, or whose generation is above this app's, is refused with
// a message naming both numbers. A mod whose generation is BELOW this app's
// loads, flagged in Mod Management.
//
// The promise behind the second number, in full:
//
//   • Inside a generation the surface below is ADDITIVE ONLY. Nothing is
//     removed, renamed, or re-signatured.
//   • A breaking change bumps the generation. THE BUMP IS THE ANNOUNCEMENT.
//     There is no deprecation window and no compatibility shim: mods follow
//     the app, the app does not follow mods.
//   • Nothing outside this file and `docs/MODDING.md` is promised. Everything
//     under `src/` is internal and may change in any release without notice.
//
// See `docs/MODDING.md` §"Compatibility and the frozen surface".
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
// Or a mod may copy this file into its own folder and ship it. **This file is
// the frozen surface.** Phase 9.2 ratified it at mod API generation 1; it is
// additive-only until the generation bumps.

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

/**
 * `API.md` §4.1 — a projection of the host's `NPCEntry` (`src/types/character.ts:177`).
 * The host's type carries ~30 fields, most of which a mod may read; a smaller set
 * a mod may patch through `ctx.write.updateNPC`. The internal-only fields
 * (`previousSnapshot`, `shiftNote`, `shiftTurnCount`, the agency-engine
 * internals, `goalRecords`, `agencyActivity`, `relationMeter`, `fieldTags`,
 * `lastUpdateScene`, `transmigrated`, …) stay internal and refactorable — the
 * same technique `ModChapter` projects `ArchiveChapter` (§4.4).
 *
 * `ctx.data.npcLedger: readonly ModNpcEntry[]` exposes every field below for
 * reads. `ctx.write.updateNPC(id, patch)` accepts a `Partial<ModNpcEntry>`
 * containing any of the **writable** fields marked in the JSDoc on each field
 * of `ModNpcPatch` below. Fields marked read-only on this interface (e.g.
 * `id`, `isPC`) are not patchable through `updateNPC` — the host ignores them
 * or, for a clearly hostile patch, rejects the whole call with a reason.
 *
 * Why a projection rather than the raw type: the host's `NPCEntry` is one of
 * the least settled types in the app (the agency engine adds fields to it
 * nearly every phase). Freezing it in a public API would commit us to
 * compatibility for fields we intend to refactor. The projection exposes what
 * a mod actually needs and keeps the rest refactorable.
 *
 * Phase 9.1 §5.1 — this closes the "two-field shell" gap. The previous
 * `NPCEntry { id, name }` was actively misleading: a mod author who wrote
 * `ctx.write.updateNPC(id, { faction: 'Thieves Guild' })` against the
 * published type hit a type error for a legitimate call.
 */
export interface ModNpcEntry {
    /** Stable id. Read-only — never appears in an `updateNPC` patch. */
    readonly id: string;
    /** Display name. Writable. */
    readonly name: string;
    /** Comma-separated aliases. Writable. */
    readonly aliases: string;
    /** Physical description. Writable. */
    readonly appearance: string;
    /** Faction or group affiliation. Writable. */
    readonly faction: string;
    /** One-line story role / narrative tag. Writable. */
    readonly storyRelevance: string;
    /** Attitude toward the PC, e.g. "friendly", "wary". Writable. */
    readonly disposition: string;
    /** Current state, e.g. "alive", "wounded", "dead", "imprisoned". Writable. */
    readonly status: string;
    /** Stated goals. Writable. */
    readonly goals: string;
    /** Speech / voice description. Writable. */
    readonly voice: string;
    /** Personality description. Writable. */
    readonly personality: string;
    /** Example dialogue output. Writable. */
    readonly exampleOutput: string;
    /** Affinity toward the PC, typically -3..+3. Writable. */
    readonly affinity: number;
    /** Optional portrait URL/data. Writable. */
    readonly portrait?: string;
    /** True if this is the player character. Read-only. */
    readonly isPC?: boolean;
    /** Recurrence tier. Read-only — managed by the host's NPC engine. */
    readonly tier?: 'recurring' | 'oneshot' | 'walkon';
    /** Current condition. Writable. */
    readonly condition?: 'healthy' | 'wounded' | 'critical' | 'dead';
    /** Archived flag. Writable via `archiveNPC` / `restoreNPC`, not `updateNPC`. */
    readonly archived?: boolean;
    /** Turn at which the NPC was archived. Read-only. */
    readonly archivedAtTurn?: number;
    /** Reason for archiving. Read-only (set by `archiveNPC`). */
    readonly archivedReason?: string;
    /** Optional trait tags (<=5). Writable. */
    readonly traits?: string[];
    /** Coarse region tag. Writable. */
    readonly region?: string;
    /** Optional flavour-only location label. Writable. */
    readonly haunt?: string;
    /** Dedicated NPC->PC affinity slot, -3..+3. Writable. */
    readonly pcRelation?: number;
    /** Whether the NPC has been generated yet. Read-only. */
    readonly populated?: boolean;
    /** True = player authors this NPC; agency updates skip. Read-only. */
    readonly agencyLocked?: boolean;
}

/**
 * The subset of `ModNpcEntry` fields a mod may patch through
 * `ctx.write.updateNPC(id, patch: Partial<ModNpcEntry>)`. Documented
 * explicitly because `Partial<ModNpcEntry>` on its own does not say which
 * fields the host honours and which it ignores. Field-by-field:
 *
 * - **Writable:** `name`, `aliases`, `appearance`, `faction`, `storyRelevance`,
 *   `disposition`, `status`, `goals`, `voice`, `personality`, `exampleOutput`,
 *   `affinity`, `portrait`, `condition`, `traits`, `region`, `haunt`,
 *   `pcRelation`.
 * - **Read-only (host-managed):** `id`, `isPC`, `tier`, `archived`,
 *   `archivedAtTurn`, `archivedReason`, `populated`, `agencyLocked`.
 *   Sending one of these in a patch is a no-op for that field, not a fault —
 *   the host drops it silently. To change archived state, call
 *   `archiveNPC(id, turn, reason)` / `restoreNPC(id)`.
 *
 * The internal agency-engine fields (`previousSnapshot`, `shiftNote`,
 * `shiftTurnCount`, `drives`, `behavioralTriggers`, `hardBoundaries`,
 * `softBoundaries`, `pressure`, `wants`, `personalityHex`, `signatureKit`,
 * `skillRung`, `rungCeiling`, `goalRecords`, `agencyActivity`,
 * `repressionPressure`, `relationMeter`, `primaryGroup`, `secondaryGroup`,
 * `fieldTags`, `lastUpdateScene`, `transmigrated`, `pcMeta`) are NOT on this
 * projection. A mod that reaches for them is reaching into internals the
 * surface deliberately did not publish — the same ruling `API.md` §7.1 makes
 * for `GameContext`.
 */
export type ModNpcPatch = Partial<ModNpcEntry>;

/**
 * Legacy alias for `ModNpcEntry`. The shipped `.d.ts` previously declared
 * `NPCEntry { id, name }` only; the 6.9.3 cold-start test (PROGRESS.md §6.9.3
 * gap 1) proved that shell was actively misleading. Phase 9.1 §5.1 replaced
 * it with `ModNpcEntry`. This alias keeps every existing JSDoc
 * `@param {NPCEntry}` reference in shipped mods compiling unchanged.
 */
export type NPCEntry = ModNpcEntry;

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

/** WO 3 / WO 6.2 — a travel mode. The pathfinder accepts foot/cart/mount/boat;
 *  `horseback` maps to `mount` and `flying` routes as a straight line. */
export type TravelMode = 'foot' | 'cart' | 'horseback' | 'flying';

/** WO 6.1 §2 — one hop of a multi-hop route. `legs` is terrain-real when the
 *  route came from the pathfinder. */
export interface TravelHop {
    fromId: string;
    toId: string;
    transitId: string;
    legs: number;
}

/** WO 3 / WO 6.2 — the active journey. The host owns `leg`, `totalLegs`, and
 *  when the journey ends; a mod reads `travel.leg` to draw the party on the
 *  right cell. `null` when no journey is in progress. */
export interface TravelState {
    fromId: string;
    toId: string;
    transitId: string;
    mode: TravelMode;
    /** 1-based: the leg being played this turn. Counts across the whole journey. */
    leg: number;
    totalLegs: number;
    agency: 'free' | 'constrained';
    /** WO 6.1 §2 — per-hop breakdown for a multi-hop journey. Absent for single-hop. */
    hops?: TravelHop[];
    hopIndex?: number;
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
    /**
     * Phase 8.3 — `oocSections` is the Ask-GM section registration surface.
     * One method (`register`), per-mod so the host owns the qualification
     * (`mod.<modId>.<id>`) and the teardown on `disable`. Native-tier only:
     * registration needs a closure (the `build` function), a closure needs a
     * module, and a module is `native.js` — so `ctx.oocSections.register`
     * throws "native-tier only" on the worker side.
     */
    readonly oocSections: ModOocSectionsApi;
    /**
     * Phase 7.1.1 — `roles` is the service-role surface: the one place a mod
     * can REPLACE a core implementation rather than add beside it (`CONTRACT.md`
     * L4). One method (`provide`). Native-tier only: a claim is a closure.
     *
     * **Added to this file by Phase 9.2.** It shipped in 7.1.1 and was left out
     * of the published types, so the one rung of the ladder that lets a mod
     * displace core was undocumentable in a type-clean mod. Enumerating the
     * surface is what found it.
     */
    readonly roles: ModRolesApi;
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
    /** The app version (`package.json`). What `appVersion` is compared against. */
    readonly version: string;
    /**
     * Phase 9.2 — the mod API GENERATION this build implements. One integer,
     * deliberately not the app version: the app version moves for reasons that
     * have nothing to do with this surface.
     *
     * A mod declaring a higher generation was refused at load. A mod declaring
     * a lower one loaded, and may compare against its own declared value here
     * if it wants to degrade deliberately rather than be surprised.
     */
    readonly apiVersion: number;
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
    readonly npcLedger: readonly ModNpcEntry[];
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
    /** WO 6.2 — the active journey, or null/undefined when settled. Read-only;
     *  the host owns `leg`/`totalLegs` and when the journey ends. */
    readonly travel?: TravelState | null;
    /** WO 6.2 — the in-game day counter. Read-only to the mod. */
    readonly worldDay?: number;
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
    /**
     * Patch an NPC by id. The patch is `Partial<ModNpcEntry>` — see
     * `ModNpcPatch` for the writable-field list. Read-only fields
     * (`id`, `isPC`, `tier`, `archived*`, `populated`, `agencyLocked`) are
     * silently dropped by the host. Archiving is through `archiveNPC` /
     * `restoreNPC`, not a patch. Phase 9.1 §5.1 — the previous `Partial<NPCEntry>`
     * against the two-field shell was actively misleading; this is the fix.
     * Sample: `ctx.write.updateNPC(id, { faction: 'Thieves Guild', affinity: -1 })`.
     */
    updateNPC(id: string, patch: ModNpcPatch): void;
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
    /**
     * Phase 8.2 §3 — request a pre-operation backup of the whole campaign.
     * Fires the same POST `/campaigns/:id/backup` with `{ trigger, isAuto:
     * true }` that the host's `preOpBackup` fires for its own delete paths.
     * The host keeps the endpoint, the `isAuto` flag and any rate limiting.
     *
     * Synchronous and void, like every other write on this surface: the
     * POST is fire-and-forget, and a promise here would promise a durability
     * we do not deliver (API.md §1.2). Capability string:
     * `write:requestBackup`.
     */
    requestBackup(trigger: string): void;
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
 * Phase 9.1 §5.3 — `recordShape` → `table.read` return shape, stated
 * explicitly so a mod author does not have to infer it from a fixture:
 *
 * | Manifest `recordShape` | `table.read` returns | `table.write` expects |
 * |------------------------|----------------------|-----------------------|
 * | `"array"` (default)    | the array itself (`unknown[]`); empty table → `[]` | the full replacement array |
 * | `"single-object"`     | the object (`Record<string, unknown>`); empty table → `null` | the full replacement object |
 *
 * `table.write` is wholesale: it replaces whatever the table held. There is
 * no append and no merge; a read-modify-write is the supported pattern. The
 * sandbox binding's `table.read` followed by a `table.write` of the same
 * table in the same run returns the **old** value on read
 * (`sandboxTypes.ts:68-73`, `API.md` §1.1) — the journal applies on clean
 * return. Native bindings commit immediately (`commitPoint: 'immediate'`).
 *
 * A native mod reads and writes its own declared tables through `ctx.table`
 * with **no capability string** (Phase 9.1 §5.2). The `compute.capabilities`
 * allow-list applies to the sandboxed compute hook only.
 *
 * `subscribe` is Phase 2.4.
 */
export interface ModTables {
    /**
     * Read the mod's own declared table. Return shape follows the
     * manifest's `recordShape`: `"array"` → the array (`unknown[]`, `[]` on
     * empty); `"single-object"` → the object (`Record<string, unknown>`,
     * `null` on empty). Promise-returning in both bindings (API.md §1.2).
     *
     * Phase 9.2 (6.9.2 List 2 #6) — `T` defaults to `unknown`, so the
     * un-parameterised call is exactly what it was and existing mods are
     * unaffected. Supplying it gives you your own row type back instead of a
     * hand-cast: the host cannot know your shape, but you can tell it.
     *
     * ```js
     * const marks = await ctx.table.read('marks');            // unknown
     * const rows = await ctx.table.read<Mark[]>('marks');     // Mark[]
     * ```
     *
     * This is a claim, not a check — the host does not validate the table
     * against `T`. Validate anything a user could have hand-edited.
     */
    read<T = unknown>(name: string): Promise<T>;
    /**
     * Wholesale replacement of the table's contents. Pass the array (for
     * `recordShape: "array"`) or the object (for `"single-object"`). See the
     * table above for the shape contract.
     */
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
 * glyph, never a blank button. See `MODDING.md` "Icons" for the exact set
 * and version (Phase 9.1 §5.7).
 *
 * `label` / `tooltip` run through the host's i18n lookup in the mod's
 * namespace (`mod.<modId>.<key>`). A literal string misses the lookup and
 * renders as itself.
 *
 * Phase 9.1 §5.6 — `state()` re-render cadence, stated explicitly so an
 * author knows when `state()` is called and whether to call `handle.update()`
 * from a subscription:
 *
 * - A `header.actions` row re-renders when the host's header component
 *   re-renders (which is whenever the store it reads changes) and on
 *   `handle.update()`. `state()` is called on each render. For a button whose
 *   state depends on a single `ModData` key, subscribe to that key and call
 *   `handle.update()` in the listener — do NOT rely on the host re-rendering
 *   on its own, because the header re-renders on a narrow set of store
 *   changes that may not include yours.
 * - `composer.actions` and `message.actions` follow the same rule for their
 *   respective rows.
 *
 * Sample (the canonical `ctx.subscribe` + `handle.update()` pattern):
 *
 * ```js
 * const handle = ctx.mounts.header({
 *     id: 'compendium', icon: 'Swords', label: 'Enemies',
 *     onSelect: () => openWindow(),
 *     state: () => ({ badge: count }),
 * });
 * ctx.subscribe('messages', () => handle.update());
 * ```
 */
export interface ChromeEntry {
    readonly id: string;
    readonly icon: string;
    readonly label: string;
    readonly tooltip?: string;
    /**
     * Fired on click, with your live `ModContext`.
     *
     * Phase 9.2 — `message` is the row the button was rendered on, and is
     * present ONLY for `ctx.mounts.messageAction` registrations.
     * `ctx.mounts.header` and `ctx.mounts.composer` are not message-scoped and
     * receive `undefined`. Use it to act on THAT message rather than on
     * whatever your mod happens to be tracking.
     */
    onSelect(ctx: ModContext, message?: MessageRef): void | Promise<void>;
    /**
     * Re-read on render and on `handle.update()`.
     *
     * Phase 9.2 — receives the same `MessageRef` as `onSelect` for
     * `messageAction`, so a row's button can be `active` because THAT row
     * qualifies. Without it, one qualifying message lights up every row's
     * button, because the rail renders one button per message from one entry.
     *
     * ```js
     * ctx.mounts.messageAction({
     *     id: 'mark', icon: 'Bookmark', label: 'Mark',
     *     onSelect: (ctx, message) => toggleMark(message.id),
     *     state: (message) => ({ active: message ? marks.has(message.id) : false }),
     * });
     * ```
     */
    state?(message?: MessageRef): ChromeState;
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
    /**
     * Fill the host-owned DOM `node`. The optional return is the mount's
     * teardown.
     *
     * Phase 9.1 §5.4 — the `ctx` handed to `mount(node, ctx)` is the
     * **activate-time lease** the mod's `activate` hook received. It is NOT a
     * fresh lease per mount invocation; the host hands the same context the
     * mod registered with. A mod that needs a fresh lease calls
     * `await ctx.refresh()` inside the mount body, which returns a new
     * `ModContext` with a fresh model budget (API.md §6.3). The activate-time
     * lease is the right default — building one per mount per open would be
     * expensive and the mod already has `refresh()` for the case it needs.
     *
     * Phase 9.1 §5.5 — a subscription created inside `mount()` MUST be
     * returned as the cleanup function, or it lives until the mod is
     * disabled — not until the mount is unmounted. The host removes every
     * subscription the mod registered on `disable` (`lifecycleHost.ts:445`),
     * but a mount that opens and closes repeatedly without returning its
     * unsubscribe accumulates one listener per open for the mod's lifetime.
     * Return them.
     */
    mount(node: HTMLElement, ctx: ModContext): void | (() => void);
}

export interface MessageRef {
    readonly id: string;
    readonly role: 'user' | 'assistant' | 'system' | 'tool';
    readonly sceneId: string | null;
}

export interface MessageContentSlot {
    readonly id: string;
    /**
     * Fill the host-owned DOM `node` for one visible message. The optional
     * return is the slot's teardown. See `RailPanel.mount` for the lease
     * policy (activate-time lease, `ctx.refresh()` for a fresh one) and the
     * subscription cleanup rule (return the unsubscribe, or it leaks until
     * `disable`).
     */
    mount(node: HTMLElement, ctx: ModContext, message: MessageRef): void | (() => void);
}

export interface WindowDeclaration {
    readonly id: string;
    readonly title: string;
    readonly defaultSize: { width: number; height: number };
    readonly minSize?: { width: number; height: number };
    readonly resizable?: boolean;
    /**
     * Fill the host-owned interior `node` of one floating window. The host
     * owns the chrome (title bar, drag, resize, z-order, focus, close). The
     * optional return is the interior's teardown. See `RailPanel.mount` for
     * the lease policy (activate-time lease) and the subscription cleanup
     * rule (return the unsubscribe, or it leaks until `disable`).
     */
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

// ─── The Ask-GM section registry (Phase 8.3) ──────────────────────────────

/**
 * The context handed to an OOC section's `build` function. Read-only.
 */
export interface OocSectionContext {
    readonly question: string;
    readonly recentText: string;
    readonly excerpt: (value: string, max?: number) => string;
    readonly namedIn: (haystack: string, name: string, aliases?: string) => boolean;
}

/** What a section produces. Both fields may be empty. */
export interface OocSectionOutput {
    readonly lines: readonly string[];
    readonly sources: readonly { kind: string; id: string; label: string; excerpt: string }[];
}

/**
 * A registered Ask-GM section. The `id` is qualified to `mod.<modId>.<id>` by
 * the host; the `order` sorts among other registered sections at the
 * extension point (after the ledgers, before the verified facts).
 */
export interface OocSection {
    readonly id: string;
    readonly order: number;
    build(context: OocSectionContext): OocSectionOutput | null | undefined;
}

/**
 * `ctx.oocSections` — the Ask-GM section registration surface. One method.
 * The host owns the qualification and the teardown on `disable`; the mod is
 * never trusted to call `unregister()`.
 */
export interface ModOocSectionsApi {
    /**
     * Register an Ask-GM section. The id is qualified to `mod.<modId>.<id>`
     * by the host. The section's `build` function runs on every Ask-GM call;
     * a throwing section is skipped and the rest of the brief still renders.
     * Never throws: a duplicate / bad-args / revoked registration records a
     * fault and returns a no-op `unregister`.
     */
    register(section: OocSection): () => void;
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

/**
 * A service role id the host publishes. `CONTRACT.md` L4 and `ROLES.md`: a
 * role is "a named ask core makes and consumes an answer to". The host ships
 * exactly one in generation 1.
 *
 * A mod must DECLARE the role in its manifest (`"roles": ["memory.recall"]`)
 * and then PROVIDE it from `activate`. Declaring is not claiming.
 */
export type ServiceRoleId = 'memory.recall';

/** The input `memory.recall` is asked with, and the answer it must return. */
export interface MemoryRecallInput {
    /** The archive index the turn is choosing from. */
    readonly archiveIndex: readonly ArchiveIndexEntry[];
    /** The player's message for this turn. */
    readonly playerInput: string;
}

export interface MemoryRecallAnswer {
    /** Scene ids to recall, in the order they should be considered. */
    readonly sceneIds: readonly string[];
}

/**
 * `ctx.roles` — claim a core implementation (Phase 7.1.1, `ROLES.md`).
 *
 * The rules, all host-owned and none negotiable by a mod:
 *
 * - **Ask-time resolution.** The winner is decided on every ask, so disabling
 *   your mod hands the role back on the very next one — no reload.
 * - **Conflict is resolved by resolved load order**, lowest index wins. The
 *   loser is never asked. The user can flip it from the load-order screen.
 * - **A throwing provider yields NO answer — never core's.** There is no
 *   per-ask fallback: falling back would make a broken claimant indis-
 *   tinguishable from a working one. Three strikes latches your provider off
 *   for the session, and a fault names you in Extensions.
 * - **Teardown is the host's.** The returned function exists for symmetry;
 *   `disable` revokes your claim whether you call it or not.
 *
 * ```js
 * export function onActivate(ctx) {
 *     if (!ctx) return;
 *     ctx.roles.provide('memory.recall', async (input, signal) => {
 *         // Return the answer shape the role validates, or the host discards it.
 *         return { sceneIds: input.archiveIndex.slice(-3).map((s) => s.sceneId) };
 *     });
 * }
 * ```
 */
export interface ModRolesApi {
    /**
     * Claim a role. The `roleId` must be one this mod declared in its manifest
     * `roles` array, or the claim is refused with a fault. An answer that
     * fails the role's own validation is discarded — the ask resolves to
     * nothing, which is not the same as core answering.
     */
    provide(
        roleId: ServiceRoleId,
        ask: (input: MemoryRecallInput, signal: AbortSignal) => unknown,
    ): () => void;
}

export type ModComputeHook = (ctx: ModContext) => void | Promise<void>;
export type NativeHook = (ctx: ModContext) => void | Promise<void>;