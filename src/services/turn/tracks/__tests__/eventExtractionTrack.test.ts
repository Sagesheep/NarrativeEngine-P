import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';
import type { ArchiveIndexEntry } from '../../../../types';

// Event tags stopped on 2026-08-10: the pipeline always builds a host facade, which
// leaves `eventExtractionProvider` undefined, and the track gated on that alone.
// These tests pin the facade path (the production shape) as well as the direct one.

const mocks = vi.hoisted(() => ({
    analyzeScene: vi.fn(),
    patchEvents: vi.fn(),
    getIndex: vi.fn(),
}));

vi.mock('../../../archive-memory/sceneEventExtractor', () => ({
    analyzeScene: mocks.analyzeScene,
}));
vi.mock('../../../llm/apiClient', () => ({
    api: { archive: { patchEvents: mocks.patchEvents, getIndex: mocks.getIndex } },
}));
vi.mock('../../../infrastructure/backgroundQueue', () => ({
    backgroundQueue: { push: (_label: string, job: () => Promise<void>) => job() },
}));
vi.mock('../guarded', () => ({
    assertStillActive: () => true,
    makeGuarded: <T>(fn: T) => fn,
}));

import { eventExtractionTrack } from '../postCommit/eventExtractionTrack';

const entry = { sceneId: '042', timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '' } as ArchiveIndexEntry;
const storyModelCall = vi.fn();

function ctx(overrides: Partial<PostCommitTrackContext> = {}): PostCommitTrackContext {
    return {
        callbacks: { setArchiveIndex: vi.fn() },
        displayInput: 'I hand Therese the letter.',
        lastAssistantContent: 'Therese reads it twice.',
        activeCampaignId: 'campaign-1',
        sceneId: '042',
        entry,
        eventExtractionProvider: undefined,
        storyModelCall,
        ...overrides,
    } as unknown as PostCommitTrackContext;
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.getIndex.mockResolvedValue([]);
});

describe('eventExtractionTrack', () => {
    it('runs through the host facade when there is no direct provider', () => {
        expect(eventExtractionTrack.shouldRun(ctx())).toBe(true);
    });

    it('runs with a direct provider and no facade', () => {
        const provider = { endpoint: 'http://story', apiKey: 'k', modelName: 'm' };
        expect(eventExtractionTrack.shouldRun(ctx({ eventExtractionProvider: provider as PostCommitTrackContext['eventExtractionProvider'], storyModelCall: undefined }))).toBe(true);
    });

    it('does not run with no model at all, or when the scene already has events', () => {
        expect(eventExtractionTrack.shouldRun(ctx({ storyModelCall: undefined }))).toBe(false);
        expect(eventExtractionTrack.shouldRun(ctx({ entry: { ...entry, events: [] } }))).toBe(false);
    });

    it('analyzes through the story model call and patches events, tags and hooks together', async () => {
        const events = [{ eventType: 'promise', importance: 7, text: 'Grey promised Therese the findings first.' }];
        const tags = { negotiation: 3 };
        const hooks = [{ id: '042:0', type: 'promise', with: ['Therese'], what: 'Findings go to Therese first.', status: 'open' }];
        mocks.analyzeScene.mockResolvedValue({ events, tags, hooks, resolvedHookIds: [] });

        await eventExtractionTrack.run(ctx());

        expect(mocks.analyzeScene).toHaveBeenCalledWith(
            undefined,
            'I hand Therese the letter.\n\nTherese reads it twice.',
            '042',
            { modelCall: storyModelCall, openHooks: [] },
        );
        expect(mocks.patchEvents).toHaveBeenCalledWith('campaign-1', [{ sceneId: '042', events, tags, hooks }]);
    });

    it('saves tags even when the scene has no events, leaving events unset', async () => {
        mocks.analyzeScene.mockResolvedValue({ events: [], tags: { tender: 2 }, hooks: [], resolvedHookIds: [] });
        await eventExtractionTrack.run(ctx());
        expect(mocks.patchEvents).toHaveBeenCalledWith('campaign-1', [{ sceneId: '042', tags: { tender: 2 }, hooks: [] }]);
    });

    it('saves the scene definition with the tags', async () => {
        mocks.analyzeScene.mockResolvedValue({ events: [], tags: {}, hooks: [], resolvedHookIds: [], definition: 'Grey reads the Soll letter alone.' });
        await eventExtractionTrack.run(ctx());
        expect(mocks.patchEvents).toHaveBeenCalledWith('campaign-1', [{ sceneId: '042', tags: {}, hooks: [], definition: 'Grey reads the Soll letter alone.' }]);
    });

    it('patches nothing when the analysis failed, so the scene stays untagged', async () => {
        mocks.analyzeScene.mockResolvedValue(null);
        await eventExtractionTrack.run(ctx());
        expect(mocks.patchEvents).not.toHaveBeenCalled();
    });

    it('offers only open hooks about someone in this scene, and closes the ones it resolved', async () => {
        const therese = { id: '010:0', type: 'promise', with: ['Therese Soll'], what: 'Findings first.', status: 'open' };
        const pell = { id: '011:0', type: 'grudge', with: ['Pell'], what: 'Pell wants revenge.', status: 'open' };
        const freshIndex = [
            { ...entry, sceneId: '010', hooks: [therese] },
            { ...entry, sceneId: '011', hooks: [pell] },
        ] as ArchiveIndexEntry[];
        mocks.analyzeScene.mockResolvedValue({ events: [], tags: {}, hooks: [], resolvedHookIds: ['010:0'] });

        await eventExtractionTrack.run(ctx({ freshIndex }));

        expect(mocks.analyzeScene.mock.calls[0][3].openHooks).toEqual([therese]);
        expect(mocks.patchEvents).toHaveBeenCalledWith('campaign-1', [
            { sceneId: '042', tags: {}, hooks: [] },
            { sceneId: '010', hooks: [{ ...therese, status: 'closed', closedBy: '042' }] },
        ]);
    });
});
