import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    retrieveArchiveMemory: vi.fn(),
    selectArchiveSceneIdsWithChapterFunnel: vi.fn(),
}));
vi.mock('../../archiveMemory', () => ({
    retrieveArchiveMemory: mocks.retrieveArchiveMemory,
    fetchArchiveScenes: vi.fn(),
    fetchRecallScenes: vi.fn(),
}));
vi.mock('../../archive-memory/archiveChapterEngine', () => ({
    rankChapters: vi.fn(() => []),
    selectArchiveSceneIdsWithChapterFunnel: mocks.selectArchiveSceneIdsWithChapterFunnel,
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
});

describe('selectMemoryRecallIds — the chapter funnel block', () => {
    it('on Max with sealed chapters, uses archive-wide search with meaning search by default', async () => {
        const ids = await selectMemoryRecallIds(input, context());

        expect(ids).toEqual(['534', '533']);
        expect(mocks.selectArchiveSceneIdsWithChapterFunnel).not.toHaveBeenCalled();
        const args = mocks.retrieveArchiveMemory.mock.calls[0];
        expect(args[8]).toEqual(['534', '533']); // meaning-search candidates
        expect(args[11]).toEqual(['533']);       // a mod-supplied plannerSceneIds still reaches the ranker
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

describe('selectMemoryRecallIds — the Recall Picker block', () => {
    const def = (sceneId: string) => ({ sceneId, definition: `Grey and Therese settle matter ${sceneId} in the study.` });
    const pickerInput = {
        ...input,
        archiveIndex: [def('534'), def('533'), def('600')],
        messages: [{ role: 'assistant', content: 'Therese waits.' }],
    } as unknown as MemoryRecallInput;
    const pickerContext = (answer: string | Error, over: Partial<MemoryRecallCoreContext> = {}): MemoryRecallCoreContext => ({
        chapters: [],
        aiTier: 'pro',
        modelCall: answer instanceof Error ? vi.fn().mockRejectedValue(answer) : vi.fn().mockResolvedValue({ content: answer }),
        ...over,
    });

    beforeEach(() => {
        // The normal recall depth gives two scenes; the picker reads up to 30 candidates.
        mocks.retrieveArchiveMemory.mockImplementation((...args: unknown[]) => (args[4] === 30 ? ['534', '533', '600'] : ['534', '533']));
    });

    it('puts the picks first, then everything the engine recalled', async () => {
        const ctx = pickerContext('[3]');
        expect(await selectMemoryRecallIds(pickerInput, ctx)).toEqual(['600', '534', '533']);
        const prompt = vi.mocked(ctx.modelCall!).mock.calls[0][0].prompt;
        expect(prompt).toContain('[3] Grey and Therese settle matter 600 in the study.');
        expect(prompt).toContain('Therese waits.');
    });

    it('keeps the engine order when the model fails, answers nonsense or picks nothing', async () => {
        vi.spyOn(console, 'warn').mockImplementation(() => {});
        for (const answer of [new Error('down'), 'no idea', '[]']) {
            expect(await selectMemoryRecallIds(pickerInput, pickerContext(answer))).toEqual(['534', '533']);
        }
    });

    it('is off on Lite, and a Block View toggle turns it off elsewhere', async () => {
        const lite = pickerContext('[3]', { aiTier: 'lite' });
        expect(await selectMemoryRecallIds(pickerInput, lite)).toEqual(['534', '533']);
        expect(lite.modelCall).not.toHaveBeenCalled();
        const off = pickerContext('[3]', { moduleEnabled: { planner: false } });
        expect(await selectMemoryRecallIds(pickerInput, off)).toEqual(['534', '533']);
        expect(off.modelCall).not.toHaveBeenCalled();
    });

    it('does not run without definitions or events to read', async () => {
        const ctx = pickerContext('[1]');
        expect(await selectMemoryRecallIds({ ...input, chapters: [] } as unknown as MemoryRecallInput, { ...ctx, chapters: [] })).toEqual(['534', '533']);
        expect(ctx.modelCall).not.toHaveBeenCalled();
    });
});

describe('gatherPlannerSceneIds — retired with the Archive Planner', () => {
    it('resolves to nothing, whatever the Block View says', async () => {
        const state = {
            input: 'x',
            archiveIndex: [{ sceneId: '001' }],
            settings: { aiTier: 'max', moduleEnabled: { planner: true } },
            getUtilityEndpoint: () => ({ endpoint: 'http://utility.test/v1' }),
        } as unknown as TurnState;
        expect(await gatherPlannerSceneIds(state)).toBeUndefined();
    });
});
