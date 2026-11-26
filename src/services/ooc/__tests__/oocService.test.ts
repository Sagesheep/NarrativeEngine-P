import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { OocCampaignSnapshot } from '../types';

const { sendMessage, searchCampaignRecords, shouldSearchOoc } = vi.hoisted(() => ({
    sendMessage: vi.fn(),
    searchCampaignRecords: vi.fn(),
    shouldSearchOoc: vi.fn(),
}));

vi.mock('../../llm/llmService', () => ({ sendMessage }));
vi.mock('../retrieval', () => ({ searchCampaignRecords, shouldSearchOoc }));

import { answerOocQuestion, OOC_READ_ONLY_TOOLS } from '../oocService';

const snapshot: OocCampaignSnapshot = {
    campaignId: 'campaign-1',
    provider: { endpoint: 'http://llm.local', apiKey: '', modelName: 'test' } as any,
    context: { canonStateActive: true, canonState: 'The party is in Blackwater.', sceneNoteActive: false, sceneNote: '', currentFeature: null, worldVibe: '', characterProfile: { identity: {}, activeTraits: [] }, inventoryItems: [], notebookActive: false, notebook: [] } as any,
    messages: [{ id: 'latest', role: 'assistant', content: 'Default reply', timestamp: 1, pendingCommit: true, swipeActiveIndex: 1, swipeSet: [{ id: 'a', text: 'Old swipe', sceneStakes: 'calm', tagPresent: false }, { id: 'b', text: 'Visible latest swipe', sceneStakes: 'calm', tagPresent: false }] }],
    semanticFacts: [{ id: 'fact-1', subject: 'Mira', predicate: 'holds', object: 'the key', importance: 8, sceneId: '001', timestamp: 1 }],
    loreChunks: [], archiveIndex: [], npcLedger: [],
} as unknown as OocCampaignSnapshot;

function answerWith(text: string, toolCall?: { id: string; name: string; arguments: string }) {
    sendMessage.mockImplementation((_provider, _messages, onChunk, onDone) => {
        onChunk(text);
        onDone(text, toolCall);
    });
}

describe('answerOocQuestion', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        shouldSearchOoc.mockReturnValue(false);
        searchCampaignRecords.mockResolvedValue({ text: 'archive data', sources: [{ kind: 'archive', id: '001', label: 'Archive scene 001', excerpt: 'A record.' }] });
    });

    it('uses exactly one system prompt and includes the visible latest swipe as delimited data', async () => {
        answerWith('The party is in Blackwater.');
        const answer = await answerOocQuestion({ question: 'Can you summarize our current position?', snapshot });
        expect(answer.text).toContain('Blackwater');
        expect(searchCampaignRecords).not.toHaveBeenCalled();
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0][5]).toEqual(OOC_READ_ONLY_TOOLS);
        const payload = sendMessage.mock.calls[0][1];
        expect(payload.filter((message: { role: string }) => message.role === 'system')).toHaveLength(1);
        const finalUser = payload.at(-1);
        expect(finalUser.role).toBe('user');
        expect(finalUser.content).toContain('READ-ONLY DATA START');
        expect(finalUser.content).toContain('READ-ONLY DATA END');
        expect(finalUser.content).toContain('Visible latest swipe');
        expect(finalUser.content).not.toContain('Default reply');
    });

    it('keeps bounded session-local OOC history as ordinary user and assistant turns', async () => {
        answerWith('Follow-up answer.');
        const long = 'x'.repeat(2_100);
        await answerOocQuestion({
            question: 'What did she say?', snapshot,
            history: [
                { id: 'old', role: 'user', content: 'Old question' },
                { id: 'previous-answer', role: 'assistant', content: long },
                { id: 'empty', role: 'assistant', content: '   ' },
                { id: 'recent', role: 'user', content: 'We were discussing Mira.' },
            ],
        });
        const payload = sendMessage.mock.calls[0][1];
        expect(payload.filter((message: { role: string }) => message.role === 'system')).toHaveLength(1);
        expect(payload.slice(1, -1)).toEqual([
            expect.objectContaining({ role: 'user', content: 'Old question' }),
            expect.objectContaining({ role: 'assistant', content: long.slice(0, 1_200) }),
            expect.objectContaining({ role: 'user', content: 'We were discussing Mira.' }),
        ]);
    });

    it('uses deterministic forced retrieval, prioritizes its source metadata, and keeps records in user data', async () => {
        shouldSearchOoc.mockReturnValue(true);
        answerWith('Mira held the key.');
        const answer = await answerOocQuestion({ question: 'What happened to Mira?', snapshot, forceSearch: true });
        expect(searchCampaignRecords).toHaveBeenCalledWith(snapshot, 'What happened to Mira?', undefined);
        expect(sendMessage.mock.calls[0][5]).toBeUndefined();
        expect(sendMessage.mock.calls[0][1].filter((message: { role: string }) => message.role === 'system')).toHaveLength(1);
        expect(sendMessage.mock.calls[0][1].at(-1).content).toContain('RETRIEVED RECORDS:\narchive data');
        expect(answer.archiveSearched).toBe(true);
        expect(answer.sources[0]).toMatchObject({ kind: 'archive', id: '001', label: 'Archive scene 001', excerpt: 'A record.' });
    });

    it('allows at most one OOC read-only tool call before a final answer', async () => {
        sendMessage
            .mockImplementationOnce((_provider, _messages, _onChunk, onDone) => onDone('', { id: 'tool-1', name: 'search_campaign_records', arguments: '{"query":"Mira"}' }))
            .mockImplementationOnce((_provider, _messages, onChunk, onDone) => { onChunk('Final answer'); onDone('Final answer'); });
        const answer = await answerOocQuestion({ question: 'Tell me about Mira', snapshot });
        expect(searchCampaignRecords).toHaveBeenCalledTimes(1);
        expect(searchCampaignRecords).toHaveBeenCalledWith(snapshot, 'Mira', undefined);
        expect(sendMessage).toHaveBeenCalledTimes(2);
        expect(sendMessage.mock.calls[0][5]).toEqual(OOC_READ_ONLY_TOOLS);
        expect(sendMessage.mock.calls[1][5]).toBeUndefined();
        expect(answer.text).toBe('Final answer');
    });

    it('fails gracefully without a campaign or story endpoint', async () => {
        await expect(answerOocQuestion({ question: 'Hello?', snapshot: { ...snapshot, campaignId: null } })).rejects.toThrow('Open a campaign');
        await expect(answerOocQuestion({ question: 'Hello?', snapshot: { ...snapshot, provider: undefined } })).rejects.toThrow('No story endpoint');
    });
});