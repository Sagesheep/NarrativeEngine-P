import type { ChatMessage, NPCEntry } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';

/**
 * Project 2 / WO-P2-03 — the post-turn track contract.
 *
 * ┌─ WHY THIS IS NOT `ContributionSpec` ───────────────────────────────────────────────────┐
 * │ `payload/contributions/types.ts` describes a *prompt contribution*: rendered text that  │
 * │ competes for room under a token budget, resolved synchronously while the payload is     │
 * │ assembled. A post-turn track is the opposite shape: scheduled async work that calls a   │
 * │ utility model and writes to a store slice. It has no text, no budget, no ordering       │
 * │ against other contributions, and it cannot be trimmed.                                  │
 * │                                                                                         │
 * │ Forcing one type over both would mean a union with half its fields unused on either     │
 * │ side — the same "knows every feature by name" rot the project exists to remove. They    │
 * │ deliberately stay two types that happen to share the `id / name / toggleable /          │
 * │ defaultEnabled` metadata the extensions screen needs.                                   │
 * └─────────────────────────────────────────────────────────────────────────────────────────┘
 */
export interface PostTurnTrack<Ctx> {
    /** Stable unique id, dot-namespaced: `track.npc`, `track.pressure`. */
    id: string;
    /** Display name for the extensions screen. */
    name: string;
    /** One-line description for the extensions screen. */
    description: string;
    /**
     * Whether the user may switch this track off. Defaults to `true`.
     *
     * A structural track — one whose absence would lose data rather than lose a feature —
     * sets `toggleable: false`, which keeps it out of the extensions screen AND makes the
     * runner ignore the enablement predicate for it, so a corrupt or stale settings entry
     * can never silently disable it.
     */
    toggleable?: boolean;
    /**
     * Whether the track is on for a user who has never touched the extensions screen.
     *
     * Metadata for the UI. The runner does not consult it — enablement is decided by the
     * predicate passed to `start`, whose "absent key means enabled" default already matches
     * `defaultEnabled: true`. Mirrors `ContributionModule.defaultEnabled`.
     */
    defaultEnabled: boolean;
    /**
     * Cheap synchronous pre-check: is there anything for this track to do this turn?
     *
     * Returning `false` means the track is not started at all. It MUST be side-effect free —
     * the runner may call it and then skip. Throwing is contained (see `start`).
     */
    shouldRun(ctx: Ctx): boolean;
    /**
     * Do the work. Rejecting is contained by the caller's `Promise.allSettled`; it must
     * never abort a sibling track or the turn.
     */
    run(ctx: Ctx): Promise<void>;
}

/**
 * Everything the post-turn tracks read, lifted out of `runPostTurnPipeline` unchanged.
 *
 * `displayInput` and `npcLedger` are the same values the pipeline destructures off
 * `state` — they are passed explicitly so each migrated track's body could be moved
 * verbatim, with its original parameter list intact.
 */
export interface PostTurnTrackContext {
    state: TurnState;
    callbacks: TurnCallbacks;
    displayInput: string;
    lastAssistantContent: string;
    allMsgs: ChatMessage[];
    npcLedger: NPCEntry[];
    activeCampaignId: string;
}
