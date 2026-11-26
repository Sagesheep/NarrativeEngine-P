/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Strips invalid or disallowed tool-related messages from an OpenAI-format payload.
 *
 * Handles:
 * - Removes tool_calls from assistant messages when tools are disabled
 * - Removes assistant messages whose tool_calls are all invalid (no id / no function.name)
 * - Removes orphan tool messages (no matching open call_id in the assistant turn above)
 */
// Models that require reasoning_content to be echoed back on every assistant message that had tool_calls.
const THINKING_MODEL_RE = /deepseek-r|deepseek-v[34]|deepseek.*think|qwq|qwen.*think|r1/i;

export const sanitizePayloadForApi = (rawPayload: any[], allowTools: boolean, modelName?: string): any[] => {
    const isThinkingModel = modelName ? THINKING_MODEL_RE.test(modelName) : false;

    const cleaned: any[] = [];
    const openToolCalls = new Set<string>();

    for (const msg of rawPayload) {
        if (!msg || typeof msg !== 'object') continue;

        if (msg.role === 'assistant') {
            const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;

            // Thinking-model guard: DeepSeek requires reasoning_content on every assistant message
            // that previously had tool_calls. If it's missing (e.g. captured from an older session
            // before the fix), strip tool_calls so the turn looks like a plain non-tool assistant
            // turn — preventing a 400. The orphaned tool message will be dropped below.
            if (isThinkingModel && hasToolCalls && !msg.reasoning_content) {
                console.warn('[Sanitizer] Thinking-model: stripping tool_calls from assistant missing reasoning_content — would cause 400. ids:', msg.tool_calls.map((tc: any) => tc.id));
                const stripped = { ...msg };
                delete (stripped as any).tool_calls;
                cleaned.push(stripped);
                continue;
            }

            if (!allowTools || !hasToolCalls) {
                if (allowTools && Array.isArray(msg.tool_calls)) {
                    console.warn('[Payload] Stripped empty tool_calls from assistant message');
                } else if (!allowTools && hasToolCalls) {
                    console.warn('[Payload] Stripped tool_calls from assistant message (tools disabled)');
                }
                const assistantNoTools = { ...msg };
                delete (assistantNoTools as any).tool_calls;
                cleaned.push(assistantNoTools);
                continue;
            }

            const validCalls = msg.tool_calls.filter((tc: any) => {
                if (!tc || tc.type !== 'function' || typeof tc.id !== 'string') return false;
                if (!tc.function || typeof tc.function.name !== 'string') return false;
                if (typeof tc.function.arguments === 'string' && tc.function.arguments.trim()) {
                    try { JSON.parse(tc.function.arguments); } catch {
                        console.warn('[Payload] Dropping tool_call with invalid JSON arguments:', tc.function.name, tc.id);
                        return false;
                    }
                }
                return true;
            });

            if (validCalls.length === 0) {
                console.warn('[Payload] All tool_calls invalid for assistant message, stripping', msg.tool_calls?.length, 'calls');
                const assistantNoTools = { ...msg };
                delete (assistantNoTools as any).tool_calls;
                cleaned.push(assistantNoTools);
                continue;
            }

            cleaned.push({ ...msg, tool_calls: validCalls });
            for (const tc of validCalls) openToolCalls.add(tc.id);
            continue;
        }

        if (msg.role === 'tool') {
            if (!allowTools) continue;

            const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!callId || !openToolCalls.has(callId)) {
                console.warn('[Payload] Dropping orphan tool message:', msg.tool_call_id);
                continue;
            }

            openToolCalls.delete(callId);
            cleaned.push(msg);
            continue;
        }

        cleaned.push(msg);
    }

    const resolvedCallIds = new Set(
        cleaned.filter(m => m.role === 'tool' && typeof m.tool_call_id === 'string')
               .map(m => m.tool_call_id as string)
    );
    const result = cleaned.map(msg => {
        if (msg.role === 'assistant' && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
            const resolved = msg.tool_calls.filter((tc: any) => resolvedCallIds.has(tc.id));
            if (resolved.length !== msg.tool_calls.length) {
                console.warn('[Payload] Stripping unresolved tool_calls from assistant message to prevent 400');
                const rest = { ...msg };
                delete (rest as any).tool_calls;
                return resolved.length > 0 ? { ...rest, tool_calls: resolved } : rest;
            }
        }
        return msg;
    });

    return result;
};
