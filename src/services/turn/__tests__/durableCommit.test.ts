/* eslint-disable @typescript-eslint/no-explicit-any */
// Durable-commit v1 regressions.
//
// The bug: a turn finished, the GM bubble was stamped `pendingCommit` + `swipeSet`,
// and the archive write was deferred to the next send. If the app died or timed out
// first, the in-memory snapshot went with it — and the crash-recovery rebuild
// substituted an EMPTY user input, which the archive endpoint rejects outright
// (400: userContent must be a non-empty string). `api.archive.append` swallowed the
// rejection, the pipeline reported success, and the commit then cleared the markers
// anyway. The scene was never archived and the turn became permanently
// uncommittable: next send, Exit, relaunch and even a backup restore all found no
// marker and no-op'd. Campaign mru5cz53qojl0 lost scene 046 exactly this way.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ChatMessage, SwipeVariant } from '../../../types';

import {
    commitPendingTurn, clearPendingTurnSnapshot, findTurnUserInput, retryFailedCommits,
} from '../pendingCommit';
import { runPostTurnPipeline } from '../postTurnPipeline';


const storeState = vi.hoisted(() => ({ messages: [] as ChatMessage[] }));
const getStateMock = vi.fn(() => storeState as any);
const setArchiveIndexMock = vi.hoisted(() => vi.fn());

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => getStateMock(),
        // Real merge — the commit path reads back what it writes.
        setState: (patch: any) => { Object.assign(storeState, patch); },
    },
}));

