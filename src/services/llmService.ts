import type { EndpointConfig, ProviderConfig, SamplingConfig } from '../types';
import { uid } from '../utils/uid';
import { llmQueue } from './llmRequestQueue';
import { getChatUrl, getModelsUrl, buildChatHeaders, buildChatBody, getApiFormat } from '../utils/llmApiHelper';

export type OpenAIMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
};

export async function sendMessage(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }) => void,
    onError: (err: string) => void,
    tools?: unknown[],
    abortController?: AbortController,
    sampling?: SamplingConfig
) {
    const url = getChatUrl(provider);
    const headers = buildChatHeaders(provider);
    const isOllama = getApiFormat(provider) === 'ollama';

    try {
        const payload = buildChatBody(provider, messages, { stream: true, tools: tools ?? [], sampling });

        const controller = abortController || new AbortController();
        let timeoutId = setTimeout(() => controller.abort(), 120000); // 120 seconds timeout

        // Acquire a queue slot (normal priority — after context gathering, before background tasks).
        // The slot is held for the full duration of the streaming response.
        await llmQueue.acquireSlot('normal');
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!res.ok) {
                const errBody = await res.text();
                if (res.status === 429) llmQueue.onRateLimitHit();
                onError(`API error ${res.status}: ${errBody}`);
                return;
            }

            const reader = res.body?.getReader();
            if (!reader) {
                onError('No readable stream in response');
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';

            let tcId = '';
            let tcName = '';
            let tcArgs = '';

            while (true) {
                const { done, value } = await reader.read();
                clearTimeout(timeoutId);
                if (done) break;

                timeoutId = setTimeout(() => controller.abort(), 120000); // reset timeout for next chunk

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (isOllama) {
                        // Ollama native: newline-delimited JSON (NDJSON)
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed.message?.content) {
                                fullText += parsed.message.content;
                                onChunk(fullText);
                            }
                        } catch {
                            // skip malformed chunks
                        }
                    } else {
                        // OpenAI-compatible: Server-Sent Events (SSE)
                        if (!trimmed.startsWith('data: ')) continue;
                        const data = trimmed.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                fullText += delta.content;
                                onChunk(fullText);
                            }

                            if (delta?.tool_calls && delta.tool_calls.length > 0) {
                                const tc = delta.tool_calls[0];
                                if (tc.id) tcId = tc.id;
                                if (tc.function?.name) tcName = tc.function.name;
                                if (tc.function?.arguments) tcArgs += tc.function.arguments;
                            }
                        } catch {
                            // skip malformed chunks
                        }
                    }
                }
            }

            // --- DeepSeek / Local Model Fallback Parsing ---
            // Some models output tool calls as text tags instead of actual JSON `tool_calls` array
            if (!tcName && fullText.includes('<\uFF5CDSML\uFF5C>function_calls>')) {
                const funcMatch = fullText.match(/<\uFF5CDSML\uFF5C>invoke name="([^"]+)">/);
                if (funcMatch) {
                    tcName = funcMatch[1];
                    tcId = uid(); // Generate a fake ID since it was just text

                    // Try to extract parameters using basic regex (DeepSeek string format)
                    // <｜DSML｜parameter name="query" string="true">lore</｜DSML｜parameter>
                    // We'll capture both the parameter name and the text content inside the tags.
                    const paramRegex = /<\uFF5CDSML\uFF5Cparameter name="([^"]+)"[^>]*>([\s\S]*?)<\/\uFF5CDSML\uFF5Cparameter>/g;
                    let match;
                    const argsObj: Record<string, unknown> = {};

                    while ((match = paramRegex.exec(fullText)) !== null) {
                        argsObj[match[1]] = match[2].trim();
                    }

                    if (Object.keys(argsObj).length > 0) {
                        tcArgs = JSON.stringify(argsObj);
                    } else {
                        // Fallback to searching the entire DSML tag content just in case
                        const fallbackQueryMatch = fullText.match(/>([^<]+)<\/\uFF5CDSML\uFF5Cparameter>/);
                        if (fallbackQueryMatch) {
                            tcArgs = JSON.stringify({ query: fallbackQueryMatch[1].trim() });
                        } else if (fullText.includes('string="true">')) {
                            const directMatch = fullText.split('string="true">')[1]?.split('</')[0];
                            if (directMatch) {
                                tcArgs = JSON.stringify({ query: directMatch.trim() });
                            }
                        }
                    }

                    // Clean the fullText so the user doesn't see the raw XML junk in the UI
                    // if it happens to bypass the ChatArea tool filter
                    fullText = fullText.split('<\uFF5CDSML\uFF5C>function_calls>')[0].trim();
                    onChunk(fullText); // Push the cleaned text back to UI
                }
            }

            if (tcName) {
                onDone(fullText, { id: tcId, name: tcName, arguments: tcArgs });
            } else {
                onDone(fullText);
            }
        } finally {
            // Always release the queue slot and clear the pending timeout,
            // regardless of success, error, or early return.
            llmQueue.releaseSlot();
            clearTimeout(timeoutId);
        }
    } catch (err) {
        onError(err instanceof Error ? err.message : 'Unknown network error');
    }
}

export async function testConnection(provider: EndpointConfig | ProviderConfig): Promise<{ ok: boolean; detail: string }> {
    const url = getModelsUrl(provider);
    const headers: Record<string, string> = {};
    if (provider.apiKey) {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
    }

    try {
        const res = await fetch(url, { headers });
        if (res.ok) {
            return { ok: true, detail: 'Connection successful' };
        }
        return { ok: false, detail: `HTTP ${res.status}: ${await res.text()}` };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'Network error' };
    }
}
