import type { ComfyUiSettings, EndpointConfig } from '../../types';
import { llmFetch } from '../llm/llmFetch';
import { API_BASE } from '../../lib/apiBase';
import {
    isOpenRouterImageProvider,
    openRouterImagesUrl,
    buildOpenRouterImageBody,
    extractOpenRouterImage,
} from '../../utils/openRouterImage';
import { mergeCustomBody } from '../../utils/llmApiHelper';

/** The prompt is what makes each image this image; a custom body may change anything else. */
const PROTECTED_IMAGE_FIELDS = new Set(['prompt']);

// ============================================================================
// Image Generation API
// ============================================================================

// Matches the scene-image negative list (server/services/imageProvider.js) — the portrait
// path used to carry a much shorter one, which let name captions and seal stamps through.
// OpenRouter has no negative_prompt field, so buildPortraitPrompt() states the same rule
// in the positive prompt; both are needed.
const PORTRAIT_NEGATIVE = 'multiple people, group, crowd, split screen, twins, double, text, words, writing, letters, font, typography, calligraphy, handwriting, captions, subtitles, nameplate, seal stamp, watermark, logo, signature';

/** The image-role provider as the store hands it over: an LLMProvider, which carries
 *  `comfyUi` when its apiFormat is 'comfyui'. */
type ImageEndpointConfig = EndpointConfig & { comfyUi?: ComfyUiSettings };

/** ComfyUI has no /images/generations route, so its images are made server-side by the
 *  same workflow scene images use (comfyUi steps/cfg/sampler/scheduler/denoise apply). */
async function generateViaComfyUI(config: ImageEndpointConfig, prompt: string, layout: 'portrait' | 'landscape'): Promise<string> {
    const [width, height] = layout === 'landscape' ? [1536, 1024] : [896, 1152];
    const res = await fetch(`${API_BASE}/images/comfyui`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, negativePrompt: PORTRAIT_NEGATIVE, width, height, imageConfig: config }),
    });
    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        throw new Error(`Failed to generate image: ${err.error || res.status}`);
    }
    const data = await res.json();
    return data.dataUri;
}

/** Returns either a hosted image URL or a `data:` URI — both are accepted by
 *  downloadImageToLocal(), which hands the value to the server to fetch and store.
 *  Landscape layout shares this provider path with location illustrations. */
export async function generateNPCPortrait(config: ImageEndpointConfig, prompt: string, layout: 'portrait' | 'landscape' = 'portrait'): Promise<string> {
    if (!config.endpoint) {
        throw new Error('Image AI not configured');
    }

    if (config.apiFormat === 'comfyui') {
        try {
            return await generateViaComfyUI(config, prompt, layout);
        } catch (error) {
            console.error('[Image Engine] Error generating ComfyUI image:', error);
            throw error;
        }
    }

    const openRouter = isOpenRouterImageProvider(config);

    if (openRouter && !config.modelName) {
        throw new Error('OpenRouter requires an image model name (e.g. google/gemini-2.5-flash-image) in the provider settings.');
    }

    // OpenRouter's native image API vs. the OpenAI-compatible /images/generations shape.
    const payload = mergeCustomBody<Record<string, unknown>>(openRouter
        ? { ...buildOpenRouterImageBody(config.modelName, prompt, layout === 'landscape' ? '16:9' : '3:4', layout === 'landscape' ? '16:9' : '3:4') }
        : {
            model: config.modelName || 'nano-banana',
            prompt,
            negative_prompt: PORTRAIT_NEGATIVE,
            size: layout === 'landscape' ? '1536x1024' : '896x1152',
            response_format: 'url',
        }, config.customBody, PROTECTED_IMAGE_FIELDS);

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
        // OpenAI-style base64 reply (response_format is a hint some servers ignore).
        if (data.data && data.data[0] && data.data[0].b64_json) {
            return `data:image/png;base64,${data.data[0].b64_json}`;
        }

        throw new Error('Unexpected output format from Image AI: ' + JSON.stringify(data));
    } catch (error) {
        console.error('[Image Engine] Error generating portrait:', error);
        throw error;
    }
}
