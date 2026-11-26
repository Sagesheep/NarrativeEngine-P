import type { EndpointConfig, ProviderConfig } from '../../types';
import { getApiFormat } from '../../utils/llmApiHelper';

/**
 * Vision request bodies — image + instruction, one shot, non-streaming.
 *
 * WHY THIS DOES NOT GO THROUGH `buildChatBody`: every other call in the app
 * sends `content: string`. The turn pipeline, the archive, the embeddings
 * indexer and the cache-prefix logic all assume that. Widening the shared
 * message type to carry image blocks would put every one of those on the
 * blast radius for a feature only two buttons use. This module owns the
 * multimodal wire format and nothing else imports it.
 *
 * BLOCK ORDER: the image goes FIRST, the instruction second. That is the
 * documented recommendation for a single image (Anthropic vision docs) and
 * the shape every provider's own examples use — the text is a question
 * *about* the image, so showing before asking reads coherently. Ollama is
 * the exception: it takes a flat `images: string[]` alongside the text and
 * gives you no ordering control.
 */

export type VisionImage = {
    /** Raw base64 payload — NO `data:` prefix and no newlines (providers reject both). */
    base64: string;
    /** MIME type, e.g. `image/jpeg`. */
    mediaType: string;
};

export class VisionUnsupportedFormatError extends Error {
    constructor(format: string) {
        super(`Provider format "${format}" cannot read images. Pick a multimodal endpoint (OpenAI-compatible, Claude, Gemini or Ollama).`);
        this.name = 'VisionUnsupportedFormatError';
    }
}

const DEFAULT_MAX_TOKENS = 1200;

/**
 * Build the request body for a single-image describe call.
 * Deliberately minimal: no tools, no sampling block, no thinking config. A
 * caption call wants determinism, not reasoning budget.
 */
export function buildVisionBody(
    provider: EndpointConfig | ProviderConfig,
    image: VisionImage,
    instruction: string,
    opts?: { maxTokens?: number; temperature?: number },
): Record<string, unknown> {
    const format = getApiFormat(provider);
    const maxTokens = opts?.maxTokens ?? DEFAULT_MAX_TOKENS;
    const temperature = opts?.temperature ?? 0.2;

    if (format === 'comfyui') {
        // ComfyUI generates images, it cannot read them.
        throw new VisionUnsupportedFormatError(format);
    }

    if (format === 'claude') {
        return {
            model: provider.modelName,
            max_tokens: maxTokens,
            temperature,
            stream: false,
            messages: [{
                role: 'user',
                content: [
                    { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } },
                    { type: 'text', text: instruction },
                ],
            }],
        };
    }

    if (format === 'gemini') {
        return {
            contents: [{
                role: 'user',
                parts: [
                    { inline_data: { mime_type: image.mediaType, data: image.base64 } },
                    { text: instruction },
                ],
            }],
            generationConfig: { maxOutputTokens: maxTokens, temperature },
        };
    }

    if (format === 'ollama') {
        // Ollama's native chat API takes base64 strings in a sibling `images`
        // array — there is no content-block ordering to control here.
        return {
            model: provider.modelName,
            stream: false,
            messages: [{ role: 'user', content: instruction, images: [image.base64] }],
            options: { temperature },
        };
    }

    // OpenAI-compatible (also OpenRouter, LM Studio, vLLM, NVIDIA NIM, …)
    return {
        model: provider.modelName,
        max_tokens: maxTokens,
        temperature,
        stream: false,
        messages: [{
            role: 'user',
            content: [
                { type: 'image_url', image_url: { url: `data:${image.mediaType};base64,${image.base64}` } },
                { type: 'text', text: instruction },
            ],
        }],
    };
}

/** True when this provider format can accept an image at all. */
export function supportsVision(provider: EndpointConfig | ProviderConfig): boolean {
    return getApiFormat(provider) !== 'comfyui';
}
