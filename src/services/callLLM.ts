// ─── Shared non-streaming LLM call utility ────────────────────────────────────
// All non-streaming /chat/completions calls go through here so they share
// the same rate-limit queue (llmQueue) and retry logic.
//
// Priority guide:
//   'high'   — context recommender (pre-turn; story AI depends on it)
//   'normal' — story AI streaming wrapper (llmService.ts uses the queue directly)
//   'low'    — all post-turn background tasks (inventory, profile, importance, save)

import type { ProviderConfig, EndpointConfig } from '../types';
import { llmQueue, type LLMCallPriority } from './llmRequestQueue';
import { getChatUrl, buildChatHeaders, buildChatBody, extractContent } from '../utils/llmApiHelper';

const MAX_RETRIES = 3;
const DEFAULT_RETRY_DELAY_MS = 300;

export type { LLMCallPriority };

export async function callLLM(
    provider: ProviderConfig | EndpointConfig,
    prompt: string,
    options?: {
        temperature?: number;
        maxTokens?: number;
        signal?: AbortSignal;
        priority?: LLMCallPriority;
    }
): Promise<string> {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const body = buildChatBody(provider, [{ role: 'user', content: prompt }], {
        stream: false,
        temperature: options?.temperature,
        max_tokens: options?.maxTokens,
    });

    const priority = options?.priority ?? 'normal';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        // Wait for a slot (respects stagger + concurrency cap + priority order)
        await llmQueue.acquireSlot(priority);

        let res: Response;
        try {
            res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(body),
                signal: options?.signal,
            });
        } catch (e) {
            // Network error / abort — free the slot and propagate
            llmQueue.releaseSlot();
            throw e;
        }

        if (res.status !== 429) {
            llmQueue.releaseSlot();
            if (!res.ok) {
                const errBody = await res.text();
                throw new Error(`LLM API error ${res.status}: ${errBody}`);
            }
            const data = await res.json();
            return extractContent(data, provider);
        }

        // ── 429 handling ──────────────────────────────────────────────────────
        // Tell the queue we hit the API's concurrency ceiling, then release so
        // other in-flight calls can continue.  Re-queue this request after a
        // short wait; acquireSlot() will block until a completion frees a slot.
        llmQueue.onRateLimitHit();
        llmQueue.releaseSlot();

        if (attempt === MAX_RETRIES) {
            const errBody = await res.text();
            throw new Error(`LLM API error 429 (retries exhausted): ${errBody}`);
        }

        const retryAfter = res.headers.get('Retry-After');
        const delay = retryAfter
            ? parseFloat(retryAfter) * 1000
            : DEFAULT_RETRY_DELAY_MS;

        console.warn(
            `[LLMQueue] 429 (attempt ${attempt + 1}/${MAX_RETRIES + 1}, priority=${priority}). ` +
            `Waiting ${delay}ms then re-queuing for next open slot...`
        );
        await new Promise(resolve => setTimeout(resolve, delay));
        // loop → acquireSlot() will wait for a completion-driven opening
    }

    throw new Error('[LLMQueue] Unreachable');
}
