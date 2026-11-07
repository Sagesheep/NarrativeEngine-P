import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CharacterCreationDraft, EndpointConfig, LoreChunk } from '../../../types';

const sendMessage = vi.fn();
vi.mock('../../llm/llmService', () => ({
    sendMessage: (...args: unknown[]) => sendMessage(...args),
}));

import {
    applyRolledAnswers,
    blankSlots,
    canRollSlot,
    rollCreationSlots,
    setPlayerSlotValue,
} from '../aiGuidedGeneration';

const provider = { endpoint: 'http://x', modelName: 'x' } as EndpointConfig;

function chunk(over: Partial<LoreChunk>): LoreChunk {
    return {
        id: 'c', header: 'Overview', content: 'A world of iron.', tokens: 5, alwaysInclude: false,
        triggerKeywords: [], scanDepth: 0, category: 'world_overview', linkedEntities: [], priority: 5,
        ...over,
    };
}

const lore = [
    chunk({ id: 'a', header: 'Old Kesh', content: 'A drowned port city.', category: 'location' }),
    chunk({ id: 'b', header: 'Iron Ward', content: 'A guild of smiths.', category: 'faction' }),
    chunk({ id: 'c', header: 'Mira Vane', content: 'A famous NPC.', category: 'character' }),
];

/** Make the mocked model answer with `reply` and expose the prompt it received. */
function modelReplies(reply: string): { prompt: () => string } {
    let prompt = '';
    sendMessage.mockImplementation((_p, messages, _onChunk, onDone) => {
        prompt = messages[0].content;
        onDone(reply);
    });
    return { prompt: () => prompt };
}

beforeEach(() => {
    sendMessage.mockReset();
});

describe('rollCreationSlots', () => {
    it('maps numbered lines onto non-contiguous slots, including name and appearance', async () => {
        modelReplies('1) Tamsin Vael\n2) **The Iron Ward**\n3) a hammer, a lantern\n4) Lean and soot-marked.');
        const draft: CharacterCreationDraft = { name: '', answers: { 2: 'Old Kesh' } };

        const result = await rollCreationSlots(provider, draft, [1, 3, 8, 9], lore);

        expect(result).toEqual({
            ok: true,
            values: { 1: 'Tamsin Vael', 3: 'The Iron Ward', 8: 'a hammer, a lantern', 9: 'Lean and soot-marked.' },
        });
    });

    it('builds the roll around the player answers, and leaves NPC bios out of the lore', async () => {
        const model = modelReplies('1) Tamsin');
        const draft: CharacterCreationDraft = { answers: { 2: 'Raised on the docks' } };

        await rollCreationSlots(provider, draft, [1], lore);

        expect(model.prompt()).toContain('Raised on the docks');
        expect(model.prompt()).toContain('A drowned port city.');
        expect(model.prompt()).not.toContain('Mira Vane');
        expect(model.prompt()).not.toMatch(/personalityHex|traits/);
    });

    it('tells the model not to repeat an answer it is re-rolling', async () => {
        const model = modelReplies('1) Tamsin');
        await rollCreationSlots(provider, { name: 'Kael', aiRolledSlots: [1] }, [1], lore);
        expect(model.prompt().split('[ALREADY SUGGESTED')[1]).toContain('Kael');
    });

    it('issues no call without lore, and reports a short reply as unparseable', async () => {
        expect(await rollCreationSlots(provider, {}, [1], [lore[2]])).toEqual({ ok: false, reason: 'no-lore' });
        expect(sendMessage).not.toHaveBeenCalled();

        modelReplies('1) Only one answer');
        expect(await rollCreationSlots(provider, {}, [1, 2], lore)).toEqual({ ok: false, reason: 'unparseable' });
    });

    it('reports a failed call', async () => {
        sendMessage.mockImplementation((_p, _m, _c, _d, onError) => onError('network down'));
        expect(await rollCreationSlots(provider, {}, [1], lore)).toEqual({ ok: false, reason: 'call-failed' });
    });
});

describe('player answers stay the player\'s', () => {
    it('blankSlots ignores whitespace and counts name and appearance', () => {
        const draft: CharacterCreationDraft = { name: '  ', appearance: 'tall', answers: { 2: 'x', 3: ' ' } };
        expect(blankSlots(draft)).toEqual([1, 3, 4, 5, 6, 7, 8]);
    });

    it('a rolled answer can be re-rolled until the player edits it', () => {
        let draft = applyRolledAnswers({ name: '' }, { 1: 'Tamsin' });
        expect(draft.name).toBe('Tamsin');
        expect(canRollSlot(draft, 1)).toBe(true);

        draft = setPlayerSlotValue(draft, 1, 'Tamsin the Red');
        expect(canRollSlot(draft, 1)).toBe(false);
    });

    it('applyRolledAnswers never overwrites text the player typed during the call', () => {
        const draft = setPlayerSlotValue({ answers: {} }, 3, 'The Ash Court');
        const next = applyRolledAnswers(draft, { 3: 'The Iron Ward', 4: 'smithing' });
        expect(next.answers).toEqual({ 3: 'The Ash Court', 4: 'smithing' });
        expect(next.aiRolledSlots).toEqual([4]);
    });
});
