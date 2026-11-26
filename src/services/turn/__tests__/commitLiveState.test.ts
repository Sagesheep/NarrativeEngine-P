/* eslint-disable @typescript-eslint/no-explicit-any */
// The commit runs a turn after the snapshot was taken. The turn's own input and
// messages come from the snapshot; the campaign's accumulated state (context,
// NPCs, scenes, on-stage cast) is read live, so the agency tick sees this turn's
// stakes and the digest the prologue just cleared, and the NPC agency fill never
// re-rolls an NPC an earlier commit already filled.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage } from '../../../types';

import { commitPendingTurn, capturePendingTurnSnapshot, clearPendingTurnSnapshot } from '../pendingCommit';
import { runPostTurnPipeline } from '../postTurnPipeline';

const live = vi.hoisted(() => ({ state: {} as any }));

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: { getState: () => live.state, setState: () => {} },
}));
vi.mock('../postTurnPipeline', () => ({
    runPostTurnPipeline: vi.fn(async () => ({ archived: true })),
}));
vi.mock('../sceneStakesTag', () => ({ classifySceneStakes: vi.fn(async () => 'calm' as const) }));
vi.mock('../../../store/campaignStore', () => ({
    saveCampaignState: vi.fn(async () => {}),
    saveDivergenceRegister: vi.fn(async () => {}),
}));

const noop = () => {};
const messages: ChatMessage[] = [
    { id: 'u1', role: 'user', content: 'go north', timestamp: 0 } as ChatMessage,
    {
        id: 'a1', role: 'assistant', content: 'the GM reply', timestamp: 1,
        pendingCommit: true, swipeActiveIndex: 0,
        swipeSet: [{ id: 'v1', text: 'the GM reply', sceneStakes: 'dangerous', tagPresent: true }],
    } as ChatMessage,
];

function liveStore(campaignId: string): any {
    return {
        messages,
        activeCampaignId: campaignId,
        context: { agencyDigest: '', lastSceneStakes: 'dangerous' },
        npcLedger: [{ id: 'n1', name: 'Sanna', populated: true }],
        archiveIndex: [{ sceneId: '012' }],
        onStageNpcIds: ['n1'],
        settings: { aiTier: 'max', autoCondenseEnabled: false },
        condenser: { condensedUpToIndex: -1 },
        addMessage: noop, updateLastAssistant: noop, updateLastMessage: noop,
        updateLastAssistantMessage: noop, updateContext: noop, updateMessageContent: noop,
        setArchiveIndex: noop, setTimeline: noop, setChapters: noop,
        updateNPC: noop, addNPC: noop, addNpcSuggestions: noop,
        setCondensed: noop, setStreaming: noop, setLastPayloadTrace: noop,
        setLoadingStatus: noop, setPipelinePhase: noop, setDivergenceRegister: noop,
        setOnStageNpcIds: noop, archiveNPC: noop, restoreNPC: noop,
        getActiveUtilityEndpoint: () => undefined, getActiveStoryEndpoint: () => undefined,
    };
}

function snapshotTurn(): void {
    // What the turn started with, one commit earlier.
    capturePendingTurnSnapshot({
        input: 'go north',
        displayInput: 'go north',
        activeCampaignId: 'camp1',
        settings: { aiTier: 'max', autoCondenseEnabled: false },
        context: { agencyDigest: 'Bram sold the mill.', lastSceneStakes: 'calm' },
        npcLedger: [{ id: 'n1', name: 'Sanna' }],
        archiveIndex: [{ sceneId: '011' }],
        onStageNpcIds: [],
        condenser: { condensedUpToIndex: -1 },
        getMessages: () => messages,
        getFreshContext: () => live.state.context,
    } as any, [], 'go north');
}

describe('commitPendingTurn — accumulated state is read live', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        clearPendingTurnSnapshot();
    });
    afterEach(() => clearPendingTurnSnapshot());

    it('hands the pipeline the live context, NPCs, scenes and cast, and the snapshot input', async () => {
        live.state = liveStore('camp1');
        snapshotTurn();

        await commitPendingTurn();

        const state = vi.mocked(runPostTurnPipeline).mock.calls[0][0] as any;
        expect(state.context.lastSceneStakes).toBe('dangerous');
        expect(state.context.agencyDigest).toBe('');
        expect(state.npcLedger[0].populated).toBe(true);
        expect(state.archiveIndex).toEqual([{ sceneId: '012' }]);
        expect(state.onStageNpcIds).toEqual(['n1']);
        expect(state.input).toBe('go north');
        expect(state.getMessages()).toEqual(messages);
    });

    it('keeps the snapshot when the campaign has changed', async () => {
        live.state = liveStore('camp2');
        snapshotTurn();

        await commitPendingTurn();

        const state = vi.mocked(runPostTurnPipeline).mock.calls[0][0] as any;
        expect(state.context.agencyDigest).toBe('Bram sold the mill.');
        expect(state.archiveIndex).toEqual([{ sceneId: '011' }]);
    });
});
