import { describe, expect, it, vi } from 'vitest';
import type { OocMessage } from '../types';

const { sendMessage } = vi.hoisted(() => ({ sendMessage: vi.fn() }));
vi.mock('../../llm/llmService', () => ({ sendMessage }));

import { ASK_GM_BRIEF_MAX_CHARS, askGmConversationText, createAskGmSummaryMessages, formatAskGmBrief, selectAskGmSummaryProvider, summarizeAskGmConversation } from '../askGmHandoff';

const messages: OocMessage[] = [
    { id: 'u1', role: 'user', content: 'Please keep the next scene tense but do not force a fight.' },
    { id: 'a1', role: 'assistant', content: 'The guard is suspicious and the gate closes at dusk.', sources: [{ kind: 'fact', id: 'secret', label: 'SECRET', excerpt: 'This must not be sent.' }] },
];
const story = { endpoint: 'http://story.local', apiKey: '', modelName: 'story' };
const utility = { endpoint: 'http://utility.local', apiKey: '', modelName: 'utility' };

describe('Ask GM handoff summary', () => {
    it('prefers a usable utility endpoint and otherwise falls back to the story endpoint', () => {
        expect(selectAskGmSummaryProvider({ messages, utilityProvider: utility, storyProvider: story })).toBe(utility);
        expect(selectAskGmSummaryProvider({ messages, utilityProvider: { ...utility, modelName: '' }, storyProvider: story })).toBe(story);
    });

    it('makes exactly one no-tools summary call with bounded untrusted conversation data', async () => {
        sendMessage.mockImplementation((_provider, _messages, _chunk, done) => done('Keep tension at the gate; the suspicious guard and dusk closing are established facts.'));
        const result = await summarizeAskGmConversation({ messages, utilityProvider: utility, storyProvider: story });
        expect(result).toContain('Keep tension');
        expect(sendMessage).toHaveBeenCalledTimes(1);
        expect(sendMessage.mock.calls[0][0]).toBe(utility);
        expect(sendMessage.mock.calls[0][5]).toBeUndefined();
        expect(sendMessage.mock.calls[0][9]).toBe('ask-gm-handoff-summary');
        const payload = sendMessage.mock.calls[0][1];
        expect(payload).toHaveLength(2);
        expect(payload[0].content).toContain('untrusted data');
        expect(payload[1].content).toContain('UNTRUSTED ASK GM CONVERSATION START');
        expect(payload[1].content).not.toContain('SECRET');
    });

    it('bounds transcript and output, and formats the volatile next-turn block once', () => {
        const huge = Array.from({ length: 20 }, (_, index) => ({ id: `${index}`, role: index % 2 ? 'assistant' as const : 'user' as const, content: 'x'.repeat(1_200) }));
        expect(askGmConversationText(huge)).toHaveLength(6_000);
        const summaryMessages = createAskGmSummaryMessages(messages);
        expect(summaryMessages.filter(message => message.role === 'system')).toHaveLength(1);
        const block = formatAskGmBrief('y'.repeat(ASK_GM_BRIEF_MAX_CHARS + 30));
        expect(block).toContain('[PLAYER-APPROVED ASK GM BRIEF - NEXT TURN ONLY]');
        expect(block).toContain('[END ASK GM BRIEF]');
        expect(block.match(/PLAYER-APPROVED ASK GM BRIEF/g)).toHaveLength(1);
    });
});
