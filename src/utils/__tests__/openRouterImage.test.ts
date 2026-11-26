import { describe, it, expect } from 'vitest';
import {
    isOpenRouterImageProvider,
    openRouterImagesUrl,
    toOpenRouterAspectRatio,
    buildOpenRouterImageBody,
    extractOpenRouterImage,
} from '../openRouterImage';

describe('isOpenRouterImageProvider', () => {
    it('matches the explicit apiFormat', () => {
        expect(isOpenRouterImageProvider({ endpoint: 'https://example.com/v1', apiFormat: 'openrouter' })).toBe(true);
    });

    it('matches openrouter.ai by host even when the format says openai', () => {
        // The 404 this fixes: an 'openai' provider pointed at OpenRouter can never
        // resolve /images/generations, so the host wins.
        expect(isOpenRouterImageProvider({ endpoint: 'https://openrouter.ai/api/v1/images', apiFormat: 'openai' })).toBe(true);
    });

    it('leaves other providers alone', () => {
        expect(isOpenRouterImageProvider({ endpoint: 'https://api.openai.com/v1', apiFormat: 'openai' })).toBe(false);
        expect(isOpenRouterImageProvider({ endpoint: 'http://127.0.0.1:8188', apiFormat: 'comfyui' })).toBe(false);
        expect(isOpenRouterImageProvider({ endpoint: '', apiFormat: 'openai' })).toBe(false);
        expect(isOpenRouterImageProvider({ endpoint: 'not a url' })).toBe(false);
    });

    it('does not match lookalike hosts', () => {
        expect(isOpenRouterImageProvider({ endpoint: 'https://openrouter.ai.evil.test/v1' })).toBe(false);
    });
});

describe('openRouterImagesUrl', () => {
    it('leaves a correct endpoint untouched', () => {
        expect(openRouterImagesUrl('https://openrouter.ai/api/v1/images')).toBe('https://openrouter.ai/api/v1/images');
    });

    it('does not double the /images segment', () => {
        // The reported bug: the OpenAI path builder produced /api/v1/images/images/generations.
        expect(openRouterImagesUrl('https://openrouter.ai/api/v1/images/')).toBe('https://openrouter.ai/api/v1/images');
    });

    it('appends /images to the api base', () => {
        expect(openRouterImagesUrl('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/images');
    });

    it('expands a bare host to the canonical path', () => {
        expect(openRouterImagesUrl('https://openrouter.ai')).toBe('https://openrouter.ai/api/v1/images');
        expect(openRouterImagesUrl('https://openrouter.ai/')).toBe('https://openrouter.ai/api/v1/images');
    });

    it('recovers from a pasted chat path', () => {
        expect(openRouterImagesUrl('https://openrouter.ai/api/v1/chat/completions'))
            .toBe('https://openrouter.ai/api/v1/images');
    });

    it('recovers from a pasted OpenAI image path', () => {
        expect(openRouterImagesUrl('https://openrouter.ai/api/v1/images/generations'))
            .toBe('https://openrouter.ai/api/v1/images');
    });
});

describe('toOpenRouterAspectRatio', () => {
    it('passes through supported ratios', () => {
        expect(toOpenRouterAspectRatio('16:9')).toBe('16:9');
        expect(toOpenRouterAspectRatio('3:4')).toBe('3:4');
    });

    it('falls back for unsupported or missing values', () => {
        expect(toOpenRouterAspectRatio('896x1152')).toBe('1:1');
        expect(toOpenRouterAspectRatio(undefined)).toBe('1:1');
        expect(toOpenRouterAspectRatio(undefined, '3:4')).toBe('3:4');
    });
});

describe('buildOpenRouterImageBody', () => {
    it('emits OpenRouter field names and omits negative_prompt', () => {
        const body = buildOpenRouterImageBody('google/gemini-2.5-flash-image', 'a lantern-lit alley', '16:9');
        expect(body).toEqual({
            model: 'google/gemini-2.5-flash-image',
            prompt: 'a lantern-lit alley',
            n: 1,
            aspect_ratio: '16:9',
            output_format: 'png',
        });
        expect(body).not.toHaveProperty('size');
        expect(body).not.toHaveProperty('negative_prompt');
        expect(body).not.toHaveProperty('response_format');
    });
});

describe('extractOpenRouterImage', () => {
    it('turns b64_json into a data URI using the reported media type', () => {
        expect(extractOpenRouterImage({ data: [{ b64_json: 'AAAA', media_type: 'image/webp' }] }))
            .toBe('data:image/webp;base64,AAAA');
    });

    it('defaults the media type to png', () => {
        expect(extractOpenRouterImage({ data: [{ b64_json: 'AAAA' }] }))
            .toBe('data:image/png;base64,AAAA');
    });

    it('falls back to a url when one is present', () => {
        expect(extractOpenRouterImage({ data: [{ url: 'https://cdn.test/x.png' }] })).toBe('https://cdn.test/x.png');
    });

    it('returns null when there is no image', () => {
        expect(extractOpenRouterImage({ data: [] })).toBeNull();
        expect(extractOpenRouterImage({})).toBeNull();
        expect(extractOpenRouterImage(null)).toBeNull();
    });
});
