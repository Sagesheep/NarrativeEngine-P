/**
 * Server-side proxy for LLM provider API calls that browsers block via CORS.
 * The frontend sends provider config to POST /api/proxy/models instead of
 * fetching the provider's models URL directly from the browser.
 */
import { Router } from 'express';
import { wrapAsync } from '../lib/asyncHandler.js';

/**
 * Replicate the frontend's getModelsUrl logic server-side.
 */
function getModelsUrl(endpoint, apiFormat) {
    let base = endpoint.replace(/\/+$/, '');
    // Bare host (no path) -> append /v1 for openai/claude
    if ((apiFormat === 'openai' || apiFormat === 'claude') && isBareHost(base)) {
        base += '/v1';
    }
    if (apiFormat === 'ollama') return `${base}/api/tags`;
    if (apiFormat === 'gemini') return `${base}/models`;
    if (apiFormat === 'claude') return `${base}/models`;
    return `${base}/models`;
}

function isBareHost(url) {
    try {
        return new URL(url).pathname.replace(/\/+$/, '') === '';
    } catch {
        const pathPart = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
        return pathPart === '';
    }
}

/**
 * Build headers matching the frontend's buildChatHeaders logic.
 */
function buildHeaders(apiFormat, apiKey) {
    const headers = { 'Content-Type': 'application/json' };
    if (apiFormat === 'claude') {
        if (apiKey) {
            headers['x-api-key'] = apiKey;
            headers['anthropic-version'] = '2023-06-01';
        }
    } else if (apiKey) {
        headers['Authorization'] = `Bearer ${apiKey}`;
    }
    return headers;
}

export function createProxyRouter() {
    const router = Router();

    /**
     * POST /api/proxy/models
     *
     * Proxies a model-list request to the provider's endpoint.
     * Body: { endpoint, apiKey, apiFormat, modelName }
     * Returns: { ok: boolean, detail: string, data?: any }
     */
    router.post('/api/proxy/models', wrapAsync(async (req, res) => {
        const { endpoint, apiKey, apiFormat } = req.body;

        if (!endpoint) {
            return res.status(400).json({ ok: false, detail: 'Missing endpoint' });
        }

        const format = apiFormat || 'openai';
        let url = getModelsUrl(endpoint, format);

        // Gemini auth: append ?key= to URL
        if (format === 'gemini' && apiKey) {
            url = `${url}?key=${apiKey}`;
        }

        const headers = buildHeaders(format, apiKey);
        // Remove Content-Type for GET requests (matches frontend behavior)
        delete headers['Content-Type'];

        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 15000);
            const upstream = await fetch(url, { headers, signal: controller.signal });
            clearTimeout(timeoutId);
            if (upstream.ok) {
                let data = null;
                try {
                    data = await upstream.json();
                } catch {
                    // response may be empty or non-JSON
                }
                return res.json({ ok: true, detail: 'Connection successful', data });
            }
            const errText = await upstream.text().catch(() => '');
            return res.json({ ok: false, detail: `HTTP ${upstream.status}: ${errText}` });
        } catch (err) {
            return res.json({ ok: false, detail: err.message || 'Network error' });
        }
    }));

    return router;
}
