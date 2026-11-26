/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GameContext } from '../../types';

vi.mock('../lore/loreRetriever', () => ({
    searchLoreByQuery: vi.fn(),
    retrieveRelevantLore: vi.fn(),
}));
vi.mock('../../utils/uid', () => ({ uid: vi.fn().mockReturnValue('note-uid') }));
vi.mock('../archive-memory/archiveToolSearch', () => ({ searchArchiveForTool: vi.fn().mockResolvedValue('') }));

import { handleLoreTool, handleNotebookTool, NO_LORE_RESULT, TOOL_DEFINITIONS } from '../turn/toolHandlers';
import { searchLoreByQuery } from '../lore/loreRetriever';
import { searchArchiveForTool } from '../archive-memory/archiveToolSearch';

const mockSearchLore = vi.mocked(searchLoreByQuery);
const mockArchiveSearch = vi.mocked(searchArchiveForTool);

const emptyNotebook = (): GameContext['notebook'] => [];
const makeNote = (text: string) => ({ id: 'n1', text, timestamp: 1000 });

describe('TOOL_DEFINITIONS', () => {
    it('exports two tool definitions', () => {
        expect(TOOL_DEFINITIONS).toHaveLength(2);
        expect(TOOL_DEFINITIONS[0].function.name).toBe('query_campaign_lore');
        expect(TOOL_DEFINITIONS[1].function.name).toBe('update_scene_notebook');
    });
});

describe('handleLoreTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('returns the no-result text when query is empty', async () => {
        const { toolResult } = await handleLoreTool(JSON.stringify({ query: '' }), { loreChunks: [], notebook: [] });
        expect(toolResult).toBe(NO_LORE_RESULT);
        expect(mockSearchLore).not.toHaveBeenCalled();
    });

    it('returns the no-result text when searchLoreByQuery returns [] and there is no archive', async () => {
        mockSearchLore.mockReturnValue([]);
        const { toolResult } = await handleLoreTool(JSON.stringify({ query: 'dragons' }), { loreChunks: [], notebook: [] });
        expect(toolResult).toBe(NO_LORE_RESULT);
        expect(toolResult).toMatch(/^no relevant lore/i);
    });

    it('appends archived scenes after the lore', async () => {
        mockSearchLore.mockReturnValue([
            { id: '1', header: 'Dzwon', content: 'Barber.', tokens: 10, alwaysInclude: false, triggerKeywords: [], scanDepth: 0, category: 'general', linkedEntities: [], priority: 0 },
        ] as any);
        mockArchiveSearch.mockResolvedValueOnce('### Archive scene 598\nViktor writes the address.');
        const { toolResult } = await handleLoreTool(JSON.stringify({ query: 'scene 598' }), { loreChunks: [], notebook: [], campaignId: 'c1', archiveIndex: [] });
        expect(toolResult).toBe('### Dzwon\nBarber.\n\n### Archive scene 598\nViktor writes the address.');
        expect(mockArchiveSearch).toHaveBeenCalledWith('c1', [], 'scene 598');
    });

    it('keeps the lore when the archive search fails', async () => {
        mockSearchLore.mockReturnValue([
            { id: '1', header: 'Dzwon', content: 'Barber.', tokens: 10, alwaysInclude: false, triggerKeywords: [], scanDepth: 0, category: 'general', linkedEntities: [], priority: 0 },
        ] as any);
        mockArchiveSearch.mockRejectedValueOnce(new Error('offline'));
        const { toolResult } = await handleLoreTool(JSON.stringify({ query: 'Dzwon' }), { loreChunks: [], notebook: [], campaignId: 'c1', archiveIndex: [] });
        expect(toolResult).toBe('### Dzwon\nBarber.');
    });

    it('formats found lore as ### header\\ncontent joined by \\n\\n', async () => {
        mockSearchLore.mockReturnValue([
            { id: '1', header: 'Dragons', content: 'They breathe fire.', tokens: 10, alwaysInclude: false, triggerKeywords: [], scanDepth: 0, category: 'general', linkedEntities: [], priority: 0 },
            { id: '2', header: 'Elves', content: 'Long-lived folk.', tokens: 10, alwaysInclude: false, triggerKeywords: [], scanDepth: 0, category: 'general', linkedEntities: [], priority: 0 },
        ] as any);
        const { toolResult } = await handleLoreTool(JSON.stringify({ query: 'races' }), { loreChunks: [], notebook: [] });
        expect(toolResult).toBe('### Dragons\nThey breathe fire.\n\n### Elves\nLong-lived folk.');
    });

    it('handles malformed JSON arguments gracefully (empty query fallback)', async () => {
        const { toolResult } = await handleLoreTool('not-json', { loreChunks: [], notebook: [] });
        expect(toolResult).toBe(NO_LORE_RESULT);
        expect(mockSearchLore).not.toHaveBeenCalled();
    });
});

