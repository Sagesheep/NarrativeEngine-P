import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EndpointConfig } from '../../../types';

const llmFetch = vi.fn();
vi.mock('../../llm/llmFetch', () => ({ llmFetch: (...args: unknown[]) => llmFetch(...args) }));

import { describeImage } from '../describeImage';
import { VisionUnsupportedFormatError } from '../visionRequest';
import { getActiveCalls } from '../../llm/utilityCallTracker';

const IMAGE = { base64: 'QUJD', mediaType: 'image/jpeg' };

const GOOD_JSON = JSON.stringify({
    race: 'human',
    hairStyle: 'short silver',
    clothing: 'battered longcoat',
    appearance: 'A weathered traveller in a battered longcoat.',
});

function okResponse(payload: unknown) {
    return { ok: true, status: 200, json: async () => payload, text: async () => JSON.stringify(payload) } as unknown as Response;
}

function openAiProvider(): EndpointConfig {
    return { endpoint: 'https://api.example.com/v1', apiKey: 'sk-test', modelName: 'vision-model', apiFormat: 'openai' };
}

beforeEach(() => {
    llmFetch.mockReset();
});

describe('describeImage', () => {
    it('sends image-before-text to the provider chat URL and parses the reply', async () => {
        llmFetch.mockResolvedValue(okResponse({ choices: [{ message: { content: GOOD_JSON } }] }));

        const out = await describeImage(openAiProvider(), IMAGE, { subjectName: 'Kael' });

        expect(llmFetch).toHaveBeenCalledTimes(1);
        const [url, init] = llmFetch.mock.calls[0] as [string, RequestInit];
        expect(url).toBe('https://api.example.com/v1/chat/completions');
        expect(init.method).toBe('POST');

        const body = JSON.parse(init.body as string);
        expect(body.model).toBe('vision-model');
        expect(body.stream).toBe(false);
        expect(body.messages[0].content[0].type).toBe('image_url');
        expect(body.messages[0].content[1].type).toBe('text');
        expect(body.messages[0].content[1].text).toContain('named Kael');

        expect(out.visualProfile.race).toBe('human');
        expect(out.visualProfile.clothing).toBe('battered longcoat');
        expect(out.appearance).toContain('battered longcoat');
    });

    it('appends the Gemini key to the URL rather than a header', async () => {
        llmFetch.mockResolvedValue(okResponse({ candidates: [{ content: { parts: [{ text: GOOD_JSON }] } }] }));
        const gemini: EndpointConfig = {
            endpoint: 'https://generativelanguage.googleapis.com/v1beta',
            apiKey: 'gkey', modelName: 'gemini-vision', apiFormat: 'gemini',
        };

        await describeImage(gemini, IMAGE);

        const [url] = llmFetch.mock.calls[0] as [string];
        expect(url).toContain(':generateContent');
        expect(url).toContain('key=gkey');
    });

    it('surfaces a provider error with its status and body', async () => {
        llmFetch.mockResolvedValue({
            ok: false, status: 400, text: async () => 'model does not support images',
        } as unknown as Response);

        await expect(describeImage(openAiProvider(), IMAGE)).rejects.toThrow(/400.*does not support images/);
    });

    it('refuses to call an image-generation endpoint', async () => {
        const comfy: EndpointConfig = { endpoint: 'http://127.0.0.1:8188', apiKey: '', modelName: 'sdxl', apiFormat: 'comfyui' };
        await expect(describeImage(comfy, IMAGE)).rejects.toThrow(VisionUnsupportedFormatError);
        expect(llmFetch).not.toHaveBeenCalled();
    });

    it('leaves no call hanging in the tracker after success or failure', async () => {
        const before = getActiveCalls().length;

        llmFetch.mockResolvedValue(okResponse({ choices: [{ message: { content: GOOD_JSON } }] }));
        await describeImage(openAiProvider(), IMAGE);
        expect(getActiveCalls().length).toBe(before);

        llmFetch.mockRejectedValue(new Error('network down'));
        await expect(describeImage(openAiProvider(), IMAGE)).rejects.toThrow('network down');
        expect(getActiveCalls().length).toBe(before);
    });
});
