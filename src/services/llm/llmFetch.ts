import { API_BASE } from '../../lib/apiBase';
import type { UtilityCallHandle } from './utilityCallTracker';
import { noteReasoningOffRefused, serviceTierHostOf, withoutReasoningOff } from '../../utils/llmApiHelper';

/**
 * Drop-in fetch() replacement that relays an AI-provider request through the local
 * server instead of calling the provider directly from the browser. Avoids CORS
 * failures for providers (e.g. NVIDIA) that don't allow browser origins.
 *
 * Call sites already pass a stringified JSON body and a plain headers object,
 * which is exactly what the proxy forwards.
 */
export async function llmFetch(target: string, init?: RequestInit, call?: UtilityCallHandle): Promise<Response> {
    const body = typeof init?.body === 'string' ? init.body : undefined;
    if (call && body !== undefined) {
        const { useAppStore } = await import('../../store/useAppStore');
        if (useAppStore.getState().settings?.debugMode && !init?.signal?.aborted) {
            call.recordRequestBody(body);
        }
    }
    const send = (requestBody: string | undefined): Promise<Response> => fetch(`${API_BASE}/llm/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            target,
            method: init?.method ?? 'GET',
            headers: init?.headers ?? {},
            body: requestBody,
        }),
        signal: init?.signal ?? undefined,
    });

    const res = await send(body);
    // A model whose reasoning is mandatory rejects OpenRouter's reasoning-off switch
    // (llmApiHelper, `reasoningOffRefused`). Send the request once more without it;
    // the model is remembered so later calls skip the switch.
    if (res.status >= 400 && res.status < 500 && body !== undefined && serviceTierHostOf(target) === 'openrouter') {
        const retry = withoutReasoningOff(body);
        if (retry) {
            const reason = await res.clone().text().catch(() => '');
            if (/reasoning/i.test(reason)) {
                noteReasoningOffRefused(retry.model);
                return send(retry.body);
            }
        }
    }
    return res;
}
