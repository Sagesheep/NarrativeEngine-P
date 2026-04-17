import type { EndpointConfig, ProviderConfig, ApiFormat, SamplingConfig } from '../types';

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
    options?: { stream?: boolean; max_tokens?: number; temperature?: number; tools?: unknown[]; sampling?: SamplingConfig }
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

    // Per-call temperature override wins; otherwise use sampling config
    if (options?.temperature !== undefined) {
        body.temperature = options.temperature;
    } else if (options?.sampling?.temperature !== undefined) {
        body.temperature = options.sampling.temperature;
    }

    if (options?.sampling) {
        const s = options.sampling;
        if (s.top_p !== undefined) body.top_p = s.top_p;
        if (s.top_k !== undefined) body.top_k = s.top_k;
        if (s.min_p !== undefined) body.min_p = s.min_p;
        if (s.frequency_penalty !== undefined) body.frequency_penalty = s.frequency_penalty;
        if (s.presence_penalty !== undefined) body.presence_penalty = s.presence_penalty;
        if (s.repetition_penalty !== undefined) body.repetition_penalty = s.repetition_penalty;
        if (s.dry_multiplier !== undefined) body.dry_multiplier = s.dry_multiplier;
        if (s.dry_base !== undefined) body.dry_base = s.dry_base;
        if (s.dry_allowed_length !== undefined) body.dry_allowed_length = s.dry_allowed_length;
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
