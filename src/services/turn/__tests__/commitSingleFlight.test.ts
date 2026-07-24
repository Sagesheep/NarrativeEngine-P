/* eslint-disable @typescript-eslint/no-explicit-any */
// Regression: commitPendingTurn must be single-flight.
//
// Four uncoordinated callers reach commitPendingTurn — handleSend,
// setActiveCampaign, reconcilePendingCommitOnLaunch and the Arc Injector. The
// `pendingCommit` / `swipeSet` markers that gate its early return are only
// cleared AFTER `await runPostTurnPipeline`, so two calls overlapping that await
// both saw a live pending message and both appended the SAME turn.
//
// That is not hypothetical: campaign "Three Kingdom: Mandate of Heaven" holds
// scenes 024 and 025 as byte-identical duplicates (same user half, same GM half,
// 489 chars each) produced from one turn — inflating the scene counter and
// making that moment retrievable twice by recall.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage, SwipeVariant } from '../../../types';

import { commitPendingTurn, clearPendingTurnSnapshot } from '../pendingCommit';
import { runPostTurnPipeline } from '../postTurnPipeline';

const storeState = vi.hoisted(() => ({ messages: [] as ChatMessage[] }));
const getStateMock = vi.fn(() => storeState as any);

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => getStateMock(),
        setState: () => {},
    },
}));

// Deferred so both commits are in flight simultaneously.
let releasePipeline: () => void = () => {};
vi.mock('../postTurnPipeline', () => ({
    runPostTurnPipeline: vi.fn(() => new Promise<void>(resolve => { releasePipeline = () => resolve(); })),
}));
vi.mock('../sceneStakesTag', () => ({ classifySceneStakes: vi.fn(async () => 'calm' as const) }));
vi.mock('../aiTier', () => ({ tierAllows: vi.fn(() => false) }));
vi.mock('../../../store/campaignStore', () => ({
    saveCampaignState: vi.fn(async () => {}),
    saveDivergenceRegister: vi.fn(async () => {}),
}));

function installStoreActions(): void {
    (getStateMock as any).mockImplementation(() => ({
        messages: storeState.messages,
        addMessage: () => {}, updateLastAssistant: () => {}, updateLastMessage: () => {},
        updateLastAssistantMessage: () => {}, updateContext: () => {}, updateMessageContent: () => {},
        setArchiveIndex: () => {}, setTimeline: () => {}, setChapters: () => {},
        updateNPC: () => {}, addNPC: () => {}, addNpcSuggestions: () => {},
        setCondensed: () => {}, setStreaming: () => {}, setLastPayloadTrace: () => {},
        setLoadingStatus: () => {}, setPipelinePhase: () => {}, setDivergenceRegister: () => {},
        setOnStageNpcIds: () => {}, archiveNPC: () => {}, restoreNPC: () => {},
        getActiveUtilityEndpoint: () => undefined, getActiveStoryEndpoint: () => undefined,
        context: {}, condenser: { condensedUpToIndex: -1 },
        settings: { aiTier: 'lite', autoCondenseEnabled: false },
        activeCampaignId: 'camp1', divergenceRegister: undefined,
    }));
}

function variant(): SwipeVariant {
    return { id: 'v1', text: 'the GM reply', sceneStakes: 'calm', tagPresent: true };
}
function pendingAssistant(): ChatMessage {
    return {
        id: 'a1', role: 'assistant', content: 'the GM reply', timestamp: 1,
        pendingCommit: true, swipeSet: [variant()], swipeActiveIndex: 0,
    } as ChatMessage;
}

describe('commitPendingTurn — single flight', () => {
    beforeEach(() => {
        storeState.messages = [];
        clearPendingTurnSnapshot();
        installStoreActions();
        vi.clearAllMocks();
        releasePipeline = () => {};
    });
    afterEach(() => {
        clearPendingTurnSnapshot();
        storeState.messages = [];
    });

    it('archives the turn once when two callers commit concurrently', async () => {
        storeState.messages = [
            { id: 'u1', role: 'user', content: 'go north', timestamp: 0 } as ChatMessage,
            pendingAssistant(),
        ];

        // Both callers observe the same live pending message before either clears it.
        const first = commitPendingTurn();
        const second = commitPendingTurn();

        releasePipeline();
        await Promise.all([first, second]);

        expect(runPostTurnPipeline).toHaveBeenCalledTimes(1);
    });

    it('hands concurrent callers the same promise rather than queueing a second commit', () => {
        storeState.messages = [
            { id: 'u1', role: 'user', content: 'go north', timestamp: 0 } as ChatMessage,
            pendingAssistant(),
        ];
        const first = commitPendingTurn();
        const second = commitPendingTurn();
        expect(second).toBe(first);
        releasePipeline();
        return Promise.all([first, second]);
    });

    it('allows a later, genuinely separate commit once the first has settled', async () => {
        storeState.messages = [
            { id: 'u1', role: 'user', content: 'go north', timestamp: 0 } as ChatMessage,
            pendingAssistant(),
        ];
        const first = commitPendingTurn();
        releasePipeline();
        await first;

        storeState.messages = [
            { id: 'u2', role: 'user', content: 'open the door', timestamp: 2 } as ChatMessage,
            { ...pendingAssistant(), id: 'a2' },
        ];
        const second = commitPendingTurn();
        releasePipeline();
        await second;

        expect(runPostTurnPipeline).toHaveBeenCalledTimes(2);
    });
});
