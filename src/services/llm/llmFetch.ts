import { API_BASE } from '../../lib/apiBase';

/**
 * Drop-in fetch() replacement that relays an AI-provider request through the local
 * server instead of calling the provider directly from the browser. Avoids CORS
 * failures for providers (e.g. NVIDIA) that don't allow browser origins.
 *
 * Call sites already pass a stringified JSON body and a plain headers object,
 * which is exactly what the proxy forwards.
 */
export async function llmFetch(target: string, init?: RequestInit): Promise<Response> {
    return fetch(`${API_BASE}/llm/proxy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            target,
            method: init?.method ?? 'GET',
            headers: init?.headers ?? {},
            body: typeof init?.body === 'string' ? init.body : undefined,
        }),
        signal: init?.signal ?? undefined,
    });
}