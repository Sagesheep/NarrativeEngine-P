import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ArchiveIndexEntry } from '../../../types';

const mocks = vi.hoisted(() => ({
    getIndex: vi.fn(),
    patchEvents: vi.fn(),
    fetchScenes: vi.fn(),
    analyzeScene: vi.fn(),
}));

vi.mock('../../../services/llm/apiClient', () => ({
    api: {
        archive: { getIndex: mocks.getIndex, patchEvents: mocks.patchEvents, fetchScenes: mocks.fetchScenes },
        chapters: { list: vi.fn().mockResolvedValue([]), refitPreview: vi.fn().mockResolvedValue(undefined) },
        timeline: { get: vi.fn().mockResolvedValue([]) },
    },
}));
vi.mock('../../../services/archive-memory/sceneEventExtractor', () => ({ analyzeScene: mocks.analyzeScene }));

import { ChapterTab } from '../ChapterTab';
import { useAppStore } from '../../../store/useAppStore';

const entry = (sceneId: string, over: Partial<ArchiveIndexEntry> = {}): ArchiveIndexEntry => ({
    sceneId, timestamp: 1, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '', ...over,
});

function setup(archiveIndex: ArchiveIndexEntry[]) {
    useAppStore.setState({
        activeCampaignId: 'campaign-1',
        archiveIndex,
        chapters: [],
        getActiveSummarizerEndpoint: () => ({ endpoint: 'http://x' }),
    } as never);
    render(<ChapterTab />);
}

beforeEach(() => {
    vi.clearAllMocks();
    mocks.fetchScenes.mockImplementation(async (_id: string, ids: string[]) => ids.map(sceneId => ({ sceneId, content: 'text' })));
    mocks.patchEvents.mockResolvedValue(undefined);
    mocks.getIndex.mockResolvedValue([]);
    mocks.analyzeScene.mockResolvedValue({ events: [], tags: { tense: 2 }, hooks: [], resolvedHookIds: [] });
});

describe('ChapterTab — tagging old scenes', () => {
    it('states the AI call count, and spends nothing until clicked', () => {
        setup([entry('001'), entry('002'), entry('003', { tags: {}, definition: 'Grey meets Therese in the study.' })]);
        expect(screen.getByRole('button', { name: /Tag and define scenes \(2 AI calls\)/i })).toBeTruthy();
        expect(mocks.analyzeScene).not.toHaveBeenCalled();
    });

    it('offers nothing when every scene is tagged', () => {
        setup([entry('001', { tags: { tense: 1 }, definition: 'Grey meets Therese in the study.' })]);
        expect(screen.queryByRole('button', { name: /Tag and define scenes/i })).toBeNull();
    });

    it('tags the untagged scenes on click', async () => {
        setup([entry('001'), entry('002', { tags: {}, definition: 'Grey meets Therese in the study.' })]);
        fireEvent.click(screen.getByRole('button', { name: /Tag and define scenes/i }));
        await waitFor(() => expect(mocks.patchEvents).toHaveBeenCalledWith('campaign-1', [{ sceneId: '001', tags: { tense: 2 }, hooks: [] }]));
        expect(mocks.analyzeScene).toHaveBeenCalledTimes(1);
    });
});
