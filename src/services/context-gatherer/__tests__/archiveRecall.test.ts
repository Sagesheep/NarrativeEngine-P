import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    retrieveArchiveMemory: vi.fn(),
    selectArchiveSceneIdsWithChapterFunnel: vi.fn(),
    runArchivePlanner: vi.fn(),
}));
vi.mock('../../archiveMemory', () => ({
    retrieveArchiveMemory: mocks.retrieveArchiveMemory,
    fetchArchiveScenes: vi.fn(),
}));
vi.mock('../../archive-memory/archiveChapterEngine', () => ({
    rankChapters: vi.fn(() => []),
    selectArchiveSceneIdsWithChapterFunnel: mocks.selectArchiveSceneIdsWithChapterFunnel,
}));
vi.mock('../../archive-memory/archivePlanner', () => ({
    runArchivePlanner: mocks.runArchivePlanner,
}));

import { gatherPlannerSceneIds, selectMemoryRecallIds, type MemoryRecallInput, type MemoryRecallCoreContext } from '../archiveRecall';
import type { TurnState } from '../../turn/turnOrchestrator';
import type { ArchiveChapter } from '../../../types';

const sealedChapter = { chapterId: 'CH01', sealedAt: 1, summary: 'A chapter.', sceneRange: ['001', '025'], sceneIds: [] } as unknown as ArchiveChapter;

const input = {
    campaignId: 'c1',
    query: 'Therese is going to want what we promised her.',
    messages: [],
    archiveIndex: [{ sceneId: '001' }],
    chapters: [],
    npcLedger: [],
    semanticFacts: [],
    candidateSceneIds: ['534', '533'],
    plannerSceneIds: ['533'],
    excludeSceneIds: [],
    divergenceSceneIds: [],
    depth: 'standard',
    tokenBudget: 3000,
} as unknown as MemoryRecallInput;

const context = (moduleEnabled?: Record<string, boolean>): MemoryRecallCoreContext => ({
    chapters: [sealedChapter],
    aiTier: 'max',
    moduleEnabled,
    modelCall: vi.fn(),
});

beforeEach(() => {
    mocks.retrieveArchiveMemory.mockReset().mockReturnValue(['534', '533']);
    mocks.selectArchiveSceneIdsWithChapterFunnel.mockReset().mockResolvedValue(['209', '217']);
    mocks.runArchivePlanner.mockReset().mockResolvedValue(['533']);
});

describe('selectMemoryRecallIds — the chapter funnel block', () => {
    it('on Max with sealed chapters, uses archive-wide search with meaning search and planner by default', async () => {
        const ids = await selectMemoryRecallIds(input, context());

        expect(ids).toEqual(['534', '533']);
        expect(mocks.selectArchiveSceneIdsWithChapterFunnel).not.toHaveBeenCalled();
        const args = mocks.retrieveArchiveMemory.mock.calls[0];
        expect(args[8]).toEqual(['534', '533']); // meaning-search candidates
        expect(args[11]).toEqual(['533']);       // planner picks
    });

    it('a stored "off" from an older preset is respected too', async () => {
        await selectMemoryRecallIds(input, context({ archiveFunnel: false }));
        expect(mocks.selectArchiveSceneIdsWithChapterFunnel).not.toHaveBeenCalled();
    });

    it('a Block View toggle turns the funnel back on', async () => {
        const ids = await selectMemoryRecallIds(input, context({ archiveFunnel: true }));
        expect(mocks.selectArchiveSceneIdsWithChapterFunnel).toHaveBeenCalled();
        expect(ids).toEqual(['209', '217']);
    });
});

describe('gatherPlannerSceneIds — the Archive Planner block', () => {
    const plannerState = (moduleEnabled?: Record<string, boolean>) => ({
        input: 'Therese is going to want what we promised her.',
        archiveIndex: [{ sceneId: '001' }],
        settings: { aiTier: 'max', enableArchivePlanner: true, moduleEnabled },
        getUtilityEndpoint: () => ({ endpoint: 'http://utility.test/v1', modelName: 'm' }),
    }) as unknown as TurnState;

    it('is off on Max by default', async () => {
        expect(await gatherPlannerSceneIds(plannerState())).toBeUndefined();
        expect(mocks.runArchivePlanner).not.toHaveBeenCalled();
    });

    it('a Block View toggle turns it back on', async () => {
        expect(await gatherPlannerSceneIds(plannerState({ planner: true }))).toEqual(['533']);
        expect(mocks.runArchivePlanner).toHaveBeenCalled();
    });
});
