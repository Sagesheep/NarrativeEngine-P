/**
 * Strips invalid or disallowed tool-related messages from an OpenAI-format payload.
 *
 * Handles:
 * - Removes tool_calls from assistant messages when tools are disabled
 * - Removes assistant messages whose tool_calls are all invalid (no id / no function.name)
 * - Removes orphan tool messages (no matching open call_id in the assistant turn above)
 */
export const sanitizePayloadForApi = (rawPayload: any[], allowTools: boolean): any[] => {
    const cleaned: any[] = [];
    const openToolCalls = new Set<string>();

    for (const msg of rawPayload) {
        if (!msg || typeof msg !== 'object') continue;

        if (msg.role === 'assistant') {
            if (!allowTools || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
                if (allowTools && Array.isArray(msg.tool_calls)) {
                    console.warn('[Payload] Stripped empty tool_calls from assistant message');
                } else if (!allowTools && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
                    console.warn('[Payload] Stripped tool_calls from assistant message (tools disabled)');
                }
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            const validCalls = msg.tool_calls.filter((tc: any) =>
                tc && tc.type === 'function' && typeof tc.id === 'string' &&
                tc.function && typeof tc.function.name === 'string'
            );

            if (validCalls.length === 0) {
                console.warn('[Payload] All tool_calls invalid for assistant message, stripping', msg.tool_calls?.length, 'calls');
                const { tool_calls, ...assistantNoTools } = msg;
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

    return cleaned;
};
