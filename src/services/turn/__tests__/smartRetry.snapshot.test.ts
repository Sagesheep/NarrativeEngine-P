/* eslint-disable @typescript-eslint/no-explicit-any */
// Smart Retry v1 — Phase 1 invariant tests.
//
// Invariant being frozen: "an orphan early snapshot (captured pre-Story-AI) with
// NO matching pendingCommit message ⇒ commitPendingTurn no-ops AND does NOT wipe
// the live retry payload." This is the safe-to-break invariant documented in the
// work order: a snapshot may now exist for a failed turn (retryable bubble) without
// a corresponding pendingCommit+swipeSet message. commitPendingTurn must leave
// that snapshot alone so the Retry button stays armed.
//
// Also asserts the success-path re-capture overwrites the early capture (idempotent
// singleton), and that the early capture passes the bus.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '../../../types';

// ── Module under test (real, not mocked — we want the real singleton) ──
import * as pendingCommit from '../pendingCommit';

const {
    commitPendingTurn,
    capturePendingTurnSnapshot,
    clearPendingTurnSnapshot,
    getPendingTurnSnapshot,
    findRetryableMessage,
} = pendingCommit;

// ── Store mock — commitPendingTurn reads useAppStore.getState() ──
// We mock the store getter so commitPendingTurn sees whatever messages we feed.
const storeState = vi.hoisted(() => ({ messages: [] as ChatMessage[] }));
const getStateMock = vi.fn(() => storeState);
const setStateMock = vi.fn();

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => getStateMock(),
        setState: (patch: unknown) => setStateMock(patch),
    },
}));

// runPostTurnPipeline is mocked away — commit only runs it past the early return,
// which we never reach in these tests (the invariant is the early-return path).
vi.mock('../postTurnPipeline', () => ({
    runPostTurnPipeline: vi.fn(async () => {}),
}));

// classifySceneStakes + tierAllows are only reached past the early return.
vi.mock('../sceneStakesTag', () => ({
    classifySceneStakes: vi.fn(async () => 'calm' as const),
}));
vi.mock('../aiTier', () => ({
    tierAllows: vi.fn(() => false),
}));

// saveCampaignState — never reached in these tests, mock to be safe.
vi.mock('../../../store/campaignStore', () => ({
    saveCampaignState: vi.fn(async () => {}),
}));

// buildCommitCallbacks reaches into a handful of store action getters; provide no-ops.
function installStoreActions(): void {
    (getStateMock as unknown as { mockImplementation: (fn: () => unknown) => void }).mockImplementation(() => ({
        messages: storeState.messages,
        addMessage: () => {},
        updateLastAssistant: () => {},
        updateLastMessage: () => {},
        updateLastAssistantMessage: () => {},
        updateContext: () => {},
        updateMessageContent: () => {},
        setArchiveIndex: () => {},
        setTimeline: () => {},
        setChapters: () => {},
        updateNPC: () => {},
        addNPC: () => {},
        addNpcSuggestions: () => {},
        setCondensed: () => {},
        setStreaming: () => {},
        setLastPayloadTrace: () => {},
        setLoadingStatus: () => {},
        setPipelinePhase: () => {},
        setDivergenceRegister: () => {},
        setOnStageNpcIds: () => {},
        archiveNPC: () => {},
        restoreNPC: () => {},
        getActiveUtilityEndpoint: () => undefined,
        getActiveStoryEndpoint: () => undefined,
        context: {},
        condenser: { condensedUpToIndex: -1 },
        settings: { aiTier: 'lite' },
        activeCampaignId: 'camp1',
        divergenceRegister: undefined,
    }));
}

function assistantMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: 'a1',
        role: 'assistant',
        content: '',
        timestamp: 1,
        ...overrides,
    } as ChatMessage;
}

