import type { AIPreset, AppSettings, LLMProvider, ThinkingEffort, ThinkingSlot } from '../../types';

/** Anything a role getter can hand out: a stored provider or an endpoint config. */
type Endpoint = object & { thinkingEffort?: ThinkingEffort };

// ── Per-slot thinking ───────────────────────────────────────────────────
//
// Thinking effort used to live on the provider, so one provider serving the
// story slot and the utility slot had to think the same amount for both. It now
// lives on the preset slot (`AIPreset.slotThinking`). The role getters hand
// callers a copy of the provider whose `thinkingEffort` is the slot's level, so
// `buildChatBody` / `llmCall` keep reading `provider.thinkingEffort` unchanged.
//
// Precedence: per-call `thinkingEffort` > slot level > provider's legacy value.

export const THINKING_SLOTS: readonly ThinkingSlot[] = ['story', 'summarizer', 'utility', 'auxiliary', 'vision'];

export const THINKING_EFFORTS: readonly ThinkingEffort[] = ['off', 'low', 'medium', 'high', 'max'];

// Copies are cached per stored provider object so a getter returns the same
// reference until the provider (or the slot's level) changes. Zustand selectors
// such as `useAppStore(s => s.getActiveStoryEndpoint())` depend on that: a fresh
// object on every call would re-render forever.
const slotCopies = new WeakMap<object, Map<ThinkingEffort, object>>();

/**
 * Returns `provider` as it should be used for `slot`'s job: a copy carrying the
 * slot's thinking level, or the provider itself when the slot has no level.
 * Never mutates the stored provider.
 */
export function applySlotThinking<T extends Endpoint | undefined>(
    provider: T,
    preset: AIPreset | undefined,
    slot: ThinkingSlot,
): T {
    if (!provider) return provider;
    const level = preset?.slotThinking?.[slot];
    if (!level) return provider;
    let byLevel = slotCopies.get(provider);
    if (!byLevel) {
        byLevel = new Map();
        slotCopies.set(provider, byLevel);
    }
    let copy = byLevel.get(level);
    if (!copy) {
        copy = { ...provider, thinkingEffort: level };
        byLevel.set(level, copy);
    }
    return copy as T;
}

/** `applySlotThinking` against the active preset of a settings snapshot. */
export function applyActiveSlotThinking<T extends Endpoint | undefined>(
    settings: AppSettings | undefined,
    slot: ThinkingSlot,
    provider: T,
): T {
    const preset = settings?.presets?.find(p => p.id === settings.activePresetId) ?? settings?.presets?.[0];
    return applySlotThinking(provider, preset, slot);
}

/**
 * True when an unset provider level already meant "the model thinks", so `'high'`
 * keeps that behaviour. DeepSeek's own API thinks by default and Gemini thinks
 * dynamically by default. Claude is excluded on purpose: the old provider picker
 * stored "Off" as unset and Claude only thinks when given a budget, so unset there
 * meant no thinking. Generic OpenAI-compatible servers, Ollama and OpenRouter
 * depend on the model, so we can't tell.
 */
function thinksWhenUnset(provider: LLMProvider): boolean {
    if (provider.apiFormat === 'gemini') return true;
    if (provider.apiFormat === 'openai' || !provider.apiFormat) {
        try {
            return new URL(provider.endpoint.replace(/\/+$/, '')).hostname.includes('deepseek');
        } catch {
            return false;
        }
    }
    return false;
}

/**
 * Seeds `slotThinking` on presets that predate it. Never overwrites a level
 * already set, so running it again changes nothing.
 *  - story: the story provider's legacy `thinkingEffort`; if unset, `'high'`
 *    where unset already meant thinking (see `thinksWhenUnset`), else left
 *    unset (provider default).
 *  - every other slot: `'off'`.
 * Returns the same preset object when nothing changed.
 */
export function migratePresetSlotThinking(preset: AIPreset, providers: readonly LLMProvider[]): AIPreset {
    const current = preset.slotThinking ?? {};
    const next: Partial<Record<ThinkingSlot, ThinkingEffort>> = { ...current };
    let changed = false;

    if (!current.story) {
        const story = providers.find(p => p.id === preset.storyAIProviderId);
        const inherited = story?.thinkingEffort ?? (story && thinksWhenUnset(story) ? 'high' : undefined);
        if (inherited) {
            next.story = inherited;
            changed = true;
        }
    }
    for (const slot of THINKING_SLOTS) {
        if (slot === 'story' || current[slot]) continue;
        next[slot] = 'off';
        changed = true;
    }

    return changed ? { ...preset, slotThinking: next } : preset;
}
