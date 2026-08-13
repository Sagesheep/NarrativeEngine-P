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
import type { PromptInterceptionResult } from '../mods/interceptors';
import type { FactPublicationResult } from '../mods/facts';

/**
 * Phase 3.2 — the `turnId` source. A per-session monotonic counter, **not**
 * `uid()`.
 *
 * `EVENTS.md` §7.1 suggests "a `uid()` alongside the existing fields", and that
 * is a defect the Phase 0.2 base-app gate caught on the first run: `uid()` is
 * `Date.now().toString(36) + Math.random()…`, so minting one here consumes a
 * draw from the RNG that `rollEngines` reads two stages later. Every dice
 * outcome in the canonical turn moved. Emitting an event must not change what
 * the app does (3.2 §3), and a correlation key that perturbs the dice is a
 * changed base-app behaviour, not a side effect.
 *
 * A counter is also the better key on the merits: `turnId` only has to correlate
 * `turn.generated` with `turn.committed` inside one page load — the snapshot
 * that carries it is in-memory, and after a crash the id is `null` by
 * construction (§7.1). No clock dependence, no collision window.
 */
let turnCounter = 0;

/**
 * The per-turn working set. Created at `runTurn` entry from `TurnState`,
 * mutated by each stage, consumed by `buildPayload` (as an options object)
 * and the generation/streaming stage.
 */
export type TurnContext = {
    // ── Identity ──────────────────────────────────────────────────────────
    /**
     * Phase 3.2 / `EVENTS.md` §7.1 — the correlation key for the mod event bus.
     * Minted here, carried on the bus, and carried across the commit boundary by
     * the pending snapshot (which already carries the bus).
     *
     * It exists because `turn.generated` and `turn.committed` are separated by an
     * unbounded interval and by at least one other `turn.start` — the commit for
     * turn N normally lands during the send of turn N+1. Without a correlation
     * key a mod that stages work at generation time and finalises it at commit
     * time cannot tell which turn it is finalising.
     *
     * Not read by any product code: nothing in the turn path branches on it, and
     * a Smart Retry re-entry keeps the original id so a mod sees one start and
     * one end per turn however many attempts it took.
     */
    turnId: string;

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

    // ── Prompt interception (set by the interception stage) ───────────────
    /**
     * Phase 5.2 — the pre-prompt interceptor's result for this turn: mod
     * contributions to fold into the final user message, plus the ids they
     * asked the host to suppress. Written by `runPromptInterception` and read
     * by `buildTurnPayload`, one stage later.
     *
     * `undefined` whenever no mod registered a `native.generateInterceptor` —
     * and the orchestrator does not even call the stage in that case, so a
     * zero-interceptor turn does not so much as yield a microtask here. That
     * is what makes the Phase 0.2 base-app gate byte-identical rather than
     * merely equivalent.
     */
    interception?: PromptInterceptionResult;

    // ── Fact publication (set by the publication stage) ────────────────
    /**
     * Phase 5.4 — the fact publisher overlay for this turn: mod-published
     * facts that merge with the host-computed facts before `evaluateWhen`
     * runs. Written by `runFactPublication` and read by
     * `buildTurnPayload`, one stage later.
     *
     * `undefined` whenever no mod registered a fact publisher — and the
     * orchestrator does not even call the stage in that case, so a
     * zero-publisher turn does not so much as yield a microtask here.
     * That is what makes the Phase 0.2 base-app gate byte-identical rather
     * than merely equivalent.
     */
    publishedFacts?: FactPublicationResult;

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
        turnId: `turn_${++turnCounter}`,
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
            relationshipStances: undefined,
        },
    };
}