describe('Smart Retry v1 — Phase 1 snapshot lifecycle invariant', () => {
    beforeEach(() => {
        storeState.messages = [];
        clearPendingTurnSnapshot();
        installStoreActions();
        vi.clearAllMocks();
    });

    afterEach(() => {
        clearPendingTurnSnapshot();
        storeState.messages = [];
    });

    it('findRetryableMessage returns the latest retryable assistant bubble', () => {
        const msgs: ChatMessage[] = [
            assistantMsg({ id: 'old', content: 'committed', sceneId: 's0' }),
            assistantMsg({ id: 'retry', content: '⚠️ Error', retryable: true }),
        ];
        expect(findRetryableMessage(msgs)?.id).toBe('retry');
    });

    it('findRetryableMessage returns null when the tail assistant is committed (sceneId set)', () => {
        const msgs: ChatMessage[] = [
            assistantMsg({ id: 'old', content: 'committed', sceneId: 's0' }),
        ];
        expect(findRetryableMessage(msgs)).toBeNull();
    });

    it('findRetryableMessage returns null when a user message precedes the tail (pre-turn state)', () => {
        const msgs: ChatMessage[] = [
            { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } as ChatMessage,
            assistantMsg({ id: 'a-no-retry', content: 'ok' }),
        ];
        expect(findRetryableMessage(msgs)).toBeNull();
    });

    it('an orphan early snapshot + no pendingCommit message ⇒ commitPendingTurn no-ops and keeps the snapshot (retry stays armed)', async () => {
        // Capture an early snapshot (simulating the pre-Story-AI capture).
        capturePendingTurnSnapshot(
            { activeCampaignId: 'camp1', getMessages: () => storeState.messages } as any,
            [{ role: 'user', content: 'payload' }] as any,
            'displayInput',
        );
        expect(getPendingTurnSnapshot()).not.toBeNull();

        // Store has a retryable bubble (failed turn) but NO pendingCommit+swipeSet msg.
        storeState.messages = [
            { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } as ChatMessage,
            assistantMsg({ id: 'retry', content: '⚠️ Error', retryable: true }),
        ];

        await commitPendingTurn();

        // The snapshot must survive — the Retry button depends on it.
        expect(getPendingTurnSnapshot()).not.toBeNull();
        // No state mutation happened (early-return path, no commit).
        expect(setStateMock).not.toHaveBeenCalled();
    });

    it('a normal first-turn (no snapshot, no pendingCommit, no retryable) ⇒ commitPendingTurn clears and no-ops', async () => {
        // No snapshot captured. No retryable bubble. No pendingCommit.
        storeState.messages = [
            { id: 'u1', role: 'user', content: 'hi', timestamp: 1 } as ChatMessage,
        ];
        // Put a stale snapshot in place to prove the clear fires.
        capturePendingTurnSnapshot(
            { activeCampaignId: 'camp1', getMessages: () => storeState.messages } as any,
            [{ role: 'user', content: 'stale' }] as any,
            'stale',
        );
        expect(getPendingTurnSnapshot()).not.toBeNull();

        await commitPendingTurn();

        // The clear fires because there is no retryable bubble to guard.
        expect(getPendingTurnSnapshot()).toBeNull();
        expect(setStateMock).not.toHaveBeenCalled();
    });

    it('the early capture and success capture are idempotent (second overwrites the first)', () => {
        capturePendingTurnSnapshot(
            { activeCampaignId: 'camp1', getMessages: () => storeState.messages } as any,
            [{ role: 'user', content: 'early-payload' }] as any,
            'early-display',
        );
        const early = getPendingTurnSnapshot();
        expect(early?.cachedPayload).toEqual([{ role: 'user', content: 'early-payload' }]);

        // Success-path re-capture with the richer payload (tool history).
        capturePendingTurnSnapshot(
            { activeCampaignId: 'camp1', getMessages: () => storeState.messages } as any,
            [{ role: 'user', content: 'rich-payload' }, { role: 'assistant', content: 'tool text' }] as any,
            'early-display',
        );
        const after = getPendingTurnSnapshot();
        // Singleton overwritten — same object identity slot, new content.
        expect(after?.cachedPayload).toEqual([
            { role: 'user', content: 'rich-payload' },
            { role: 'assistant', content: 'tool text' },
        ]);
    });
});