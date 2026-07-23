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
    /** Smart Retry v1 — ephemeral, never persisted. Story AI failed/aborted; Retry is offered.
     *  The in-memory `PendingTurnSnapshot` captured before the Story AI run backs the Retry
     *  button so it can re-enter generation without regathering. */
    retryable?: boolean;
    /** Smart Retry v1 — ephemeral. Collapsed summary of the gathered precontext. */
    precontext?: { summary: string; capturedPayloadRef?: string };
    /** Inline Scene Image V1 — attachments rendered beneath the source narrative message. */
    attachments?: SceneImageAttachment[];
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
