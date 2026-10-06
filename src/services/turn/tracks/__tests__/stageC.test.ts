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

vi.mock('../../../../store/relationshipMemoryState', () => ({
    readRelationshipMemoryState: () => ({ relationshipMemoriesNpcToMc: [], relationshipMemoriesNpcToNpc: [] }),
}));

vi.mock('../../hostFacade', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../hostFacade')>()),
    hasHostModelRole: () => true,
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

    // Every live commit runs under the host facade. There, the seal's only model path is
    // the facade's story model; c8a4539 dropped it, so every auto-seal wrote no summary.
    it('under the host facade, hands the story-model call to the combined seal', async () => {
        const call = vi.fn().mockResolvedValue({ content: '{}' });
        const ctx = makeContext(25);
        (ctx as unknown as { facade: unknown }).facade = {
            config: { aiTier: 'max', moduleEnabled: {}, divergenceScanBudget: 0, contextLimit: 4096 },
            data: { npcLedger: [], archiveIndex: [], divergenceRegister: { entries: [] } },
            model: { call },
        };
        const started = postCommitTracks.start(ctx, { isEnabled: id => id === 'track.chapter-seal' });
        await Promise.allSettled([...started, ...mocks.tasks]);

        expect(mocks.runCombinedSeal).toHaveBeenCalledTimes(1);
        const args = mocks.runCombinedSeal.mock.calls[0];
        expect(args[0]).toBeUndefined(); // no direct provider under the facade
        const modelCall = args[7] as (request: { prompt: string }) => Promise<string>;
        expect(typeof modelCall).toBe('function');
        await modelCall({ prompt: 'seal' });
        expect(call).toHaveBeenCalledWith('story', { prompt: 'seal' });
    });
});
