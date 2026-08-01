import type { EndpointConfig, ProviderConfig } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessage } from '../llm/llmService';
import { extractJson } from '../infrastructure/jsonExtract';

export const RETRY_SUFFIX = '\n\nIMPORTANT: Your previous response was not valid JSON. Respond with ONLY valid JSON. No markdown fences, no comments, no trailing commas, no extra text before or after the JSON.';

// sanitizeSignatureKit moved to services/npc/signatureKit.ts (a pure, LLM-free module)
// so the deterministic lore parser can reuse the same bounds. Re-exported here to keep
// existing `import { sanitizeSignatureKit } from './shared'` call sites working.
export { sanitizeSignatureKit } from '../npc/signatureKit';

export type JsonModelCall = (messages: OpenAIMessage[], contextLabel: string, trackingLabel?: string) => Promise<string>;

export async function sendMessageAndParseJson(
    provider: EndpointConfig | ProviderConfig | undefined,
    messages: OpenAIMessage[],
    contextLabel: string,
    trackingLabel?: string,
    modelCall?: JsonModelCall,
// eslint-disable-next-line @typescript-eslint/no-explicit-any
): Promise<{ parsed: any; rawStr: string }> {
    let fullJsonStr = '';

    if (modelCall) {
        fullJsonStr = await modelCall(messages, contextLabel, trackingLabel);
    } else {
        await sendMessage(
            provider!,
            messages,
            (chunk) => { fullJsonStr = chunk; },
            () => { },
            (err) => console.error(`[${contextLabel}] Stream error:`, err),
            undefined,
            undefined,
            undefined,
            undefined,
            trackingLabel,
        );
    }

    if (!fullJsonStr) throw new Error(`[${contextLabel}] Empty response from LLM`);

    const cleanStr = extractJson(fullJsonStr);

    try {
        return { parsed: JSON.parse(cleanStr), rawStr: cleanStr };
    } catch (firstErr) {
        console.warn(`[${contextLabel}] First parse failed, retrying with stricter prompt...`, firstErr);
        console.warn(`[${contextLabel}] Raw JSON was:`, cleanStr);

        const retryMessages: OpenAIMessage[] = [
            ...messages,
            { role: 'assistant', content: fullJsonStr },
            { role: 'user', content: RETRY_SUFFIX }
        ];

        let retryStr = '';
        if (modelCall) {
            retryStr = await modelCall(retryMessages, contextLabel, trackingLabel);
        } else {
            await sendMessage(
                provider!,
                retryMessages,
                (chunk) => { retryStr = chunk; },
                () => { },
                (err) => console.error(`[${contextLabel}] Retry stream error:`, err),
                undefined,
                undefined,
                undefined,
                undefined,
                trackingLabel,
            );
        }

        if (!retryStr) throw new Error(`[${contextLabel}] Empty retry response`);

        const retryClean = extractJson(retryStr);
        try {
            return { parsed: JSON.parse(retryClean), rawStr: retryClean };
        } catch (retryErr) {
            console.error(`[${contextLabel}] Retry parse also failed:`, retryErr);
            console.error(`[${contextLabel}] Retry raw JSON:`, retryClean);
            throw retryErr;
        }
    }
}
