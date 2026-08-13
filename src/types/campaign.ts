// ─── Campaign / Chat Types ────────────────────────────────────────────────

import type { SceneStakes } from './character';
import type { SceneImageAttachment } from './sceneImage';

/** Swipe Generation v1 — a single generated variant of the latest GM reply.
 *  Lives on the latest assistant ChatMessage.swipeSet while the turn is
 *  pending commit (pendingCommit === true). Cleared on commit. */
export type SwipeVariant = {
    id: string;
    text: string;
    reasoningContent?: string;
    sceneStakes: SceneStakes;
    tagPresent: boolean;
    streaming?: boolean;
};

export type ChatMessage = {
    id: string;
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string;
    displayContent?: string;
    timestamp: number;
    debugPayload?: unknown;
    name?: string;
    tool_calls?: {
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
    }[];
    tool_call_id?: string;
    reasoning_content?: string;
    ephemeral?: boolean;
    divergenceIds?: string[];
    /** WO-F (2be3ad5) — the archive scene id this message's GM reply was archived under.
     *  Set by the post-turn pipeline after archive append. Used by the surgical-delete + edit-sync
     *  UI hooks to map an on-screen message back to its long-term-memory scene. Undefined for
     *  user messages, pre-WO-F saves, and turns that were never archived. */
    sceneId?: string;
    /** Swipe Generation v1 — the set of alternative variants for the latest GM reply.
     *  Present only while the turn is pending commit (pendingCommit === true). Cleared on
     *  commit (the bubble becomes a normal historical message). */
    swipeSet?: SwipeVariant[];
    /** Swipe Generation v1 — true on the latest GM message until the turn is committed
     *  (the user sends the next message, fires the Arc Injector, or switches campaigns).
     *  Drives the 🔄 (RefreshCw) browse-variants UI vs. the destructive Rewind UI. */
    pendingCommit?: boolean;
    /** Swipe Generation v1 — the index of the currently-visible variant in swipeSet. */
    swipeActiveIndex?: number;
    /** Durable-commit v1 — a deferred commit ran for this turn and could NOT archive the
     *  scene (server unreachable / rejected). PERSISTED, unlike `retryable`: it must survive
     *  a restart so the turn can be re-archived later. The turn stays armed (`pendingCommit`
     *  + `swipeSet` are kept) so the next commit retries it; if a new turn buries it first,
     *  `retryFailedCommits()` picks it up on the next launch. Cleared the moment the scene
     *  lands. */
    commitFailed?: boolean;
    /** Smart Retry v1 — ephemeral, never persisted. Story AI failed/aborted; Retry is offered.
     *  The in-memory `PendingTurnSnapshot` captured before the Story AI run backs the Retry
     *  button so it can re-enter generation without regathering. */
    retryable?: boolean;
    /** Smart Retry v1 — ephemeral. Collapsed summary of the gathered precontext. */
    precontext?: { summary: string; capturedPayloadRef?: string };
    /** Inline Scene Image V1 — attachments rendered beneath the source narrative message. */
    attachments?: SceneImageAttachment[];
    /** WO-3 — computed for the Cognitive Process panel only; never assembled into a payload. */
    relationshipStances?: RelationshipStance[];
};

export type Campaign = {
    id: string;
    name: string;
    coverImage: string; // base64 data URL
    createdAt: number;
    lastPlayedAt: number;
};

export type PinnedExcerpt = {
    id: string;
    sourceMessageId: string;
    text: string;
    createdAt: number;
    isFullMessage: boolean;
};

export type RelationshipMemorySource = 'recorded' | 'user' | 'era';

export const RELATIONSHIP_MEMORY_MOODS = [
    'tender', 'companionable', 'triumphant', 'humbling',
    'hostile', 'fraught', 'grave', 'logistical',
] as const;

export const RELATIONSHIP_MEMORY_IMPACTS = [
    'passing', 'remembered', 'formative', 'carried',
] as const;

export type RelationshipMemoryMood = typeof RELATIONSHIP_MEMORY_MOODS[number];
export type RelationshipMemoryImpact = typeof RELATIONSHIP_MEMORY_IMPACTS[number];

export type RelationshipMemoryRecord = {
    sceneId: string;
    subject: string;
    target: string;
    mood: RelationshipMemoryMood;
    impact: RelationshipMemoryImpact;
    /** What the OTHER person did, or what happened. Shared truth — both people in the room
     *  would agree it happened. Optional in TypeScript (legacy records on disk lack it),
     *  required on write. Hard cap 8 words / 60 chars. Distinct from `outcome`, which is
     *  this subject's visible reaction. Do not merge them. */
    event?: string;
    outcome: string;
    carriedNote?: string;
    source: RelationshipMemorySource;
    subjectInferred?: boolean;
    /** Read-time synthetic line produced by WO-6; never written back to the full log. */
    eraId?: string;
    absorbedCount?: number;
};

export type RelationshipMemoryFault = {
    sceneId: string;
    message: string;
};

export type RelationshipMemoryViewRecord = RelationshipMemoryRecord & {
    subjectLabel: string;
    targetLabel: string;
};

/** WO-3 — the stable slots returned by the per-NPC stance reasoning pass. */
export type RelationshipStanceSlots = {
    wantsNow: string;
    hiding: string;
    wont: string;
    inTension: string[];
    believes: string;
    manner: string;
    strain: string;
    considered: string[];
    readRoomAs: string;
};

/** A scored, displayable relationship record used by the stance tuning panel. */
export type RelationshipStanceRecord = RelationshipMemoryRecord & {
    injectionScore: number;
    line: string;
};

/** Scene-specific stance result. It is rendered below the payload cache boundary. */
export type RelationshipStance = {
    npcId: string;
    npcName: string;
    targetName: string;
    sceneId: string;
    sceneKey: string;
    statuses: string;
    nonNegotiables: string;
    tier: 'deep' | 'cheap';
    tierScore: number;
    clashCount: number;
    pinCount: number;
    forcedDeep: boolean;
    topRecords: RelationshipStanceRecord[];
    stance?: RelationshipStanceSlots;
};