describe('handleNotebookTool', () => {
    beforeEach(() => vi.clearAllMocks());

    it('add op appends a new note', () => {
        const { updatedNotebook } = handleNotebookTool(
            JSON.stringify({ actions: [{ op: 'add', text: 'Goblin ambush active' }] }),
            { loreChunks: [], notebook: emptyNotebook() }
        );
        expect(updatedNotebook).toHaveLength(1);
        expect(updatedNotebook[0].text).toBe('Goblin ambush active');
        expect(updatedNotebook[0].id).toBe('note-uid');
    });

    it('remove op deletes note by case-insensitive text match', () => {
        const notebook = [makeNote('Goblin ambush active')];
        const { updatedNotebook } = handleNotebookTool(
            JSON.stringify({ actions: [{ op: 'remove', text: 'goblin ambush' }] }),
            { loreChunks: [], notebook }
        );
        expect(updatedNotebook).toHaveLength(0);
    });

    it('clear op empties notebook', () => {
        const notebook = [makeNote('note 1'), makeNote('note 2')];
        const { updatedNotebook } = handleNotebookTool(
            JSON.stringify({ actions: [{ op: 'clear' }] }),
            { loreChunks: [], notebook }
        );
        expect(updatedNotebook).toHaveLength(0);
    });

    it('enforces MAX_NOTEBOOK_OPS = 5', () => {
        const actions = Array.from({ length: 8 }, (_, i) => ({ op: 'add', text: `note ${i}` }));
        const { updatedNotebook } = handleNotebookTool(
            JSON.stringify({ actions }),
            { loreChunks: [], notebook: emptyNotebook() }
        );
        expect(updatedNotebook).toHaveLength(5);
    });

    it('enforces MAX_NOTEBOOK_NOTES = 50 (add stops at cap)', () => {
        const notebook = Array.from({ length: 50 }, (_, i) => makeNote(`note ${i}`));
        const { updatedNotebook } = handleNotebookTool(
            JSON.stringify({ actions: [{ op: 'add', text: 'overflow note' }] }),
            { loreChunks: [], notebook }
        );
        expect(updatedNotebook).toHaveLength(50);
    });

    it('returns correct toolResult string', () => {
        const { toolResult } = handleNotebookTool(
            JSON.stringify({ actions: [{ op: 'add', text: 'something' }] }),
            { loreChunks: [], notebook: emptyNotebook() }
        );
        expect(toolResult).toBe('Notebook updated. 1 notes active.');
    });

    it('handles malformed JSON arguments gracefully (no ops applied)', () => {
        const notebook = [makeNote('existing')];
        const { updatedNotebook } = handleNotebookTool('bad-json', { loreChunks: [], notebook });
        expect(updatedNotebook).toHaveLength(1);
    });

    it('does not mutate the original notebook array', () => {
        const original = [makeNote('original')];
        handleNotebookTool(
            JSON.stringify({ actions: [{ op: 'add', text: 'new note' }] }),
            { loreChunks: [], notebook: original }
        );
        // original is spread-copied inside handler
        expect(original).toHaveLength(1);
    });
});
