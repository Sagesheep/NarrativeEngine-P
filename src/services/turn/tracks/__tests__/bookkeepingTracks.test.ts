import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';
import type { TurnCallbacks, TurnState } from '../../turnOrchestrator';

const mocks = vi.hoisted(() => ({
    startPostCommitTracks: vi.fn(() => [] as Promise<void>[]),
    append: vi.fn(),
    getIndex: vi.fn(),
    getTimeline: vi.fn(),
    listChapters: vi.fn(),
    rateImportance: vi.fn(),
}));

vi.mock('../../tracks', () => ({
    startPostTurnTracks: vi.fn(() => [] as Promise<void>[]),
}));

vi.mock('../postCommit', () => ({
    startPostCommitTracks: mocks.startPostCommitTracks,
}));

vi.mock('../prologue', () => ({
    startPrologueTracks: vi.fn(),
}));

vi.mock('../sequential', () => ({
    startSequentialTracks: vi.fn(() => [] as Promise<void>[]),
}));

vi.mock('../../hostFacade', () => ({
    buildHostFacade: vi.fn(() => undefined),
    hasHostModelRole: vi.fn(() => true),
}));

vi.mock('../../../llm/apiClient', () => ({
    api: {
        archive: {
            append: mocks.append,
            getIndex: mocks.getIndex,
        },
        timeline: {
            get: mocks.getTimeline,
        },
        chapters: {
            list: mocks.listChapters,
        },
    },
}));

vi.mock('../../../archive-memory/importanceRater', () => ({
    rateImportance: mocks.rateImportance,
}));

vi.mock('../../../saveFileEngine', () => ({
    sealChapterCombined: vi.fn(),
}));

vi.mock('../../../../components/Toast', () => ({
    toast: { error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}));

vi.mock('../../../../mods/events', () => ({
    emitCoreEventLazy: vi.fn(),
}));

vi.mock('../../../../store/campaignStore', () => ({
    saveDivergenceRegister: vi.fn(),
}));

vi.mock('../../../characterProfileParser', () => ({ scanCharacterProfile: vi.fn() }));
vi.mock('../../../characterTraitParser', () => ({ scanCharacterTraits: vi.fn() }));
vi.mock('../../../inventoryParser', () => ({ scanInventory: vi.fn() }));
vi.mock('../../../locationParser', () => ({ mergeLocationScanLedger: vi.fn(), scanLocation: vi.fn() }));
vi.mock('../../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: vi.fn() },
}));

import { runPostTurnPipeline } from '../../postTurnPipeline';
import { inventoryScanTrack } from '../postCommit/inventoryScanTrack';
import { locationScanTrack } from '../postCommit/locationScanTrack';
import { pcDriftTrack } from '../postCommit/pcDriftTrack';
import { profileScanTrack } from '../postCommit/profileScanTrack';
import { traitScanTrack } from '../postCommit/traitScanTrack';

function makeGateContext(tier: 'lite' | 'pro' | 'max'): PostCommitTrackContext {
    return {
        state: { settings: { aiTier: tier } } as PostCommitTrackContext['state'],
        facade: { config: { aiTier: tier } } as PostCommitTrackContext['facade'],
        callbacks: {} as PostCommitTrackContext['callbacks'],
        displayInput: '',
        lastAssistantContent: '',
        allMsgs: [],
        npcLedger: [],
        activeCampaignId: 'campaign-1',
        sceneId: '001',
        freshIndex: [],
        freshChapters: [],
        entry: undefined,
        eventExtractionProvider: undefined,
        bookkeepingDue: true,
        bkProvider: undefined,
        bkAvailable: true,
        snapshotContext: undefined,
        freshContext: { characterProfileActive: true } as PostCommitTrackContext['freshContext'],
        inventoryItems: [],
        profileData: {} as PostCommitTrackContext['profileData'],
        scanMessages: [],
        storyModelCall: undefined,
        guardedUpdateContext: vi.fn(),
        guardedSetCharacterProfileData: vi.fn(),
        guardedSetInventoryItems: vi.fn(),
        guardedSetLocationLedger: vi.fn(),
        guardedAddLocationSuggestions: vi.fn(),
        pc: {} as PostCommitTrackContext['pc'],
        guardedUpdatePlayerCharacter: vi.fn(),
    };
}

