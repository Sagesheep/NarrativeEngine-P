// Native ComfyUI txt2img provider (scene images only).
//
// Two workflow sources are supported:
//   1. A built-in basic checkpoint txt2img graph (used when no custom JSON is set).
//   2. A user-pasted "Save (API Format)" workflow JSON.
//
// Both are parameterised with %placeholder% tokens that are substituted before the
// graph is queued. When a value is EXACTLY a placeholder (e.g. "%seed%") the native
// type of the replacement is preserved (numbers stay numbers); when a placeholder
// appears inside a longer string it is interpolated as text.

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

// Keys accepted in the replacements map, and therefore the recognised placeholders
// (%prompt%, %negative_prompt%, %seed%, ...). Kept as a set for O(1) membership tests.
const REPLACEMENT_KEYS = new Set([
    'prompt',
    'negative_prompt',
    'seed',
    'width',
    'height',
    'steps',
    'cfg',
    'sampler',
    'scheduler',
    'denoise',
    'model',
]);

/**
 * Build a fresh copy of the built-in basic checkpoint txt2img graph in ComfyUI
 * API format. Node ids are arbitrary strings; only class_type + inputs matter.
 * Numeric inputs are seeded with placeholder strings so the type-preserving
 * replacement can convert them back into real numbers.
 */
export function buildDefaultComfyWorkflow() {
    return {
        '4': {
            class_type: 'CheckpointLoaderSimple',
            inputs: {
                ckpt_name: '%model%',
            },
        },
        '5': {
            class_type: 'EmptyLatentImage',
            inputs: {
                width: '%width%',
                height: '%height%',
                batch_size: 1,
            },
        },
        '6': {
            class_type: 'CLIPTextEncode',
            inputs: {
                text: '%prompt%',
                clip: ['4', 1],
            },
        },
        '7': {
            class_type: 'CLIPTextEncode',
            inputs: {
                text: '%negative_prompt%',
                clip: ['4', 1],
            },
        },
        '3': {
            class_type: 'KSampler',
            inputs: {
                seed: '%seed%',
                steps: '%steps%',
                cfg: '%cfg%',
                sampler_name: '%sampler%',
                scheduler: '%scheduler%',
                denoise: '%denoise%',
                model: ['4', 0],
                positive: ['6', 0],
                negative: ['7', 0],
                latent_image: ['5', 0],
            },
        },
        '8': {
            class_type: 'VAEDecode',
            inputs: {
                samples: ['3', 0],
                vae: ['4', 2],
            },
        },
        '9': {
            class_type: 'SaveImage',
            inputs: {
                filename_prefix: 'NarrativeEngine',
                images: ['8', 0],
            },
        },
    };
}

const EXACT_PLACEHOLDER = /^%([a-z_]+)%$/;
const INLINE_PLACEHOLDER = /%([a-z_]+)%/g;

function replaceDeep(value, replacements) {
    if (typeof value === 'string') {
        const exact = value.match(EXACT_PLACEHOLDER);
        if (exact) {
            const key = exact[1];
            if (REPLACEMENT_KEYS.has(key) && replacements[key] !== undefined) {
                // Whole value is a single placeholder — return the raw replacement so a
                // numeric placeholder (%seed%, %steps%, ...) keeps its number type.
                return replacements[key];
            }
            return value;
        }
        // Placeholder embedded in longer text — interpolate as a string.
        return value.replace(INLINE_PLACEHOLDER, (match, key) => {
            if (REPLACEMENT_KEYS.has(key) && replacements[key] !== undefined) {
                return String(replacements[key]);
            }
            return match;
        });
    }
    if (Array.isArray(value)) {
        return value.map((item) => replaceDeep(item, replacements));
    }
    if (value && typeof value === 'object') {
        const out = {};
        for (const [k, v] of Object.entries(value)) {
            out[k] = replaceDeep(v, replacements);
        }
        return out;
    }
    return value;
}

/**
 * Resolve the workflow graph to POST: parse the custom JSON if present (else the
 * built-in graph) and recursively substitute placeholders.
 *
 * @param {object} config       ComfyUiSettings-shaped object (customWorkflowJson optional).
 * @param {object} replacements Map of placeholder key -> value (numbers stay numbers).
 * @returns {object} The resolved ComfyUI API-format graph.
 */
