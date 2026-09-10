import { describe, it, expect } from 'vitest';
import { buildVisionBody, supportsVision, VisionUnsupportedFormatError, type VisionImage } from '../visionRequest';
import type { EndpointConfig } from '../../../types';

const IMG: VisionImage = { base64: 'QUJD', mediaType: 'image/jpeg' };

function provider(apiFormat: EndpointConfig['apiFormat']): EndpointConfig {
    return { endpoint: 'http://localhost:1234/v1', apiKey: 'k', modelName: 'm', apiFormat };
}

describe('buildVisionBody', () => {
    it('puts the image BEFORE the instruction for OpenAI-compatible providers', () => {
        const body = buildVisionBody(provider('openai'), IMG, 'describe this');
        const content = (body.messages as { content: { type: string }[] }[])[0].content;
        expect(content[0].type).toBe('image_url');
        expect(content[1].type).toBe('text');
    });

    it('puts the image BEFORE the instruction for Claude', () => {
        const body = buildVisionBody(provider('claude'), IMG, 'describe this');
        const content = (body.messages as { content: { type: string }[] }[])[0].content;
        expect(content[0].type).toBe('image');
        expect(content[1].type).toBe('text');
    });

    it('puts the image part BEFORE the text part for Gemini', () => {
        const body = buildVisionBody(provider('gemini'), IMG, 'describe this');
        const parts = (body.contents as { parts: Record<string, unknown>[] }[])[0].parts;
        expect(parts[0]).toHaveProperty('inline_data');
        expect(parts[1]).toHaveProperty('text');
    });

    it('encodes a data URL for OpenAI and raw base64 for Claude', () => {
        const openai = buildVisionBody(provider('openai'), IMG, 'x');
        const content = (openai.messages as { content: { image_url?: { url: string } }[] }[])[0].content;
        expect(content[0].image_url?.url).toBe('data:image/jpeg;base64,QUJD');

        const claude = buildVisionBody(provider('claude'), IMG, 'x');
        const cContent = (claude.messages as { content: { source?: { data: string; media_type: string } }[] }[])[0].content;
        expect(cContent[0].source).toEqual({ type: 'base64', media_type: 'image/jpeg', data: 'QUJD' });
    });

    it('uses Ollama’s sibling images array rather than content blocks', () => {
        const body = buildVisionBody(provider('ollama'), IMG, 'describe this');
        const msg = (body.messages as { content: string; images: string[] }[])[0];
        expect(msg.content).toBe('describe this');
        expect(msg.images).toEqual(['QUJD']);
    });

    it('never streams, and never sends tools or a thinking budget', () => {
        for (const fmt of ['openai', 'claude', 'gemini', 'ollama'] as const) {
            const body = buildVisionBody(provider(fmt), IMG, 'x');
            expect(body.stream ?? false).toBe(false);
            expect(body.tools).toBeUndefined();
            expect(body.thinking).toBeUndefined();
            expect(body.reasoning_effort).toBeUndefined();
        }
    });

    it('rejects ComfyUI — it generates images, it cannot read them', () => {
        expect(() => buildVisionBody(provider('comfyui'), IMG, 'x')).toThrow(VisionUnsupportedFormatError);
        expect(supportsVision(provider('comfyui'))).toBe(false);
        expect(supportsVision(provider('openai'))).toBe(true);
    });

    it('defaults apiFormat to openai when unset', () => {
        const bare: EndpointConfig = { endpoint: 'http://x/v1', apiKey: '', modelName: 'm' };
        const body = buildVisionBody(bare, IMG, 'x');
        const content = (body.messages as { content: { type: string }[] }[])[0].content;
        expect(content[0].type).toBe('image_url');
    });
});
