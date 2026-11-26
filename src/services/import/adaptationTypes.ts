/**
 * WO-C §9.3 (order "C2") — the CONTRACT for the optional Living-world adaptation
 * pass. Types only; no logic, no imports beyond types, so the service and the
 * UI can be built and tested independently against it.
 *
 * The pass runs AFTER the import has been persisted (campaign, NPC rows, lore,
 * opening) and BEFORE hydration, so cancellation or failure can never lose an
 * import. It infers provisional wants from bounded card text — nothing else.
 * It never writes `personalityHex` or `traits` (WO-A2 §0), never sees a
 * lorebook, and never performs a web search.
 */
import type { NPCEntry } from '../../types';
import type { STCard } from './stCardTypes';

/** One roster NPC to adapt. `npc` is the already-populated row (pool wants). */
export type AdaptationTarget = {
    id: string;
    name: string;
    card: STCard;
    npc: NPCEntry;
};

export type AdaptedWants = {
    short: string[];
    medium: string[];
    long: string;
};

export type AdaptationStatus = 'adapted' | 'failed' | 'cancelled';

export type AdaptationResult = {
    id: string;
    name: string;
    status: AdaptationStatus;
    /** Present only when `status === 'adapted'`. Already clamped to the limits below. */
    wants?: AdaptedWants;
    /** Short, user-readable reason when `status !== 'adapted'`. */
    error?: string;
};

export type AdaptationProgress = {
    done: number;
    total: number;
    batchIndex: number;
    batchCount: number;
    /** Names in the batch currently in flight. */
    inFlight: string[];
};

export type AdaptationMessage = { role: 'system' | 'user'; content: string };

/**
 * The single model dependency. The service builds messages; the caller (UI)
 * supplies a function that resolves the endpoint chain and speaks to it.
 * Must reject on abort and on transport failure.
 */
export type AdaptationModelCall = (messages: AdaptationMessage[], signal: AbortSignal) => Promise<string>;

export type AdaptationDeps = {
    callModel: AdaptationModelCall;
    onProgress?: (p: AdaptationProgress) => void;
    /** Fires per NPC as soon as its batch resolves, so the UI can show names ticking. */
    onResult?: (r: AdaptationResult) => void;
    signal?: AbortSignal;
};

export type AdaptationRunOpts = {
    /** Stable per-import id; embedded in prompts so batches cannot be confused across imports. */
    importId: string;
    /** Input budget per batch in tokens (extracts only). Default ~1,800. */
    batchTokenBudget?: number;
    /** `AppSettings.matureMode`; when false (default) the prompt forbids mature-tier wants. */
    matureMode?: boolean;
};

/** What the Review step shows next to "Living-world adaptation". */
export type AdaptationEndpointInfo = {
    label: string;
    modelName: string;
};

/** Hard caps applied on arrival (§9.3 "clamp everything"). */
export const ADAPTATION_WANT_LIMITS = Object.freeze({
    shortItems: 4,
    shortChars: 60,
    mediumItems: 3,
    mediumChars: 80,
    longChars: 160,
});

/** Provenance stamped on `NPCEntry.wantsProvenance` by the two writers. */
export type WantsProvenance = 'pool' | 'inferred';
