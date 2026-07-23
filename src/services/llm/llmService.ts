import type { EndpointConfig, ProviderConfig, SamplingConfig, ThinkingEffort } from '../../types';
import { uid } from '../../utils/uid';
import { getQueueForEndpoint } from './llmRequestQueue';
import { getChatUrl, getModelsUrl, buildChatHeaders, buildChatBody, getApiFormat, extractStreamDelta, extractStreamToolCall } from '../../utils/llmApiHelper';
import { recordCacheUsage, type LLMUsage } from './cacheTelemetry';
import { llmFetch } from './llmFetch';
import { startUtilityCall } from './utilityCallTracker';

const STORY_LABEL = 'story-generation';
const STREAM_IDLE_TIMEOUT_MS = 120_000;

export type OpenAIMessage = {
    role: 'system' | 'user' | 'assistant' | 'tool';
    content: string | null;
    name?: string;
    tool_calls?: unknown[];
    tool_call_id?: string;
    reasoning_content?: string;
    cache_control?: { type: 'ephemeral' };
};

export async function sendMessage(
    provider: EndpointConfig | ProviderConfig,
    messages: OpenAIMessage[],
    onChunk: (text: string) => void,
    onDone: (text: string, toolCall?: { id: string; name: string; arguments: string }, reasoningContent?: string) => void,
    onError: (err: string) => void,
    tools?: unknown[],
    abortController?: AbortController,
    sampling?: SamplingConfig,
    thinkingEffort?: ThinkingEffort,
    trackingLabel?: string,
    /** Optional: fires with the CUMULATIVE reasoning/thinking text as it streams.
     *  Additive — existing chat callers omit it and behave exactly as before. */
    onReasoning?: (reasoning: string) => void,
) {
    const format = getApiFormat(provider);
    const url = getChatUrl(provider, { stream: true });
    const headers = buildChatHeaders(provider);

    // Hoisted out of the try block so the catch can see them for terminal-state classification.
    const controller = abortController || new AbortController();
    const trackingName = (provider as EndpointConfig).modelName || provider.endpoint;
    const label = trackingLabel ?? STORY_LABEL;
    const trackerHandle = startUtilityCall(label, trackingName, STREAM_IDLE_TIMEOUT_MS);
    let streamTimedOut = false;
    let streamSettled = false;
    trackerHandle.deadlinePromise.then(() => {
        if (streamSettled) return;
        streamTimedOut = true;
        controller.abort();
    });

    try {
        const payload = buildChatBody(provider, messages, { stream: true, tools: tools ?? [], sampling, thinkingEffort });

        // Gemini auth: append ?key= to URL
        let fetchUrl = url;
        if (format === 'gemini' && provider.apiKey) {
            const sep = fetchUrl.includes('?') ? '&' : '?';
            fetchUrl = `${fetchUrl}${sep}key=${provider.apiKey}`;
        }

        const queue = getQueueForEndpoint(provider.endpoint);
        await queue.acquireSlot('normal');
        try {
            const res = await llmFetch(fetchUrl, {
                method: 'POST',
                headers,
                body: JSON.stringify(payload),
                signal: controller.signal
            });

            if (!res.ok) {
                const errBody = await res.text();
                if (res.status === 429 || res.status === 503 || res.status === 529) queue.onRateLimitHit();
                streamSettled = true;
                trackerHandle.settleError('error', `API error ${res.status}: ${errBody}`);
                onError(`API error ${res.status}: ${errBody}`);
                return;
            }

            const reader = res.body?.getReader();
            if (!reader) {
                streamSettled = true;
                trackerHandle.settleError('error', 'No readable stream in response');
                onError('No readable stream in response');
                return;
            }

            const decoder = new TextDecoder();
            let buffer = '';
            let fullText = '';
            let reasoningContent = '';
            let streamUsage: LLMUsage | undefined;

            let tcId = '';
            let tcName = '';
            let tcArgs = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                // Rolling idle timeout: each chunk resets the tracker deadline so a slow-but-
                // streaming reply isn't killed mid-token. EXTEND from the UI pushes it further.
                trackerHandle.resetDeadline(STREAM_IDLE_TIMEOUT_MS);

                buffer += decoder.decode(value, { stream: true });
                const lines = buffer.split('\n');
                buffer = lines.pop() || '';

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed) continue;

                    if (format === 'ollama') {
                        try {
                            const parsed = JSON.parse(trimmed);
                            if (parsed.message?.content) {
                                fullText += parsed.message.content;
                                onChunk(fullText);
                            }
                        } catch {
                            // skip malformed chunks
                        }
                    } else if (format === 'claude' || format === 'gemini') {
                        if (!trimmed.startsWith('data: ')) continue;
                        const data = trimmed.slice(6);
                        if (data === '[DONE]') continue;

                        try {
                            const parsed = JSON.parse(data);
                            const delta = extractStreamDelta(parsed, provider);
                            if (delta) {
                                fullText += delta;
                                onChunk(fullText);
                            }

                            const tc = extractStreamToolCall(parsed, provider);
                            if (tc) {
                                if (tc.id) tcId = tc.id;
                                if (tc.name) tcName = tc.name;
                                if (tc.arguments) tcArgs += tc.arguments;
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
                            // DeepSeek/OpenAI emit a trailing chunk (choices:[]) carrying usage
                            // when stream_options.include_usage is set.
                            if (parsed.usage) streamUsage = parsed.usage as LLMUsage;
                            const delta = parsed.choices?.[0]?.delta;

                            if (delta?.content) {
                                fullText += delta.content;
                                onChunk(fullText);
                            }

                            // Capture reasoning — handle both field names seen in the wild
                            const reasoningDelta: string = delta?.reasoning_content ?? delta?.reasoning ?? '';
                            if (reasoningDelta) {
                                reasoningContent += reasoningDelta;
                                onReasoning?.(reasoningContent);
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
            // Gate: only run for OpenAI-compatible format (Claude and Gemini never emit DSML tags)
            // AND only when tools were actually offered in this request. If tools were disabled
            // (e.g. tool-call budget exhausted), parsing DSML tags into a tool call would re-arm
            // a search the orchestrator has already capped — causing an infinite "Checking Notes" loop.
            if (format !== 'claude' && format !== 'gemini' && !tcName && tools && tools.length > 0 && fullText.includes('<\uFF5CDSML\uFF5C>function_calls>')) {
                const funcMatch = fullText.match(/<\uFF5CDSML\uFF5C>invoke name="([^"]+)">/);
                if (funcMatch) {
                    tcName = funcMatch[1];
                    tcId = uid();

                    const paramRegex = /<\uFF5CDSML\uFF5Cparameter name="([^"]+)"[^>]*>([\s\S]*?)<\/\uFF5CDSML\uFF5Cparameter>/g;
                    let match;
                    const argsObj: Record<string, unknown> = {};

                    while ((match = paramRegex.exec(fullText)) !== null) {
                        argsObj[match[1]] = match[2].trim();
                    }

                    if (Object.keys(argsObj).length > 0) {
                        tcArgs = JSON.stringify(argsObj);
                    } else {
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

                    fullText = fullText.split('<\uFF5CDSML\uFF5C>function_calls>')[0].trim();
                    onChunk(fullText);
                }
            }

            recordCacheUsage(STORY_LABEL, streamUsage);

            streamSettled = true;
            if (tcName) {
                trackerHandle.settleSuccess();
                onDone(fullText, { id: tcId, name: tcName, arguments: tcArgs }, reasoningContent || undefined);
            } else {
                trackerHandle.settleSuccess();
                onDone(fullText, undefined, reasoningContent || undefined);
            }
        } finally {
            queue.releaseSlot();
        }
    } catch (err) {
        streamSettled = true;
        // Distinguish tracker-idle-timeout from user abort from real errors so the strip
        // shows the right terminal state (timeout vs aborted vs error).
        if (streamTimedOut) {
            trackerHandle.settleError('timeout');
        } else if (abortController?.signal.aborted || controller.signal.aborted) {
            trackerHandle.settleError('aborted');
        } else {
            const msg = err instanceof Error ? err.message : 'Unknown network error';
            trackerHandle.settleError('error', msg);
        }
        onError(err instanceof Error ? err.message : 'Unknown network error');
    }
}

export async function testConnection(provider: EndpointConfig | ProviderConfig): Promise<{ ok: boolean; detail: string }> {
    const format = getApiFormat(provider);

    // ComfyUI is an image server, not an LLM — it has no /models endpoint. Probe
    // /system_stats instead, which every ComfyUI build exposes and which returns 200
    // with a JSON payload when the server is up.
    if (format === 'comfyui') {
        const base = (provider.endpoint || '').replace(/\/+$/, '');
        if (!base) return { ok: false, detail: 'No endpoint configured' };
        try {
            const res = await llmFetch(`${base}/system_stats`, {});
            if (res.ok) return { ok: true, detail: 'Connection successful' };
            return { ok: false, detail: `HTTP ${res.status}: ${await res.text()}` };
        } catch (err) {
            return { ok: false, detail: err instanceof Error ? err.message : 'Network error' };
        }
    }

    const headers = buildChatHeaders(provider);
    // Remove Content-Type for GET requests
    delete headers['Content-Type'];
    let url = getModelsUrl(provider);

    // Gemini auth: append ?key= to URL
    if (format === 'gemini' && provider.apiKey) {
        url = `${url}?key=${provider.apiKey}`;
    }

    try {
        const res = await llmFetch(url, { headers });
        if (res.ok) {
            return { ok: true, detail: 'Connection successful' };
        }
        return { ok: false, detail: `HTTP ${res.status}: ${await res.text()}` };
    } catch (err) {
        return { ok: false, detail: err instanceof Error ? err.message : 'Network error' };
    }
}