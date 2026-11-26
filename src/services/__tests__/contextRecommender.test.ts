/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/llmCall', () => ({
    llmCall: vi.fn(),
}));
vi.mock('../turn/contextMinifier', () => ({
    buildInventoryIndex: vi.fn(() => '(empty inventory)'),
    buildProfileIndex: vi.fn(() => '(empty profile)'),
}));

import { llmCall } from '../../utils/llmCall';
import { recommendContext } from '../turn/contextRecommender';
import type { EndpointConfig } from '../../types';

const mockLlmCall = vi.mocked(llmCall);

const endpoint: EndpointConfig = {
    endpoint: 'http://localhost',
    modelName: 'test-model',
} as any;

const emptyResult = {
    relevantNPCNames: [],
    relevantLoreIds: [],
    inventoryCategories: [],
    profileFields: [],
};

describe('recommendContext', () => {
    beforeEach(() => vi.clearAllMocks());

    it('parses a clean JSON object response', async () => {
        mockLlmCall.mockResolvedValueOnce(
            '{"npcs":["Elara","Brom"],"lore":["lore-01"],"inventoryCategories":["weapon"],"profileFields":["name","hp"]}'
        );

        const result = await recommendContext(endpoint, [], [], [], 'attack the goblin');
        expect(result.relevantNPCNames).toEqual(['Elara', 'Brom']);
        expect(result.relevantLoreIds).toEqual(['lore-01']);
        expect(result.inventoryCategories).toEqual(['weapon']);
        expect(result.profileFields).toEqual(['name', 'hp']);
    });

    it('parses a <think>-wrapped + fenced JSON response', async () => {
        mockLlmCall.mockResolvedValueOnce(
            '<think>I should identify relevant NPCs.</think>\n```json\n' +
            '{"npcs":["Guard Captain"],"lore":[],"inventoryCategories":["equipped"],"profileFields":["name"]}\n```'
        );

        const result = await recommendContext(endpoint, [], [], [], 'talk to the guard');
        expect(result.relevantNPCNames).toEqual(['Guard Captain']);
        expect(result.inventoryCategories).toEqual(['equipped']);
    });

    it('recovers from a truncated JSON response (truncation recovery path)', async () => {
        // Object truncated after inventoryCategories — profileFields missing
        mockLlmCall.mockResolvedValueOnce(
            '{"npcs":["Mira"],"lore":["lore-02"],"inventoryCategories":["armor"]'
        );

        const result = await recommendContext(endpoint, [], [], [], 'defend yourself');
        expect(result.relevantNPCNames).toEqual(['Mira']);
        expect(result.relevantLoreIds).toEqual(['lore-02']);
        expect(result.inventoryCategories).toEqual(['armor']);
    });

    it('throws when no JSON is found in the response', async () => {
        mockLlmCall.mockResolvedValueOnce('I cannot determine relevance right now.');

        await expect(
            recommendContext(endpoint, [], [], [], 'anything')
        ).rejects.toThrow('No valid JSON in recommender response');
    });

    it('filters out invalid inventoryCategories values', async () => {
        mockLlmCall.mockResolvedValueOnce(
            '{"npcs":[],"lore":[],"inventoryCategories":["weapon","invalid_cat","equipped"],"profileFields":[]}'
        );

        const result = await recommendContext(endpoint, [], [], [], 'fight');
        expect(result.inventoryCategories).toEqual(['weapon', 'equipped']);
        expect(result.inventoryCategories).not.toContain('invalid_cat');
    });

    it('filters out invalid profileFields values', async () => {
        mockLlmCall.mockResolvedValueOnce(
            '{"npcs":[],"lore":[],"inventoryCategories":[],"profileFields":["name","badField","hp"]}'
        );

        const result = await recommendContext(endpoint, [], [], [], 'rest');
        expect(result.profileFields).toEqual(['name', 'hp']);
        expect(result.profileFields).not.toContain('badField');
    });

    it('returns empty arrays when JSON fields are absent', async () => {
        mockLlmCall.mockResolvedValueOnce('{}');

        const result = await recommendContext(endpoint, [], [], [], 'wander');
        expect(result).toMatchObject(emptyResult);
    });

    // The recommenderThinking block: off by default (thinking took each pick from ~1 s
    // to ~20 s on DS v4 Flash and chose no better); on, the endpoint's effort applies.
    it('asks for thinking off by default, on both call paths', async () => {
        mockLlmCall.mockResolvedValueOnce('{}');
        await recommendContext(endpoint, [], [], [], 'wander');
        expect(mockLlmCall.mock.calls[0][2]).toMatchObject({ thinkingEffort: 'off' });

        const modelCall = vi.fn().mockResolvedValue({ content: '{}' });
        await recommendContext(undefined, [], [], [], 'wander', undefined, undefined, undefined, undefined, undefined, modelCall);
        expect(modelCall.mock.calls[0][0]).toMatchObject({ thinkingEffort: 'off' });
    });

    it('with the thinking block on, leaves the endpoint\'s own effort in place', async () => {
        const modelCall = vi.fn().mockResolvedValue({ content: '{}' });
        await recommendContext(undefined, [], [], [], 'wander', undefined, undefined, undefined, undefined, undefined, modelCall, true);
        expect(modelCall.mock.calls[0][0].thinkingEffort).toBeUndefined();
    });
});
