import type { ApiFormat, InjectionTrigger, PromptInjection } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';

export const INJECTION_TRIGGERS: InjectionTrigger[] = ['reply', 'swipe', 'continue'];

/** Saved settings are untrusted (old versions and hand-edited/imported presets). */
export function normalizeInjections(value: unknown): PromptInjection[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry, index) => {
        if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') return [];
        const mode = entry.mode === 'prefill' || entry.mode === 'reasoning' ? entry.mode : 'message';
        return [{
            id: typeof entry.id === 'string' ? entry.id : `injection-${index}`,
            name: typeof entry.name === 'string' ? entry.name : 'Untitled injection',
            enabled: entry.enabled === true,
            role: entry.role === 'user' || entry.role === 'assistant' ? entry.role : 'system',
            content: entry.content,
            depth: typeof entry.depth === 'number' && Number.isFinite(entry.depth) ? Math.max(0, Math.floor(entry.depth)) : 0,
            triggers: Array.isArray(entry.triggers)
                ? INJECTION_TRIGGERS.filter(trigger => entry.triggers.includes(trigger))
                : [...INJECTION_TRIGGERS],
            mode,
        } satisfies PromptInjection];
    });
}

export function injectionTrigger(label?: string): InjectionTrigger | undefined {
    if (label === 'story-generation') return 'reply';
    if (label === 'swipe-generation') return 'swipe';
    if (label === 'scene-continue') return 'continue';
    return undefined;
}

export function injectionText(injection: PromptInjection): string {
    return injection.mode === 'reasoning' ? `<think>\n${injection.content}` : injection.content;
}

export function activeInjections(value: unknown, trigger: InjectionTrigger): PromptInjection[] {
    return normalizeInjections(value).filter(item => item.enabled && item.content.trim() && item.triggers.includes(trigger));
}

export type InjectionPlacement = { index: number; injection: PromptInjection; message: OpenAIMessage };

/** Depth counts conversational messages, never the leading context or tool results.
 * Tool calls/results stay adjacent. Prefills always follow every depth injection.
 * No input mutation: snapshots/history never contain these transient messages.
 */
export function planInjections(messages: readonly OpenAIMessage[], value: unknown, trigger: InjectionTrigger, format: ApiFormat = 'openai'): InjectionPlacement[] {
    let prefixEnd = 0;
    while (prefixEnd < messages.length && messages[prefixEnd].role === 'system') prefixEnd++;
    const anchors = messages.flatMap((message, index) =>
        index >= prefixEnd && (message.role === 'user' || message.role === 'assistant') && !message.tool_calls?.length ? [index] : []);
    return activeInjections(value, trigger).map(injection => {
        const depth = Math.min(injection.depth, anchors.length);
        let index = injection.mode !== 'message' || depth === 0
            ? messages.length : anchors[anchors.length - depth];
        // Never split a tool exchange, including multiple tool-result messages.
        while (index > prefixEnd && messages[index]?.role === 'tool') index--;
        const role = injection.mode === 'message' ? injection.role : 'assistant';
        const nativeSystemFallback = role === 'system' && (format === 'claude' || format === 'gemini');
        return {
            index,
            injection,
            message: {
                role: nativeSystemFallback ? 'user' : role,
                content: nativeSystemFallback ? `[System instruction]\n${injectionText(injection)}` : injectionText(injection),
            },
        };
    }).sort((a, b) => a.index - b.index || Number(a.injection.mode !== 'message') - Number(b.injection.mode !== 'message'));
}

export function applyInjections(messages: OpenAIMessage[], value: unknown, trigger: InjectionTrigger, format: ApiFormat = 'openai'): OpenAIMessage[] {
    const placements = planInjections(messages, value, trigger, format);
    if (!placements.length) return messages;
    const result: OpenAIMessage[] = [];
    for (let index = 0; index <= messages.length; index++) {
        for (const placement of placements) {
            if (placement.index !== index) continue;
            const previous = result[result.length - 1];
            // Multiple prefill cards form one assistant prefix, in card order.
            if (placement.injection.mode !== 'message' && previous?.role === 'assistant' && index === messages.length) {
                result[result.length - 1] = { ...previous, content: `${previous.content ?? ''}\n\n${placement.message.content}` };
            } else result.push(placement.message);
        }
        if (index < messages.length) result.push(messages[index]);
    }
    return result;
}
