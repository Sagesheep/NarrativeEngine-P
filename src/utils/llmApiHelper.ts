import type { EndpointConfig, ProviderConfig, ApiFormat, SamplingConfig } from '../types';

type AnyProvider = EndpointConfig | ProviderConfig;

export function getApiFormat(provider: AnyProvider): ApiFormat {
    return (provider as EndpointConfig).apiFormat || 'openai';
}

function isBareHost(url: string): boolean {
    try {
        return new URL(url).pathname.replace(/\/+$/, '') === '';
    } catch {
        const pathPart = url.replace(/^https?:\/\/[^/]+/, '').replace(/\/+$/, '');
        return pathPart === '';
    }
}

export function detectFormatFromEndpoint(endpoint: string): ApiFormat | null {
    try {
        const { hostname } = new URL(endpoint);
        if (hostname.includes('api.anthropic.com')) return 'claude';
        if (hostname.includes('generativelanguage.googleapis.com')) return 'gemini';
        if (/^(localhost|127\.0\.0\.1):11434$/.test(hostname)) return 'ollama';
    } catch { /* invalid URL */ }
    return null;
}

export function getBaseUrl(provider: AnyProvider): string {
    let base = provider.endpoint.replace(/\/+$/, '');
    const format = getApiFormat(provider);
    if ((format === 'openai' || format === 'claude') && isBareHost(base)) {
        base += '/v1';
    }
    return base;
}

export function getChatUrl(provider: AnyProvider, options?: { stream?: boolean }): string {
    const base = getBaseUrl(provider);
    const format = getApiFormat(provider);
    if (format === 'ollama') return `${base}/api/chat`;
    if (format === 'claude') return `${base}/messages`;
    if (format === 'gemini') {
        const stream = options?.stream ?? false;
        const model = provider.modelName;
        return stream
            ? `${base}/models/${model}:streamGenerateContent?alt=sse`
            : `${base}/models/${model}:generateContent`;
    }
    return `${base}/chat/completions`;
}

export function getModelsUrl(provider: AnyProvider): string {
    const base = getBaseUrl(provider);
    const format = getApiFormat(provider);
    if (format === 'ollama') return `${base}/api/tags`;
    if (format === 'gemini') return `${base}/models`;
    if (format === 'claude') return `${base}/models`;
    return `${base}/models`;
}

export function buildChatHeaders(provider: AnyProvider): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    const format = getApiFormat(provider);
    if (format === 'claude') {
        if (provider.apiKey) {
            headers['x-api-key'] = provider.apiKey;
            headers['anthropic-version'] = '2023-06-01';
        }
    } else if (format === 'gemini') {
        // Gemini auth goes in URL param, not headers — remove Content-Type for GET-style endpoints
    } else if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }
    return headers;
}

function transformClaudeMessages(messages: { role: string; content: string | null; name?: string; tool_calls?: unknown[]; tool_call_id?: string }[]): { system?: string; messages: { role: string; content: string | unknown[] }[] } {
    const systemParts: string[] = [];
    const transformed: { role: string; content: string | unknown[] }[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            systemParts.push(m.content || '');
            continue;
        }

        if (m.role === 'assistant') {
            const tc = (m as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] }).tool_calls;
            if (tc && tc.length > 0) {
                const content: unknown[] = [];
                if (m.content) content.push({ type: 'text', text: m.content });
                for (const t of tc) {
                    let input: unknown = {};
                    try { input = JSON.parse(t.function.arguments); } catch { input = { _raw: t.function.arguments }; }
                    content.push({ type: 'tool_use', id: t.id, name: t.function.name, input });
                }
                transformed.push({ role: 'assistant', content });
            } else {
                transformed.push({ role: 'assistant', content: m.content || '' });
            }
            continue;
        }

        if (m.role === 'tool') {
            transformed.push({
                role: 'user',
                content: [{
                    type: 'tool_result',
                    tool_use_id: (m as { tool_call_id?: string }).tool_call_id || '',
                    content: m.content || '',
                }],
            });
            continue;
        }

        transformed.push({ role: m.role, content: m.content || '' });
    }

    const result: { system?: string; messages: { role: string; content: string | unknown[] }[] } = { messages: transformed };
    if (systemParts.length > 0) result.system = systemParts.join('\n\n');
    return result;
}

