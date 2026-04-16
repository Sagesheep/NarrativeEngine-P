import type { EndpointConfig, ProviderConfig, ApiFormat } from '../types';

type AnyProvider = EndpointConfig | ProviderConfig;

export function getApiFormat(provider: AnyProvider): ApiFormat {
    return (provider as EndpointConfig).apiFormat || 'openai';
}

export function getBaseUrl(provider: AnyProvider): string {
    return provider.endpoint.replace(/\/+$/, '');
}

export function getChatUrl(provider: AnyProvider): string {
    const base = getBaseUrl(provider);
    return getApiFormat(provider) === 'ollama'
        ? `${base}/api/chat`
        : `${base}/chat/completions`;
}

export function getModelsUrl(provider: AnyProvider): string {
    const base = getBaseUrl(provider);
    return getApiFormat(provider) === 'ollama'
        ? `${base}/api/tags`
        : `${base}/models`;
}

export function buildChatHeaders(provider: AnyProvider): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
}

export function buildChatBody(
    provider: AnyProvider,
    messages: { role: string; content: string | null }[],
    options?: { stream?: boolean; max_tokens?: number; temperature?: number; tools?: unknown[] }
): Record<string, unknown> {
    const isOllama = getApiFormat(provider) === 'ollama';
    const stream = options?.stream ?? false;

    const body: Record<string, unknown> = {
        model: provider.modelName,
        messages,
        stream,
    };

    if (options?.max_tokens !== undefined) {
        body.max_tokens = options.max_tokens;
    }

    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    }

    // Ollama native /api/chat does not support OpenAI-style tool calling
    if (!isOllama && options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
    }

    return body;
}

export function extractContent(data: unknown, provider: AnyProvider): string {
    const isOllama = getApiFormat(provider) === 'ollama';

    if (isOllama) {
        const ollama = data as { message?: { content?: string } };
        return ollama?.message?.content ?? '';
    }

    const openai = data as { choices?: { message?: { content?: string } }[] };
    return openai?.choices?.[0]?.message?.content ?? '';
}
