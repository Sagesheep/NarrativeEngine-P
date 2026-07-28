// WO-P1-01 §4.1 — TurnContext data bus.
//
// A single mutable object threaded through the turn pipeline, replacing the
// `finalInput += …` string-gluing, the ~14 loose vars destructured out of
// `gatherContext`, and (per Q2) the ~29 positional args to `buildPayload`.
//
// This is NOT a parallel shape to TurnState: TurnState is the CALLER-supplied
// snapshot of campaign-level state at turn start; TurnContext is the EVOLVING
// per-turn working set — engine-roll appends, gathered context, the assembled
// payload, watchdog/director nudges, etc. Stages write onto it; downstream
// stages read from it.
//
// Reuses existing value types — declares NO new duplicate types. The
// `GatheredContext` import is the type returned by `gatherContext`; the bus
// folds the whole object in rather than destructuring it into 14 locals.
//
// Location: `src/services/turn/` (client — holds React/Zustand-adjacent
// shapes; NOT `packages/engine` — the bus isn't pure).

import type { GatheredContext } from './contextGatherer';
import type { ElevatedScene } from '../archive-memory/dynamicElevation';
import type { SlottedRagSnippet } from '../archive-memory/slottedRag';
import type { LocationEntry, NPCEntry } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import type { PayloadTrace, DebugSection } from '../../types';

/**
 * The per-turn working set. Created at `runTurn` entry from `TurnState`,
 * mutated by each stage, consumed by `buildPayload` (as an options object)
 * and the generation/streaming stage.
 */
export type TurnContext = {
    // ── Inputs (set at creation from TurnState) ────────────────────────────
    /** The original user input string (before engine-roll appends). */
    input: string;
    /** The original player-facing display input (before engine-roll reveals). */
    displayInput: string;
    /** The location ledger at turn start — lifted from the store ONCE so the
     *  buildPayload call no longer reaches into `useAppStore.getState()`. */
    locationLedger: LocationEntry[];
    /** NPC ledger snapshot at turn start (also on TurnState, mirrored here so
     *  buildPayload options read from a single source). */
    npcLedger: NPCEntry[];

    // ── Evolving state (written by stages) ────────────────────────────────
    /** The accumulated final input string — what becomes the final user-role
     *  message. Replaces the `let finalInput = input; finalInput += …` pattern. */
    finalInput: string;
    /** The accumulated player-facing display string (engine-roll reveals append here). */
    displayInputFinal: string;
    /** The history-capture snapshot of `finalInput` taken before engine-roll
     *  appends, so the synchronous user bubble shows the pre-roll text (mirrors
     *  the existing `historyInput` local). */
    historyInput: string;

    // ── Gathered context (set by the gather stage) ────────────────────────
    /** The full `gatherContext` return — folded in as a unit rather than
     *  destructured into ~14 loose locals. */
    gathered: GatheredContext;

    // ── Director / Watchdog (set by the director stage) ───────────────────
    /** The deterministic watchdog nudge text (or undefined when no nudge). */
    watchdogNudge?: string;
    /** The LLM-authored Director Brief (or undefined on lite tier / failure). */
    directorBrief?: string;

    // ── Payload (set by the build-payload stage) ──────────────────────────
    /** The assembled OpenAIMessage array (the cached + volatile payload). */
    payload?: OpenAIMessage[];
    /** Debug trace from buildPayload (only when settings.debugMode). */
    payloadTrace?: PayloadTrace[];
    /** Debug sections from buildPayload (only when settings.debugMode). */
    payloadDebugSections?: DebugSection[];

    // ── Elevated scenes / slotted RAG (carried from gather to payload) ────
    // These live on `gathered` already; re-exported here as aliases only if
    // a stage needs them without reaching into `gathered`. Kept off the bus
    // for now — `gathered.elevatedScenes` / `gathered.slottedRagSnippets` are
    // the canonical references.
    elevatedScenes?: ElevatedScene[];
    slottedRagSnippets?: SlottedRagSnippet[];
};

/** Create a fresh TurnContext from the caller-supplied turn-start state. */
export function createTurnContext(args: {
    input: string;
    displayInput: string;
    locationLedger: LocationEntry[];
    npcLedger: NPCEntry[];
}): TurnContext {
    return {
        input: args.input,
        displayInput: args.displayInput,
        locationLedger: args.locationLedger,
        npcLedger: args.npcLedger,
        finalInput: args.input,
        displayInputFinal: args.displayInput,
        historyInput: args.input,
        gathered: {
            archiveRecall: undefined,
            recommendedNPCNames: undefined,
            timelineEvents: [],
            relevantLore: undefined,
            semanticArchiveIds: undefined,
            semanticLoreIds: undefined,
            inventoryCategories: undefined,
            profileFields: undefined,
            deepContextSummary: undefined,
            semanticFactText: undefined,
            relevantRules: undefined,
            rulesManifest: undefined,
            elevatedScenes: undefined,
            elevatedSceneRankedIds: undefined,
            slottedRagSnippets: undefined,
        },
    };
}