function transformGeminiMessages(messages: { role: string; content: string | null; tool_calls?: unknown[]; tool_call_id?: string; name?: string }[]): { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } {
    const systemParts: string[] = [];
    const contents: { role: string; parts: unknown[] }[] = [];

    for (const m of messages) {
        if (m.role === 'system') {
            systemParts.push(m.content || '');
            continue;
        }

        if (m.role === 'assistant') {
            const tc = (m as { tool_calls?: { id: string; function: { name: string; arguments: string } }[] }).tool_calls;
            const parts: unknown[] = [];
            if (m.content) parts.push({ text: m.content });
            if (tc && tc.length > 0) {
                for (const t of tc) {
                    let args: Record<string, unknown> = {};
                    try { args = JSON.parse(t.function.arguments); } catch { args = { _raw: t.function.arguments }; }
                    parts.push({ functionCall: { name: t.function.name, args } });
                }
            }
            contents.push({ role: 'model', parts });
            continue;
        }

        if (m.role === 'tool') {
            const fName = m.name || '';
            contents.push({
                role: 'function',
                parts: [{ functionResponse: { name: fName, response: { content: m.content || '' } } }],
            });
            continue;
        }

        contents.push({ role: m.role, parts: [{ text: m.content || '' }] });
    }

    const result: { systemInstruction?: { parts: { text: string }[] }; contents: { role: string; parts: unknown[] }[] } = { contents };
    if (systemParts.length > 0) result.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
    return result;
}

function transformGeminiTools(tools: unknown[]): unknown[] {
    const openaiTools = tools as { type: string; function: { name: string; description: string; parameters: unknown } }[];
    const declarations = openaiTools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
    }));
    return [{ functionDeclarations: declarations }];
}

export function buildChatBody(
    provider: AnyProvider,
    messages: { role: string; content: string | null; name?: string; tool_calls?: unknown[]; tool_call_id?: string }[],
    options?: { stream?: boolean; max_tokens?: number; temperature?: number; tools?: unknown[]; sampling?: SamplingConfig }
): Record<string, unknown> {
    const format = getApiFormat(provider);
    const stream = options?.stream ?? false;

    if (format === 'claude') {
        const { system, messages: convMessages } = transformClaudeMessages(messages);
        const body: Record<string, unknown> = {
            model: provider.modelName,
            messages: convMessages,
            max_tokens: options?.max_tokens ?? 8192,
            stream,
        };
        if (system) body.system = system;

        if (options?.temperature !== undefined) body.temperature = options.temperature;
        else if (options?.sampling?.temperature !== undefined) body.temperature = options.sampling.temperature;
        if (options?.sampling?.top_p !== undefined) body.top_p = options.sampling.top_p;
        if (options?.sampling?.top_k !== undefined) body.top_k = options.sampling.top_k;

        if (options?.tools && options.tools.length > 0) body.tools = options.tools;
        return body;
    }

    if (format === 'gemini') {
        const { systemInstruction, contents } = transformGeminiMessages(messages);
        const body: Record<string, unknown> = {
            contents,
        };
        if (systemInstruction) body.systemInstruction = systemInstruction;

        const genConfig: Record<string, unknown> = {};
        genConfig.maxOutputTokens = options?.max_tokens ?? 8192;
        if (options?.temperature !== undefined) genConfig.temperature = options.temperature;
        else if (options?.sampling?.temperature !== undefined) genConfig.temperature = options.sampling.temperature;
        if (options?.sampling?.top_p !== undefined) genConfig.topP = options.sampling.top_p;
        if (options?.sampling?.top_k !== undefined) genConfig.topK = options.sampling.top_k;
        if (options?.sampling?.frequency_penalty !== undefined) genConfig.frequencyPenalty = options.sampling.frequency_penalty;
        if (options?.sampling?.presence_penalty !== undefined) genConfig.presencePenalty = options.sampling.presence_penalty;
        body.generationConfig = genConfig;

        if (options?.tools && options.tools.length > 0) {
            body.tools = transformGeminiTools(options.tools);
        }
        return body;
    }

    // OpenAI / Ollama
    const isOllama = format === 'ollama';
    const body: Record<string, unknown> = {
        model: provider.modelName,
        messages,
        stream,
    };

    if (options?.max_tokens !== undefined) body.max_tokens = options.max_tokens;

    if (options?.temperature !== undefined) body.temperature = options.temperature;
    else if (options?.sampling?.temperature !== undefined) body.temperature = options.sampling.temperature;

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

    if (!isOllama && options?.tools && options.tools.length > 0) {
        body.tools = options.tools;
    }

    return body;
}