function makePipelineState(overrides: Record<string, unknown> = {}): TurnState {
    const context = {
        characterProfileActive: false,
        characterProfileData: {},
        inventoryItems: [],
        playerCharacter: null,
    };
    const messages: unknown[] = [{ id: 'm1', role: 'user', content: 'hello' }];
    return {
        displayInput: 'hello',
        settings: { aiTier: 'max', moduleEnabled: {} },
        context,
        messages,
        npcLedger: [],
        archiveIndex: [],
        activeCampaignId: 'campaign-1',
        getMessages: vi.fn(() => messages),
        getFreshProvider: vi.fn(() => ({ endpoint: 'http://story', apiKey: 'key', modelName: 'story' })),
        getFreshContext: vi.fn(() => context),
        setChapters: vi.fn(),
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        autoBookkeepingInterval: 1,
        ...overrides,
    } as unknown as TurnState;
}

function makeCallbacks(): TurnCallbacks {
    return {
        updateLastAssistantMessage: vi.fn(),
        updateContext: vi.fn(),
        getFreshLocationState: vi.fn(() => ({ activeCampaignId: 'campaign-1', locationLedger: [], context: {} })),
        setCharacterProfileData: vi.fn(),
        setInventoryItems: vi.fn(),
        setLocationLedger: vi.fn(),
        addLocationSuggestions: vi.fn(),
        setArchiveIndex: vi.fn(),
        updateNPC: vi.fn(),
        addNPC: vi.fn(),
        setCondensed: vi.fn(),
        setStreaming: vi.fn(),
        archiveNPC: vi.fn(),
        restoreNPC: vi.fn(),
        addMessage: vi.fn(),
        updateLastAssistant: vi.fn(),
        updateLastMessage: vi.fn(),
        onCheckingNotes: vi.fn(),
    } as unknown as TurnCallbacks;
}

describe('Stage C bookkeeping tracks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.append.mockResolvedValue({ sceneId: '001' });
        mocks.getIndex.mockResolvedValue([{ sceneId: '001', events: [] }]);
        mocks.getTimeline.mockResolvedValue([]);
        mocks.listChapters.mockResolvedValue([]);
        mocks.rateImportance.mockResolvedValue(1);
    });

    it('increments the bookkeeping counter once and snapshots shared reads once per turn', async () => {
        const state = makePipelineState();
        const callbacks = makeCallbacks();

        await runPostTurnPipeline(state, callbacks, 'The reply.', state.messages);

        expect(state.incrementBookkeepingTurnCounter).toHaveBeenCalledTimes(1);
        expect(state.resetBookkeepingTurnCounter).toHaveBeenCalledTimes(1);
        expect(state.getMessages).toHaveBeenCalledTimes(1);
        // With no facade and an inactive snapshot profile, the two existing reads remain:
        // one for freshContext and one for the PC-drift precondition. They are not repeated
        // once per scan.
        expect(state.getFreshContext).toHaveBeenCalledTimes(2);
        expect(mocks.startPostCommitTracks).toHaveBeenCalledTimes(1);
        expect(mocks.startPostCommitTracks.mock.calls[0][0].scanMessages).toBe(state.messages);
    });

    it.each([
        ['profile scan', profileScanTrack],
        ['trait scan', traitScanTrack],
        ['inventory scan', inventoryScanTrack],
        ['location scan', locationScanTrack],
        ['PC drift', pcDriftTrack],
    ] as const)('%s keeps its lite/pro/max tier gate', (_name, track) => {
        expect(track.shouldRun(makeGateContext('lite'))).toBe(false);
        expect(track.shouldRun(makeGateContext('pro'))).toBe(track === pcDriftTrack);
        expect(track.shouldRun(makeGateContext('max'))).toBe(true);
    });
});