export function resolveComfyWorkflow(config, replacements = {}) {
    const custom = config && typeof config.customWorkflowJson === 'string'
        ? config.customWorkflowJson.trim()
        : '';

    let workflow;
    if (custom) {
        try {
            workflow = JSON.parse(custom);
        } catch (err) {
            throw new Error(`Invalid ComfyUI workflow JSON: ${err.message}`);
        }
        if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
            throw new Error('ComfyUI workflow JSON must be an object of nodes exported via "Save (API Format)".');
        }
    } else {
        workflow = buildDefaultComfyWorkflow();
    }

    return replaceDeep(workflow, replacements);
}

// ── Endpoint / helpers ─────────────────────────────────────────────────────

function normalizeComfyBaseUrl(endpoint) {
    const trimmed = String(endpoint || '').trim().replace(/\/+$/, '');
    if (!trimmed) throw new Error('ComfyUI endpoint is not configured');
    let parsed;
    try {
        parsed = new URL(trimmed);
    } catch {
        throw new Error(`Invalid ComfyUI endpoint URL: ${endpoint}`);
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        throw new Error(`ComfyUI endpoint must use http or https (got "${parsed.protocol}")`);
    }
    return trimmed;
}

function numberOr(value, fallback) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (value === null || value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
}

function stringOr(value, fallback) {
    return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function safeText(res) {
    try {
        return await res.text();
    } catch {
        return '';
    }
}

/** Extract a human-readable message from a Comfy error body (string or object). */
function formatComfyError(payload) {
    let obj = payload;
    if (typeof payload === 'string') {
        try {
            obj = JSON.parse(payload);
        } catch {
            return payload || 'unknown error';
        }
    }
    if (!obj || typeof obj !== 'object') return String(payload ?? 'unknown error');

    const parts = [];
    if (obj.error) {
        if (typeof obj.error === 'string') parts.push(obj.error);
        else if (obj.error.message) parts.push(String(obj.error.message));
        else parts.push(JSON.stringify(obj.error));
    }
    if (obj.node_errors && typeof obj.node_errors === 'object' && Object.keys(obj.node_errors).length > 0) {
        parts.push(`node_errors: ${JSON.stringify(obj.node_errors)}`);
    }
    return parts.length > 0 ? parts.join(' | ') : JSON.stringify(obj);
}

/** Pull the execution error out of a history entry's status messages, if present. */
function extractExecutionError(entry) {
    const status = entry && entry.status;
    const messages = status && Array.isArray(status.messages) ? status.messages : [];
    for (const m of messages) {
        if (Array.isArray(m) && m[0] === 'execution_error' && m[1]) {
            const info = m[1];
            const parts = [];
            if (info.node_type) parts.push(String(info.node_type));
            if (info.exception_message) parts.push(String(info.exception_message));
            if (parts.length) return parts.join(': ');
        }
    }
    return 'execution error';
}

/** Dynamically find the first node output carrying an images[] array. */
function findFirstImage(historyEntry) {
    const outputs = historyEntry && historyEntry.outputs;
    if (!outputs || typeof outputs !== 'object') return null;
    for (const nodeId of Object.keys(outputs)) {
        const nodeOutput = outputs[nodeId];
        const images = nodeOutput && nodeOutput.images;
        if (Array.isArray(images) && images.length > 0) {
            const img = images.find((i) => i && i.filename);
            if (img) {
                return {
                    filename: img.filename,
                    subfolder: img.subfolder || '',
                    type: img.type || 'output',
                };
            }
        }
    }
    return null;
}

// ── Queue / poll / download ────────────────────────────────────────────────

async function queuePrompt(baseUrl, workflow, fetchImpl) {
    let res;
    try {
        res = await fetchImpl(`${baseUrl}/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: workflow }),
        });
    } catch (err) {
        throw new Error(`Failed to reach ComfyUI at ${baseUrl}: ${err.message}`);
    }

    if (!res.ok) {
        const detail = formatComfyError(await safeText(res));
        throw new Error(`ComfyUI rejected the workflow (${res.status}): ${detail}`);
    }

    let data;
    try {
        data = await res.json();
    } catch {
        throw new Error('ComfyUI returned a non-JSON response when queuing the prompt.');
    }

    if (!data || !data.prompt_id) {
        throw new Error(`ComfyUI did not return a prompt_id: ${formatComfyError(data)}`);
    }
    return data.prompt_id;
}

async function pollHistory(baseUrl, promptId, { timeoutMs, pollIntervalMs, fetchImpl }) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        let res;
        try {
            res = await fetchImpl(`${baseUrl}/history/${promptId}`);
        } catch (err) {
            throw new Error(`Failed to poll ComfyUI history: ${err.message}`);
        }

        if (res.ok) {
            let data;
            try {
                data = await res.json();
            } catch {
                data = null;
            }
            const entry = data && data[promptId];
            if (entry) {
                const status = entry.status;
                if (status && status.status_str === 'error') {
                    throw new Error(`ComfyUI execution failed: ${extractExecutionError(entry)}`);
                }
                const hasOutputs = entry.outputs && typeof entry.outputs === 'object'
                    && Object.keys(entry.outputs).length > 0;
                if (hasOutputs || (status && status.completed === true)) {
                    return entry;
                }
            }
        }

        if (Date.now() >= deadline) {
            throw new Error(`ComfyUI image generation timed out after ${timeoutMs}ms`);
        }
        await sleep(pollIntervalMs);
    }
}

async function downloadImage(baseUrl, imageRef, fetchImpl) {
    const params = new URLSearchParams({
        filename: imageRef.filename,
        subfolder: imageRef.subfolder || '',
        type: imageRef.type || 'output',
    });
    const url = `${baseUrl}/view?${params.toString()}`;

    let res;
    try {
        res = await fetchImpl(url);
    } catch (err) {
        throw new Error(`Failed to download image from ComfyUI: ${err.message}`);
    }
    if (!res.ok) {
        throw new Error(`ComfyUI /view returned ${res.status} for "${imageRef.filename}"`);
    }
    const ab = await res.arrayBuffer();
    return Buffer.from(ab);
}

/**
 * Generate a single scene image via a native ComfyUI server and return the raw
 * PNG/image Buffer. Queues the resolved workflow, polls history to completion,
 * discovers the first images[] output and downloads it.
 *
 * @param {object}   opts
 * @param {object}   opts.config          Provider config: { endpoint, modelName, comfyUi }.
 * @param {string}   opts.prompt          Positive prompt.
 * @param {string}  [opts.negativePrompt] Negative prompt.
 * @param {number}  [opts.width]          Output width.
 * @param {number}  [opts.height]         Output height.
 * @param {number}  [opts.seed]           Explicit seed (random when omitted).
 * @param {number}  [opts.timeoutMs]      Poll timeout (default 2 minutes).
 * @param {number}  [opts.pollIntervalMs] Poll interval (default 1s).
 * @param {Function}[opts.fetch]          fetch impl override (tests).
 * @returns {Promise<Buffer>}
 */
export async function generateComfyUIImage(opts = {}) {
    const {
        config,
        prompt,
        negativePrompt = '',
        width = 1024,
        height = 1024,
        seed,
        timeoutMs = DEFAULT_TIMEOUT_MS,
        pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
        fetch: fetchImpl = globalThis.fetch,
    } = opts;

    if (!config || !config.endpoint) {
        throw new Error('ComfyUI endpoint is not configured');
    }
    if (typeof fetchImpl !== 'function') {
        throw new Error('No fetch implementation available for ComfyUI provider');
    }

    const baseUrl = normalizeComfyBaseUrl(config.endpoint);
    const comfy = config.comfyUi || {};

    const replacements = {
        prompt: prompt || '',
        negative_prompt: negativePrompt || '',
        seed: Number.isFinite(seed) ? seed : Math.floor(Math.random() * 1_000_000_000_000_000),
        width: numberOr(width, 1024),
        height: numberOr(height, 1024),
        steps: numberOr(comfy.steps, 20),
        cfg: numberOr(comfy.cfgScale, 7),
        sampler: stringOr(comfy.sampler, 'euler'),
        scheduler: stringOr(comfy.scheduler, 'normal'),
        denoise: numberOr(comfy.denoisingStrength, 1),
        model: stringOr(config.modelName, 'model.safetensors'),
    };

    const resolvedWorkflow = resolveComfyWorkflow(comfy, replacements);

    const promptId = await queuePrompt(baseUrl, resolvedWorkflow, fetchImpl);
    const historyEntry = await pollHistory(baseUrl, promptId, { timeoutMs, pollIntervalMs, fetchImpl });

    const imageRef = findFirstImage(historyEntry);
    if (!imageRef) {
        throw new Error('ComfyUI completed but produced no image output');
    }

    return downloadImage(baseUrl, imageRef, fetchImpl);
}