export function extractContent(data: unknown, provider: AnyProvider): string {
    const format = getApiFormat(provider);

    if (format === 'ollama') {
        const ollama = data as { message?: { content?: string } };
        return ollama?.message?.content ?? '';
    }

    if (format === 'claude') {
        const claude = data as { content?: { type: string; text?: string }[] };
        const textBlocks = claude?.content?.filter(b => b.type === 'text');
        return textBlocks?.map(b => b.text ?? '').join('') ?? '';
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return gemini?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    const openai = data as { choices?: { message?: { content?: string } }[] };
    return openai?.choices?.[0]?.message?.content ?? '';
}

export function extractStreamDelta(data: unknown, provider: AnyProvider): string {
    const format = getApiFormat(provider);

    if (format === 'claude') {
        const claude = data as { type?: string; delta?: { type?: string; text?: string } };
        if (claude.type === 'content_block_delta' && claude.delta?.type === 'text_delta') {
            return claude.delta.text ?? '';
        }
        return '';
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { text?: string }[] } }[] };
        return gemini?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
    }

    const openai = data as { choices?: { delta?: { content?: string } }[] };
    return openai?.choices?.[0]?.delta?.content ?? '';
}

export function extractStreamToolCall(data: unknown, provider: AnyProvider): { id: string; name: string; arguments: string } | null {
    const format = getApiFormat(provider);

    if (format === 'claude') {
        const claude = data as { type?: string; content_block?: { type?: string; id?: string; name?: string }; delta?: { type?: string; partial_json?: string } };
        if (claude.type === 'content_block_start' && claude.content_block?.type === 'tool_use') {
            return { id: claude.content_block.id || '', name: claude.content_block.name || '', arguments: '' };
        }
        if (claude.type === 'content_block_delta' && claude.delta?.type === 'input_json_delta' && claude.delta.partial_json) {
            return { id: '', name: '', arguments: claude.delta.partial_json };
        }
        return null;
    }

    if (format === 'gemini') {
        const gemini = data as { candidates?: { content?: { parts?: { functionCall?: { name: string; args: Record<string, unknown> } }[] } }[] };
        const fc = gemini?.candidates?.[0]?.content?.parts?.find(p => (p as { functionCall?: unknown }).functionCall);
        if (fc) {
            const fCall = (fc as { functionCall: { name: string; args: Record<string, unknown> } }).functionCall;
            return { id: `gemini_${Date.now()}`, name: fCall.name, arguments: JSON.stringify(fCall.args) };
        }
        return null;
    }

    const openai = data as { choices?: { delta?: { tool_calls?: { id?: string; function?: { name?: string; arguments?: string } }[] } }[] };
    const tc = openai?.choices?.[0]?.delta?.tool_calls?.[0];
    if (!tc) return null;
    return { id: tc.id || '', name: tc.function?.name || '', arguments: tc.function?.arguments || '' };
}