import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';

const mocks = vi.hoisted(() => {
    const tasks: Promise<unknown>[] = [];
    return {
        tasks,
        push: vi.fn((_label: string, execute: () => Promise<unknown>) => {
            const task = execute();
            tasks.push(task);
            return task;
        }),
        seal: vi.fn(),
        list: vi.fn(),
        runCombinedSeal: vi.fn().mockResolvedValue(undefined),
    };
});

vi.mock('../../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: mocks.push },
}));

vi.mock('../../../llm/apiClient', () => ({
    api: {
        archive: {
            patchEvents: vi.fn(),
            getIndex: vi.fn(),
        },
        chapters: {
            seal: mocks.seal,
            list: mocks.list,
        },
    },
}));

vi.mock('../../../mods/events', () => ({
    emitCoreEvent: vi.fn(),
}));

vi.mock('../../postTurnPipeline', () => ({
    runCombinedSeal: mocks.runCombinedSeal,
}));

vi.mock('../../../../components/Toast', () => ({
    toast: { info: vi.fn() },
}));

vi.mock('../../../../store/useAppStore', () => ({
    useAppStore: { getState: () => ({ activeCampaignId: 'campaign-1' }) },
}));

import { api } from '../../../llm/apiClient';
import { postCommitTracks } from '../postCommit';

const mockApi = vi.mocked(api);

function makeContext(sceneCount: number): PostCommitTrackContext {
    const chapter = {
        chapterId: 'CH01',
        title: 'The Road',
        sceneRange: ['001', '025'],
        sceneIds: [],
        summary: '',
        keywords: [],
        npcs: [],
        majorEvents: [],
        unresolvedThreads: [],
        tone: '',
        themes: [],
        sceneCount,
    };
    return {
        state: {
            settings: { aiTier: 'max', divergenceScanBudget: 0, contextLimit: 4096 },
            setChapters: vi.fn(),
            getFreshProvider: () => ({ endpoint: 'http://seal', apiKey: 'key', modelName: 'seal-model' }),
            npcLedger: [],
            archiveIndex: [],
            divergenceRegister: { entries: [] },
        },
        callbacks: {
            setArchiveIndex: vi.fn(),
            setDivergenceRegister: vi.fn(),
        },
        displayInput: 'attack',
        lastAssistantContent: 'The road bends.',
        allMsgs: [],
        npcLedger: [],
        activeCampaignId: 'campaign-1',
        sceneId: '025',
        freshIndex: [],
        freshChapters: [chapter],
        entry: undefined,
        eventExtractionProvider: undefined,
        bookkeepingDue: false,
        bkProvider: undefined,
        bkAvailable: false,
        snapshotContext: undefined,
        freshContext: {},
        inventoryItems: [],
        profileData: {},
        scanMessages: [],
        storyModelCall: undefined,
        guardedUpdateContext: vi.fn(),
        guardedSetCharacterProfileData: vi.fn(),
        guardedSetInventoryItems: vi.fn(),
        guardedSetLocationLedger: vi.fn(),
        guardedAddLocationSuggestions: vi.fn(),
    } as unknown as PostCommitTrackContext;
}

describe('Stage C archive-child tracks', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.tasks.length = 0;
        mocks.seal.mockResolvedValue({
            sealedChapter: { chapterId: 'CH01', title: 'The Road' },
        });
        mocks.list.mockResolvedValue([]);
    });

    it('auto-seals at the soft cap and not before', async () => {
        const belowCap = makeContext(24);
        expect(postCommitTracks.start(belowCap, { isEnabled: () => true })).toHaveLength(0);
        expect(mockApi.chapters.seal).not.toHaveBeenCalled();

        const atCap = makeContext(25);
        const started = postCommitTracks.start(atCap, { isEnabled: () => true });
        expect(mockApi.chapters.seal).toHaveBeenCalledWith('campaign-1');

        await Promise.allSettled([...started, ...mocks.tasks]);
        expect(mockApi.chapters.seal).toHaveBeenCalledTimes(1);
    });
});
