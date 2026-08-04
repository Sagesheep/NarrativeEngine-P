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

// ─── The surface (API.md §3) ────────────────────────────────────────────────

/**
 * The object handed to a mod at every lifecycle hook, compute run, and (Phase
 * 4+) render. The host constructs one per mod per lease; `refresh()` returns
 * a new lease with a fresh model budget.
 */
export interface ModContext {
    readonly mod: ModIdentity;
    readonly api: ModApi;
    readonly data: ModData;
    readonly config: ModConfig;
    readonly write: ModWrites;
    readonly model: ModModel;
    readonly table: ModTables;
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
}

/** `API.md` §4 — frozen, cloned reads. Live values arrive through `subscribe`. */
export interface ModData {
    readonly campaignId: string | null;
    readonly playerInput: string;
    readonly messages: readonly ChatMessage[];
    readonly archiveIndex: readonly ArchiveIndexEntry[];
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