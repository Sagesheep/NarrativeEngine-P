import type { EndpointConfig } from '../../types';
import { llmFetch } from '../llm/llmFetch';
import {
    isOpenRouterImageProvider,
    openRouterImagesUrl,
    buildOpenRouterImageBody,
    extractOpenRouterImage,
} from '../../utils/openRouterImage';

// ============================================================================
// Image Generation API
// ============================================================================

const PORTRAIT_NEGATIVE = 'multiple people, group, crowd, split screen, twins, double, text, watermark, signature';

/** Returns either a hosted image URL or a `data:` URI — both are accepted by
 *  downloadImageToLocal(), which hands the value to the server to fetch and store. */
export async function generateNPCPortrait(config: EndpointConfig, prompt: string): Promise<string> {
    if (!config.endpoint) {
        throw new Error('Image AI not configured');
    }

    const openRouter = isOpenRouterImageProvider(config);

    if (openRouter && !config.modelName) {
        throw new Error('OpenRouter requires an image model name (e.g. google/gemini-2.5-flash-image) in the provider settings.');
    }

    // OpenRouter's native image API vs. the OpenAI-compatible /images/generations shape.
    const payload = openRouter
        ? buildOpenRouterImageBody(config.modelName, prompt, '3:4', '3:4')
        : {
            model: config.modelName || 'nano-banana',
            prompt,
            negative_prompt: PORTRAIT_NEGATIVE,
            size: '896x1152',
            response_format: 'url',
        };

    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
    };
    if (config.apiKey) {
        headers['Authorization'] = `Bearer ${config.apiKey}`;
    }

    // Normalize: strip trailing slashes and any pre-existing /images/generations suffix,
    // then always append the correct path. Works for both base endpoints and full paths.
    const baseEndpoint = config.endpoint
        .replace(/\/+$/, '')                   // strip trailing slashes
        .replace(/\/images\/generations$/, ''); // strip suffix if already present
    const url = openRouter ? openRouterImagesUrl(config.endpoint) : `${baseEndpoint}/images/generations`;

    try {
        console.log('[Image Engine] Sending payload:', payload);
        const res = await llmFetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(payload),
        });

        if (!res.ok) {
            const err = await res.text();
            throw new Error(`Failed to generate image: ${err}`);
        }

        const data = await res.json();

        if (openRouter) {
            // OpenRouter answers with base64 bytes, not a URL.
            const image = extractOpenRouterImage(data);
            if (image) return image;
            throw new Error('Unexpected output format from OpenRouter: ' + JSON.stringify(data));
        }

        // Match nano-gpt return format
        if (data.data && data.data[0] && data.data[0].url) {
            return data.data[0].url;
        }

        throw new Error('Unexpected output format from Image AI: ' + JSON.stringify(data));
    } catch (error) {
        console.error('[Image Engine] Error generating portrait:', error);
        throw error;
    }
}
