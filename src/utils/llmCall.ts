import type { EndpointConfig, ProviderConfig, ThinkingEffort } from '../types';
import { getQueueForEndpoint, type LLMCallPriority } from '../services/llm/llmRequestQueue';
import { getApiFormat, getChatUrl, buildChatHeaders, buildChatBody, extractContent } from './llmApiHelper';
import { startUtilityCall } from '../services/llm/utilityCallTracker';
import { recordCacheUsage, type LLMUsage } from '../services/llm/cacheTelemetry';
import { llmFetch } from '../services/llm/llmFetch';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export class UtilityTimeoutError extends Error {
    elapsedMs: number;
    label: string;
    constructor(elapsedMs: number, label: string) {
        super(`Utility call "${label}" exceeded deadline (${elapsedMs}ms)`);
        this.name = 'UtilityTimeoutError';
        this.elapsedMs = elapsedMs;
        this.label = label;
    }
}

export async function llmCall(
    provider: EndpointConfig | ProviderConfig,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
        thinkingEffort?: ThinkingEffort;
        /** If set, registers this call with utilityCallTracker so UI can show countdown + EXTEND. */
        trackingLabel?: string;
        /** Soft deadline in ms. On expiry, rejects with UtilityTimeoutError. Caller should fall back. */
        timeoutMs?: number;
    }
): Promise<string> {
    if (!opts?.trackingLabel || !opts?.timeoutMs) {
        return runInner(provider, prompt, opts);
    }

    const label = opts.trackingLabel;
    const trackingName = (provider as EndpointConfig).modelName || provider.endpoint;
    const handle = startUtilityCall(label, trackingName, opts.timeoutMs);
    const startedAt = Date.now();

    // Wire abort: when the deadline elapses, cancel the in-flight fetch too.
    const ownAbort = new AbortController();
    const combinedSignal = opts.signal
        ? AbortSignal.any([opts.signal, ownAbort.signal])
        : ownAbort.signal;

    const inner = runInner(provider, prompt, { ...opts, signal: combinedSignal });

    try {
        const result = await Promise.race([
            inner.then(v => ({ kind: 'ok' as const, value: v })),
            handle.deadlinePromise.then(() => ({ kind: 'timeout' as const })),
        ]);

        if (result.kind === 'timeout') {
            ownAbort.abort();
            handle.settleError('timeout');
            throw new UtilityTimeoutError(Date.now() - startedAt, label);
        }

        handle.settleSuccess();
        return result.value;
    } catch (e) {
        // If inner threw before deadline, record it.
        if (!(e instanceof UtilityTimeoutError)) {
            const msg = e instanceof Error ? e.message : String(e);
            handle.settleError('error', msg);
        }
        throw e;
    }
}

async function runInner(
    provider: EndpointConfig | ProviderConfig,
    prompt: string,
    opts?: {
        signal?: AbortSignal;
        maxTokens?: number;
        temperature?: number;
        priority?: LLMCallPriority;
        thinkingEffort?: ThinkingEffort;
        trackingLabel?: string;
    },
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const format = getApiFormat(provider);
    const resolvedEffort = opts?.thinkingEffort !== undefined ? opts.thinkingEffort : (provider as EndpointConfig).thinkingEffort;

    const body = buildChatBody(
        provider,
        [{ role: 'user', content: prompt }],
        { stream: false, max_tokens: opts?.maxTokens, thinkingEffort: resolvedEffort }
    );

    if (opts?.temperature !== undefined) body.temperature = opts.temperature;

    const priority = opts?.priority ?? 'normal';
    const queue = getQueueForEndpoint(provider.endpoint);

    let fetchUrl = url;
    if (format === 'gemini' && provider.apiKey) {
        const sep = fetchUrl.includes('?') ? '&' : '?';
        fetchUrl = `${fetchUrl}${sep}key=${provider.apiKey}`;
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await queue.acquireSlot(priority);

        let res: Response;
        try {
            res = await llmFetch(fetchUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: opts?.signal,
            });
        } catch (e) {
            queue.releaseSlot();
            throw e;
        }

        const retryable = res.status === 429 || res.status === 503 || res.status === 529;
        if (!retryable) {
            queue.releaseSlot();
            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`LLM API error ${res.status}: ${errBody} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
            }
            const data = await res.json();
            if (opts?.trackingLabel) {
                recordCacheUsage(opts.trackingLabel, (data as { usage?: LLMUsage }).usage);
            }
            return extractContent(data, provider);
        }

        queue.onRateLimitHit();
        queue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error ${res.status} (retries exhausted): ${errBody} (max_tokens=${opts?.maxTokens ?? 'default'}, thinkingEffort=${resolvedEffort ?? 'default'})`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        console.warn(
            `[LLMQueue] ${res.status} (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
            `Waiting ${delay}ms then re-queuing for next open slot...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    throw new Error('[LLMQueue] Unreachable');
}