const pipelineResult = vi.hoisted(() => ({ archived: true as boolean | 'throw' }));
vi.mock('../postTurnPipeline', () => ({
    runPostTurnPipeline: vi.fn(async () => {
        if (pipelineResult.archived === 'throw') throw new Error('pipeline blew up');
        return { archived: pipelineResult.archived as boolean };
    }),
}));
vi.mock('../sceneStakesTag', () => ({ classifySceneStakes: vi.fn(async () => 'calm' as const) }));
vi.mock('../aiTier', () => ({ tierAllows: vi.fn(() => false) }));
vi.mock('../../../store/campaignStore', () => ({
    saveCampaignState: vi.fn(async () => {}),
    saveDivergenceRegister: vi.fn(async () => {}),
}));
vi.mock('../../../components/Toast', () => ({
    toast: { error: vi.fn(), success: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));
const appendMock = vi.hoisted(() => vi.fn(async () => ({ sceneId: '046' }) as { sceneId: string } | undefined));
vi.mock('../../llm/apiClient', () => ({
    api: {
        archive: {
            append: (...args: unknown[]) => (appendMock as any)(...args),
            getIndex: vi.fn(async () => []),
        },
    },
}));

function installStoreActions(): void {
    (getStateMock as any).mockImplementation(() => ({
        messages: storeState.messages,
        addMessage: () => {}, updateLastAssistant: () => {}, updateLastMessage: () => {},
        updateLastAssistantMessage: () => {}, updateContext: () => {}, updateMessageContent: () => {},
        setArchiveIndex: setArchiveIndexMock, setTimeline: () => {}, setChapters: () => {},
        updateNPC: () => {}, addNPC: () => {}, addNpcSuggestions: () => {},
        setCondensed: () => {}, setStreaming: () => {}, setLastPayloadTrace: () => {},
        setLoadingStatus: () => {}, setPipelinePhase: () => {}, setDivergenceRegister: () => {},
        setOnStageNpcIds: () => {}, archiveNPC: () => {}, restoreNPC: () => {},
        getActiveUtilityEndpoint: () => undefined, getActiveStoryEndpoint: () => undefined,
        context: {}, condenser: { condensedUpToIndex: -1 }, pinnedExcerpts: [],
        settings: { aiTier: 'lite', autoCondenseEnabled: false },
        activeCampaignId: 'camp1', divergenceRegister: undefined,
    }));
}

function variant(): SwipeVariant {
    return { id: 'v1', text: 'the GM reply', sceneStakes: 'calm', tagPresent: true };
}
function pendingAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return {
        id: 'a1', role: 'assistant', content: 'the GM reply', timestamp: 1,
        pendingCommit: true, swipeSet: [variant()], swipeActiveIndex: 0,
        ...overrides,
    } as ChatMessage;
}
function userMsg(overrides: Partial<ChatMessage> = {}): ChatMessage {
    return { id: 'u1', role: 'user', content: 'go north', timestamp: 0, ...overrides } as ChatMessage;
}
const tail = () => storeState.messages[storeState.messages.length - 1];

beforeEach(() => {
    storeState.messages = [];
    clearPendingTurnSnapshot();
    installStoreActions();
    vi.clearAllMocks();
    pipelineResult.archived = true;
    appendMock.mockResolvedValue({ sceneId: '046' });
});
afterEach(() => {
    clearPendingTurnSnapshot();
    storeState.messages = [];
});

describe('findTurnUserInput', () => {
    it('recovers the user half of the pending turn', () => {
        const msgs = [userMsg(), pendingAssistant()];
        expect(findTurnUserInput(msgs, 'a1')).toBe('go north');
    });

    it('prefers displayContent — the player-facing text the live path archives', () => {
        const msgs = [userMsg({ content: 'go north<injected directive>', displayContent: 'go north' }), pendingAssistant()];
        expect(findTurnUserInput(msgs, 'a1')).toBe('go north');
    });

    it('does not reach back into an already-committed turn', () => {
        const msgs = [
            userMsg({ id: 'u0', content: 'older turn' }),
            { id: 'a0', role: 'assistant', content: 'older reply', timestamp: 0, sceneId: '045' } as ChatMessage,
            pendingAssistant(),
        ];
        expect(findTurnUserInput(msgs, 'a1')).toBe('');
    });
});

describe('commitPendingTurn — crash recovery without an in-memory snapshot', () => {
    it('archives with the recovered user text instead of an empty string', async () => {
        // No capturePendingTurnSnapshot() — this is the post-restart state.
        storeState.messages = [userMsg({ displayContent: 'i shrug lightly' }), pendingAssistant()];

        await commitPendingTurn();

        expect(runPostTurnPipeline).toHaveBeenCalledTimes(1);
        const commitState = (runPostTurnPipeline as any).mock.calls[0][0];
        expect(commitState.displayInput).toBe('i shrug lightly');
        expect(commitState.input).toBe('i shrug lightly');
    });
});

describe('commitPendingTurn — the turn is retired only once the scene lands', () => {
    it('clears the markers on a successful archive', async () => {
        storeState.messages = [userMsg(), pendingAssistant()];

        await commitPendingTurn();

        expect(tail().pendingCommit).toBeUndefined();
        expect(tail().swipeSet).toBeUndefined();
        expect(tail().commitFailed).toBeUndefined();
    });

    it('keeps the turn armed and flags it when the scene did not archive', async () => {
        pipelineResult.archived = false;
        storeState.messages = [userMsg(), pendingAssistant()];

        await commitPendingTurn();

        expect(tail().pendingCommit).toBe(true);
        expect(tail().swipeSet).toHaveLength(1);
        expect(tail().commitFailed).toBe(true);
    });

    it('keeps the turn armed when the pipeline throws', async () => {
        pipelineResult.archived = 'throw';
        storeState.messages = [userMsg(), pendingAssistant()];

        await commitPendingTurn();

        expect(tail().pendingCommit).toBe(true);
        expect(tail().commitFailed).toBe(true);
    });

    it('a flagged turn retries with scene verification so a lost response cannot duplicate', async () => {
        storeState.messages = [userMsg(), pendingAssistant({ commitFailed: true })];

        await commitPendingTurn();

        expect((runPostTurnPipeline as any).mock.calls[0][5]).toEqual({ verifyExistingScene: true });
    });

    it('retires an armed message that already carries a sceneId without re-appending', async () => {
        storeState.messages = [userMsg(), pendingAssistant({ sceneId: '046' })];

        await commitPendingTurn();

        expect(runPostTurnPipeline).not.toHaveBeenCalled();
        expect(tail().pendingCommit).toBeUndefined();
        expect(tail().sceneId).toBe('046');
    });
});

describe('retryFailedCommits — buried turns', () => {
    it('archives a failed turn that a later turn buried', async () => {
        storeState.messages = [
            userMsg({ id: 'u1', content: 'the buried turn' }),
            pendingAssistant({ id: 'a1', commitFailed: true }),
            userMsg({ id: 'u2', content: 'the next turn' }),
            pendingAssistant({ id: 'a2' }),
        ];

        const repaired = await retryFailedCommits();

        expect(repaired).toBe(1);
        expect(appendMock).toHaveBeenCalledWith('camp1', 'the buried turn', 'the GM reply');
        const buriedMsg = storeState.messages.find(m => m.id === 'a1')!;
        expect(buriedMsg.sceneId).toBe('046');
        expect(buriedMsg.pendingCommit).toBeUndefined();
        expect(buriedMsg.commitFailed).toBeUndefined();
    });

    it('leaves the live pending turn to commitPendingTurn', async () => {
        storeState.messages = [userMsg(), pendingAssistant({ commitFailed: true })];

        const repaired = await retryFailedCommits();

        expect(repaired).toBe(0);
        expect(appendMock).not.toHaveBeenCalled();
    });

    it('never touches ordinary un-stamped history (pre-WO-F campaigns)', async () => {
        storeState.messages = [
            userMsg({ id: 'u1' }),
            { id: 'a1', role: 'assistant', content: 'legacy reply', timestamp: 1 } as ChatMessage,
        ];

        const repaired = await retryFailedCommits();

        expect(repaired).toBe(0);
        expect(appendMock).not.toHaveBeenCalled();
    });

    it('stops instead of hammering a server that is still down', async () => {
        appendMock.mockResolvedValue(undefined);
        storeState.messages = [
            userMsg({ id: 'u1', content: 'first buried' }),
            pendingAssistant({ id: 'a1', commitFailed: true }),
            userMsg({ id: 'u2', content: 'second buried' }),
            pendingAssistant({ id: 'a2', commitFailed: true }),
            userMsg({ id: 'u3', content: 'live turn' }),
            pendingAssistant({ id: 'a3' }),
        ];

        const repaired = await retryFailedCommits();

        expect(repaired).toBe(0);
        expect(appendMock).toHaveBeenCalledTimes(1);
        expect(storeState.messages.find(m => m.id === 'a1')!.commitFailed).toBe(true);
    });
});
