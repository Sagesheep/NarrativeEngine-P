import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GameContext } from '../../types';

vi.mock('../loreRetriever', () => ({
    searchLoreByQuery: vi.fn(),
    retrieveRelevantLore: vi.fn(),
}));
vi.mock('../../utils/uid', () => ({ uid: vi.fn().mockReturnValue('note-uid') }));

import { handleLoreTool, handleNotebookTool, TOOL_DEFINITIONS } from '../toolHandlers';
import { searchLoreByQuery } from '../loreRetriever';

const mockSearchLore = vi.mocked(searchLoreByQuery);

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

    it('returns "No relevant lore found." when query is empty', () => {
        const { toolResult } = handleLoreTool(JSON.stringify({ query: '' }), { loreChunks: [], notebook: [] });
        expect(toolResult).toBe('No relevant lore found.');
        expect(mockSearchLore).not.toHaveBeenCalled();
    });

    it('returns "No relevant lore found." when searchLoreByQuery returns []', () => {
        mockSearchLore.mockReturnValue([]);
        const { toolResult } = handleLoreTool(JSON.stringify({ query: 'dragons' }), { loreChunks: [], notebook: [] });
        expect(toolResult).toBe('No relevant lore found.');
    });

    it('formats found lore as ### header\\ncontent joined by \\n\\n', () => {
        mockSearchLore.mockReturnValue([
            { id: '1', header: 'Dragons', content: 'They breathe fire.', tokens: 10, alwaysInclude: false, triggerKeywords: [], scanDepth: 0, category: 'general', linkedEntities: [], priority: 0 },
            { id: '2', header: 'Elves', content: 'Long-lived folk.', tokens: 10, alwaysInclude: false, triggerKeywords: [], scanDepth: 0, category: 'general', linkedEntities: [], priority: 0 },
        ] as any);
        const { toolResult } = handleLoreTool(JSON.stringify({ query: 'races' }), { loreChunks: [], notebook: [] });
        expect(toolResult).toBe('### Dragons\nThey breathe fire.\n\n### Elves\nLong-lived folk.');
    });

    it('handles malformed JSON arguments gracefully (empty query fallback)', () => {
        const { toolResult } = handleLoreTool('not-json', { loreChunks: [], notebook: [] });
        expect(toolResult).toBe('No relevant lore found.');
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
