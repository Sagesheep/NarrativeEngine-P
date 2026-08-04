/**
 * OpenRouter image-generation glue.
 *
 * OpenRouter does NOT expose an OpenAI-compatible `/images/generations` route. It
 * serves image models from its own `POST /api/v1/images`, takes `aspect_ratio`
 * instead of `size`, has no `negative_prompt`, and always answers with base64
 * (`data[0].b64_json`) rather than a URL. Sending the OpenAI shape at it yields a
 * bare `404 Not Found`, so the image paths branch here instead.
 *
 * Kept as a standalone pure module so both the browser portrait path and the
 * server scene-image path can be checked against the same rules.
 */

/** True when this provider should use OpenRouter's native image API.
 *  Host detection is deliberate as well as the explicit apiFormat: a provider
 *  configured as 'openai' but pointed at openrouter.ai can only ever 404 on the
 *  OpenAI route, so we route it correctly instead of failing. */
export function isOpenRouterImageProvider(config: { endpoint?: string; apiFormat?: string }): boolean {
    if (config.apiFormat === 'openrouter') return true;
    try {
        const host = new URL(config.endpoint || '').hostname.toLowerCase();
        return host === 'openrouter.ai' || host.endsWith('.openrouter.ai');
    } catch {
        return false;
    }
}

/** Resolve whatever the user typed into the real images URL.
 *  Tolerates the base (`/api/v1`), the endpoint itself (`/api/v1/images`), a bare
 *  host, and a pasted chat path (`/api/v1/chat/completions`). */
export function openRouterImagesUrl(endpoint: string): string {
    const base = (endpoint || '')
        .replace(/\/+$/, '')
        .replace(/\/chat\/completions$/, '')
        .replace(/\/images\/generations$/, '');

    if (/\/images$/.test(base)) return base;

    try {
        const url = new URL(base);
        if (url.pathname.replace(/\/+$/, '') === '') return `${url.origin}/api/v1/images`;
    } catch { /* not absolute — fall through and just append */ }

    return `${base}/images`;
}

/** OpenRouter's allowed `aspect_ratio` values. */
const ASPECT_RATIOS = new Set([
    '1:1', '16:9', '9:16', '4:3', '3:4', '3:2', '2:3', '4:5', '5:4',
    '1:2', '2:1', '1:4', '4:1', '1:8', '8:1', '9:21', '21:9', 'auto',
]);

export function toOpenRouterAspectRatio(aspectRatio: string | undefined, fallback = '1:1'): string {
    return aspectRatio && ASPECT_RATIOS.has(aspectRatio) ? aspectRatio : fallback;
}

export type OpenRouterImageRequest = {
    model: string;
    prompt: string;
    n: number;
    aspect_ratio: string;
    output_format: string;
};

/** Build the request body. Note the absence of `negative_prompt` — OpenRouter has
 *  no such field, and folding it into `prompt` makes models render the words. */
export function buildOpenRouterImageBody(
    model: string,
    prompt: string,
    aspectRatio?: string,
    fallbackAspect = '1:1',
): OpenRouterImageRequest {
    return {
        model,
        prompt,
        n: 1,
        aspect_ratio: toOpenRouterAspectRatio(aspectRatio, fallbackAspect),
        output_format: 'png',
    };
}

/** Pull the image out of an OpenRouter response as a `data:` URI.
 *  Returns null when the payload carries no image. */
export function extractOpenRouterImage(data: unknown): string | null {
    const item = (data as { data?: Array<{ b64_json?: string; media_type?: string; url?: string }> })?.data?.[0];
    if (!item) return null;
    if (item.b64_json) return `data:${item.media_type || 'image/png'};base64,${item.b64_json}`;
    return item.url || null;
}
