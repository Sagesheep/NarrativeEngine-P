import { describe, it, expect, vi, beforeEach } from 'vitest';
import { generateNPCPortrait } from '../portrait';
import { llmFetch } from '../../llm/llmFetch';

vi.mock('../../llm/llmFetch', () => ({ llmFetch: vi.fn() }));

const mockLlmFetch = vi.mocked(llmFetch);

function jsonResponse(body: unknown) {
    return {
        ok: true,
        json: async () => body,
        text: async () => JSON.stringify(body),
    } as unknown as Response;
}

function lastCall() {
    const [url, init] = mockLlmFetch.mock.calls[mockLlmFetch.mock.calls.length - 1];
    return { url, body: JSON.parse(String(init?.body)) };
}

describe('generateNPCPortrait — OpenRouter', () => {
    beforeEach(() => {
        mockLlmFetch.mockReset();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('posts to /api/v1/images instead of doubling the path', async () => {
        mockLlmFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: 'AAAA', media_type: 'image/png' }] }));

        await generateNPCPortrait(
            { endpoint: 'https://openrouter.ai/api/v1/images', apiKey: 'sk-or-v1-x', modelName: 'google/gemini-2.5-flash-image' },
            'a weathered sellsword',
        );

        expect(lastCall().url).toBe('https://openrouter.ai/api/v1/images');
    });

    it('sends OpenRouter fields rather than the OpenAI image shape', async () => {
        mockLlmFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: 'AAAA' }] }));

        await generateNPCPortrait(
            { endpoint: 'https://openrouter.ai/api/v1', apiKey: '', modelName: 'google/gemini-2.5-flash-image' },
            'a weathered sellsword',
        );

        const { body } = lastCall();
        expect(body.aspect_ratio).toBe('3:4');
        expect(body.model).toBe('google/gemini-2.5-flash-image');
        expect(body.size).toBeUndefined();
        expect(body.negative_prompt).toBeUndefined();
        expect(body.response_format).toBeUndefined();
    });

    it('returns the base64 image as a data URI', async () => {
        mockLlmFetch.mockResolvedValue(jsonResponse({ data: [{ b64_json: 'AAAA', media_type: 'image/png' }] }));

        const result = await generateNPCPortrait(
            { endpoint: 'https://openrouter.ai/api/v1', apiKey: '', modelName: 'google/gemini-2.5-flash-image' },
            'a weathered sellsword',
        );

        expect(result).toBe('data:image/png;base64,AAAA');
    });

    it('fails fast with a useful message when no model is set', async () => {
        await expect(generateNPCPortrait(
            { endpoint: 'https://openrouter.ai/api/v1', apiKey: '', modelName: '' },
            'a weathered sellsword',
        )).rejects.toThrow(/requires an image model name/i);
        expect(mockLlmFetch).not.toHaveBeenCalled();
    });
});

describe('generateNPCPortrait — OpenAI-compatible providers', () => {
    beforeEach(() => {
        mockLlmFetch.mockReset();
        vi.spyOn(console, 'log').mockImplementation(() => {});
        vi.spyOn(console, 'error').mockImplementation(() => {});
    });

    it('still uses /images/generations and the OpenAI payload', async () => {
        mockLlmFetch.mockResolvedValue(jsonResponse({ data: [{ url: 'https://cdn.test/x.png' }] }));

        const result = await generateNPCPortrait(
            { endpoint: 'https://api.openai.com/v1', apiKey: 'sk-x', modelName: 'gpt-image-1' },
            'a weathered sellsword',
        );

        const { url, body } = lastCall();
        expect(url).toBe('https://api.openai.com/v1/images/generations');
        expect(body.size).toBe('896x1152');
        expect(body.response_format).toBe('url');
        expect(body.negative_prompt).toContain('watermark');
        expect(result).toBe('https://cdn.test/x.png');
    });

    it('throws when the endpoint is unset', async () => {
        await expect(generateNPCPortrait(
            { endpoint: '', apiKey: '', modelName: 'x' },
            'prompt',
        )).rejects.toThrow('Image AI not configured');
    });
});
