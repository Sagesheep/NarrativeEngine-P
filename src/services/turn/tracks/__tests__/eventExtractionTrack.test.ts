import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PostCommitTrackContext } from '../types';
import type { ArchiveIndexEntry } from '../../../../types';

// Event tags stopped on 2026-08-10: the pipeline always builds a host facade, which
// leaves `eventExtractionProvider` undefined, and the track gated on that alone.
// These tests pin the facade path (the production shape) as well as the direct one.

const mocks = vi.hoisted(() => ({
    extractSceneEvents: vi.fn(),
    patchEvents: vi.fn(),
    getIndex: vi.fn(),
}));

vi.mock('../../../archive-memory/sceneEventExtractor', () => ({
    extractSceneEvents: mocks.extractSceneEvents,
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

    it('extracts through the story model call and patches the scene', async () => {
        const events = [{ eventType: 'promise', importance: 7, text: 'Grey promised Therese the findings first.' }];
        mocks.extractSceneEvents.mockResolvedValue(events);

        await eventExtractionTrack.run(ctx());

        expect(mocks.extractSceneEvents).toHaveBeenCalledWith(
            undefined,
            'I hand Therese the letter.\n\nTherese reads it twice.',
            undefined,
            storyModelCall,
        );
        expect(mocks.patchEvents).toHaveBeenCalledWith('campaign-1', [{ sceneId: '042', events }]);
    });
});
