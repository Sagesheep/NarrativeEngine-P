import type { ApiFormat, InjectionTarget, InjectionTrigger, PromptInjection } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';

export const INJECTION_TRIGGERS: InjectionTrigger[] = ['reply', 'swipe', 'continue'];

/** Every target a card can be sent to, in editor order. */
export const INJECTION_TARGETS: InjectionTarget[] = ['story', 'director', 'recommender'];

/** A card's target; absent (cards saved before targets existed) means the story AI. */
export function injectionTargetOf(injection: Pick<PromptInjection, 'target'>): InjectionTarget {
    return injection.target ?? 'story';
}

/** Story cards are the only ones placed in the story request and reserved from its context budget. */
export function isStoryInjection(injection: Pick<PromptInjection, 'target'>): boolean {
    return injectionTargetOf(injection) === 'story';
}

/** Saved settings are untrusted (old versions and hand-edited/imported presets). */
export function normalizeInjections(value: unknown): PromptInjection[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry, index) => {
        if (!entry || typeof entry !== 'object' || typeof entry.content !== 'string') return [];
        const mode = entry.mode === 'prefill' || entry.mode === 'reasoning' ? entry.mode : 'message';
        // Story is the absent default, so a story card stays shaped exactly as it was saved.
        const target: InjectionTarget = INJECTION_TARGETS.includes(entry.target) ? entry.target : 'story';
        return [{
            ...(target !== 'story' ? { target } : {}),
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

/** Story-AI cards that fire for this trigger. Helper-target cards never reach the story request. */
export function activeInjections(value: unknown, trigger: InjectionTrigger): PromptInjection[] {
    return normalizeInjections(value).filter(item => isStoryInjection(item) && item.enabled && item.content.trim() && item.triggers.includes(trigger));
}

/** Story-AI cards that may fire at all — what the story context budget reserves room for. */
export function reservedStoryInjections(value: unknown): PromptInjection[] {
    return normalizeInjections(value).filter(item => isStoryInjection(item) && item.enabled && item.content.trim() && item.triggers.length > 0);
}

/**
 * Enabled, non-empty cards for one helper prompt, in card order. Triggers do not
 * apply: a helper card is sent every time that helper runs.
 */
export function helperInjections(value: unknown, target: Exclude<InjectionTarget, 'story'>): PromptInjection[] {
    return normalizeInjections(value).filter(item => injectionTargetOf(item) === target && item.enabled && item.content.trim());
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
