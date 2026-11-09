import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArchiveIndexEntry, EndpointConfig } from '../../../types';

const mocks = vi.hoisted(() => ({ analyzeScene: vi.fn() }));
vi.mock('../sceneEventExtractor', () => ({ analyzeScene: mocks.analyzeScene }));

import { backfillSceneTags, scenesNeedingAnalysis } from '../sceneTagBackfill';

const entry = (sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry => ({
    sceneId, timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '', ...over,
});
const provider = { endpoint: 'http://x' } as EndpointConfig;
const fetchScenes = async (ids: string[]) => ids.map(sceneId => ({ sceneId, content: `Therese in scene ${sceneId}` }));
const empty = { events: [], tags: {}, hooks: [], resolvedHookIds: [] };

beforeEach(() => mocks.analyzeScene.mockReset());

describe('backfillSceneTags', () => {
    it('counts a scene analysed with no fitting tags as done, but not one missing its definition', () => {
        const done = entry('002', { tags: {}, definition: 'Grey meets Therese in the study.' });
        const noDefinition = entry('003', { tags: {} });
        expect(scenesNeedingAnalysis([entry('001'), done, noDefinition]).map(e => e.sceneId)).toEqual(['001', '003']);
    });

    it('gives a tagged scene only its definition, keeping its tags and hooks', async () => {
        mocks.analyzeScene.mockResolvedValue({ ...empty, tags: { combat: 3 }, definition: 'Grey and Rin fight bandits at the ford.' });
        const patch = vi.fn().mockResolvedValue(undefined);
        const result = await backfillSceneTags({ index: [entry('001', { tags: { tense: 1 } })], provider, fetchScenes, patch, isActive: () => true });
        expect(result).toEqual({ tagged: 1, failed: 0, aborted: false });
        expect(patch).toHaveBeenCalledWith([{ sceneId: '001', definition: 'Grey and Rin fight bandits at the ford.' }]);
    });

    it('counts a tagged scene whose answer has no definition as failed', async () => {
        mocks.analyzeScene.mockResolvedValue(empty);
        const patch = vi.fn();
        const result = await backfillSceneTags({ index: [entry('001', { tags: {} })], provider, fetchScenes, patch, isActive: () => true });
        expect(result).toEqual({ tagged: 0, failed: 1, aborted: false });
        expect(patch).not.toHaveBeenCalled();
    });

    it('saves the definition with the tags of an untagged scene', async () => {
        mocks.analyzeScene.mockResolvedValue({ ...empty, definition: 'Grey reads the Soll letter alone.' });
        const patch = vi.fn().mockResolvedValue(undefined);
        await backfillSceneTags({ index: [entry('001')], provider, fetchScenes, patch, isActive: () => true });
        expect(patch).toHaveBeenCalledWith([{ sceneId: '001', tags: {}, hooks: [], definition: 'Grey reads the Soll letter alone.' }]);
    });

    it('tags only untagged scenes and never replaces existing events', async () => {
        const events = [{ eventType: 'other', importance: 3, text: 'New.' }];
        mocks.analyzeScene.mockResolvedValue({ ...empty, events, tags: { tense: 2 } });
        const patch = vi.fn().mockResolvedValue(undefined);
        const existing = [{ eventType: 'combat' as const, importance: 8, text: 'From the seal.' }];

        const result = await backfillSceneTags({
            index: [entry('001', { tags: { tender: 1 }, definition: 'Already defined scene here.' }), entry('002', { events: existing }), entry('003')],
            provider, fetchScenes, patch, isActive: () => true,
        });

        expect(result).toEqual({ tagged: 2, failed: 0, aborted: false });
        expect(patch.mock.calls.map(c => c[0])).toEqual([
            [{ sceneId: '002', tags: { tense: 2 }, hooks: [] }],
            [{ sceneId: '003', events, tags: { tense: 2 }, hooks: [] }],
        ]);
    });

    it('lets a later scene resolve a hook found earlier in the same run', async () => {
        const made = { id: '001:0', type: 'promise', with: ['Therese'], what: 'Findings first.', status: 'open' };
        mocks.analyzeScene
            .mockResolvedValueOnce({ ...empty, hooks: [made] })
            .mockResolvedValueOnce({ ...empty, resolvedHookIds: ['001:0'] });
        const patch = vi.fn().mockResolvedValue(undefined);

        await backfillSceneTags({ index: [entry('001'), entry('002')], provider, fetchScenes, patch, isActive: () => true });

        expect(mocks.analyzeScene.mock.calls[1][3].openHooks).toEqual([made]);
        expect(patch.mock.calls[1][0][1]).toEqual({ sceneId: '001', hooks: [{ ...made, status: 'closed', closedBy: '002' }] });
    });

    it('leaves a failed scene untagged and keeps going', async () => {
        mocks.analyzeScene.mockResolvedValueOnce(null).mockResolvedValueOnce(empty);
        const patch = vi.fn().mockResolvedValue(undefined);
        const result = await backfillSceneTags({ index: [entry('001'), entry('002')], provider, fetchScenes, patch, isActive: () => true });
        expect(result).toEqual({ tagged: 1, failed: 1, aborted: false });
        expect(patch).toHaveBeenCalledTimes(1);
    });

    it('stops after three failures in a row instead of failing every scene', async () => {
        mocks.analyzeScene.mockResolvedValue(null);
        const patch = vi.fn();
        const index = ['001', '002', '003', '004', '005'].map(id => entry(id));
        const result = await backfillSceneTags({ index, provider, fetchScenes, patch, isActive: () => true });
        expect(result).toEqual({ tagged: 0, failed: 3, aborted: true, stoppedOnErrors: true });
        expect(mocks.analyzeScene).toHaveBeenCalledTimes(3);
    });

    it('a success resets the failure count', async () => {
        mocks.analyzeScene
            .mockResolvedValueOnce(null).mockResolvedValueOnce(null)
            .mockResolvedValueOnce(empty)
            .mockResolvedValueOnce(null).mockResolvedValueOnce(null);
        const patch = vi.fn().mockResolvedValue(undefined);
        const index = ['001', '002', '003', '004', '005'].map(id => entry(id));
        const result = await backfillSceneTags({ index, provider, fetchScenes, patch, isActive: () => true });
        expect(result).toEqual({ tagged: 1, failed: 4, aborted: false });
    });

    it('stops when aborted or when the campaign changes', async () => {
        const ac = new AbortController();
        ac.abort();
        const patch = vi.fn();
        expect((await backfillSceneTags({ index: [entry('001')], provider, fetchScenes, patch, isActive: () => true, signal: ac.signal })).aborted).toBe(true);
        expect((await backfillSceneTags({ index: [entry('001')], provider, fetchScenes, patch, isActive: () => false })).aborted).toBe(true);
        expect(mocks.analyzeScene).not.toHaveBeenCalled();
    });
});
