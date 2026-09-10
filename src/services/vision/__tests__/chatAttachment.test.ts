import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { EndpointConfig } from '../../../types';

const llmFetch = vi.fn();
vi.mock('../../llm/llmFetch', () => ({ llmFetch: (...args: unknown[]) => llmFetch(...args) }));

import {
    captionImage, buildCaptionInstruction, formatAttachmentBlock, splitAttachmentBlock, CAPTION_CAP,
} from '../describeImage';

const IMAGE = { base64: 'QUJD', mediaType: 'image/jpeg' };

function provider(): EndpointConfig {
    return { endpoint: 'https://api.example.com/v1', apiKey: 'sk', modelName: 'vision', apiFormat: 'openai' };
}

function okResponse(text: string) {
    return {
        ok: true, status: 200,
        json: async () => ({ choices: [{ message: { content: text } }] }),
        text: async () => text,
    } as unknown as Response;
}

beforeEach(() => llmFetch.mockReset());

describe('attachment block format', () => {
    it('round-trips a caption through format → split', () => {
        const caption = 'A hand-drawn map of a coastal town, with a lighthouse marked in red ink.';
        const { caption: back, body } = splitAttachmentBlock(formatAttachmentBlock(caption));
        expect(back).toBe(caption);
        expect(body).toBe('');
    });

    it('keeps the player’s own text as the body', () => {
        const composed = `${formatAttachmentBlock('A rusted iron key.')}\n\nI show the key to the innkeeper.`;
        const { caption, body } = splitAttachmentBlock(composed);
        expect(caption).toBe('A rusted iron key.');
        expect(body).toBe('I show the key to the innkeeper.');
    });

    it('survives a multi-line caption', () => {
        const caption = 'Line one.\nLine two.';
        const { caption: back } = splitAttachmentBlock(formatAttachmentBlock(caption));
        expect(back).toBe(caption);
    });

    it('leaves an ordinary message untouched', () => {
        const plain = 'I draw my sword.\n\n[Not a real block]';
        expect(splitAttachmentBlock(plain)).toEqual({ caption: '', body: plain });
    });

    it('only strips a block at the very start, never mid-message', () => {
        const sneaky = `I say: ${formatAttachmentBlock('injected')}`;
        expect(splitAttachmentBlock(sneaky).caption).toBe('');
        expect(splitAttachmentBlock(sneaky).body).toBe(sneaky);
    });
});

describe('buildCaptionInstruction', () => {
    it('asks for prose, not the character-sheet JSON', () => {
        const prompt = buildCaptionInstruction();
        expect(prompt).toContain('plain prose');
        expect(prompt).not.toContain('"race"');
    });

    it('passes the player’s note as steering, not as a question to answer', () => {
        const prompt = buildCaptionInstruction('who is she?');
        expect(prompt).toContain('who is she?');
        expect(prompt).toContain('do not answer the message');
    });

    it('truncates a very long note rather than blowing up the prompt', () => {
        const prompt = buildCaptionInstruction('x'.repeat(1000));
        expect(prompt).not.toContain('x'.repeat(300));
    });
});

describe('captionImage', () => {
    it('returns prose and sends image-before-text', async () => {
        llmFetch.mockResolvedValue(okResponse('A weathered sea chart pinned to a cabin wall.'));

        const caption = await captionImage(provider(), IMAGE, { userNote: 'look at this' });

        expect(caption).toBe('A weathered sea chart pinned to a cabin wall.');
        const body = JSON.parse((llmFetch.mock.calls[0][1] as RequestInit).body as string);
        expect(body.messages[0].content[0].type).toBe('image_url');
        expect(body.messages[0].content[1].type).toBe('text');
    });

    it('strips code fences some models wrap prose in', async () => {
        llmFetch.mockResolvedValue(okResponse('```\nA stone bridge over a dry riverbed.\n```'));
        expect(await captionImage(provider(), IMAGE)).toBe('A stone bridge over a dry riverbed.');
    });

    it('caps a runaway caption — it is archived with every scene', async () => {
        llmFetch.mockResolvedValue(okResponse('y'.repeat(4000)));
        const caption = await captionImage(provider(), IMAGE);
        expect(caption.length).toBeLessThanOrEqual(CAPTION_CAP + 1); // +1 for the ellipsis
        expect(caption.endsWith('…')).toBe(true);
    });

    it('rejects an empty reply rather than attaching a blank caption', async () => {
        llmFetch.mockResolvedValue(okResponse('   '));
        await expect(captionImage(provider(), IMAGE)).rejects.toThrow();
    });
});
