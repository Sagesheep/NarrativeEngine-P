import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../settingsHelpers', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../settingsHelpers')>()),
    debouncedSaveSettings: vi.fn(),
}));

import { migrateSettings } from '../settingsHelpers';
import { applyActiveSlotThinking, applySlotThinking, migratePresetSlotThinking } from '../slotThinking';
import { useAppStore } from '../../useAppStore';
import { buildChatBody } from '../../../utils/llmApiHelper';
import type { AIPreset, LLMProvider } from '../../../types';

const flash: LLMProvider = {
    id: 'flash', label: 'DS v4 Flash', endpoint: 'https://api.deepseek.com/v1',
    apiKey: 'k', modelName: 'deepseek-v4-flash', apiFormat: 'openai', thinkingEffort: 'medium',
};

function preset(over: Partial<AIPreset> = {}): AIPreset {
    return {
        id: 'pr', name: 'P',
        storyAIProviderId: 'flash', summarizerAIProviderId: 'flash',
        utilityAIProviderId: 'flash', auxiliaryAIProviderId: 'flash',
        imageAIProviderId: '', visionAIProviderId: 'flash',
        ...over,
    };
}

const MSGS = [{ role: 'user', content: 'hi' }];

describe('slot thinking — migration', () => {
    it('story slot inherits the story provider level; every other slot starts at off', () => {
        const out = migrateSettings({ settings: { providers: [flash], presets: [preset()], activePresetId: 'pr' } });
        expect(out.presets[0].slotThinking).toEqual({
            story: 'medium', summarizer: 'off', utility: 'off', auxiliary: 'off', vision: 'off',
        });
        // The deprecated provider value is kept, not deleted.
        expect(out.providers[0].thinkingEffort).toBe('medium');
    });

    it('never overwrites a level already set, and running it again changes nothing', () => {
        const existing = preset({ slotThinking: { story: 'low', utility: 'high' } });
        const once = migratePresetSlotThinking(existing, [flash]);
        expect(once.slotThinking).toEqual({ story: 'low', utility: 'high', summarizer: 'off', auxiliary: 'off', vision: 'off' });
        const twice = migratePresetSlotThinking(once, [flash]);
        expect(twice).toBe(once);

        const reloaded = migrateSettings({ settings: { providers: [flash], presets: [once], activePresetId: 'pr' } });
        expect(reloaded.presets[0].slotThinking).toEqual(once.slotThinking);
    });

    it('unset provider level: high where unset already meant thinking, else left unset', () => {
        const unset = (over: Partial<LLMProvider>): LLMProvider => ({ ...flash, thinkingEffort: undefined, ...over });
        const story = (p: LLMProvider) => migratePresetSlotThinking(preset(), [p]).slotThinking?.story;
        expect(story(unset({}))).toBe('high');                                                       // DeepSeek host
        expect(story(unset({ apiFormat: 'gemini', endpoint: 'https://generativelanguage.googleapis.com' }))).toBe('high');
        expect(story(unset({ apiFormat: 'claude', endpoint: 'https://api.anthropic.com' }))).toBeUndefined();
        expect(story(unset({ endpoint: 'http://localhost:1234/v1' }))).toBeUndefined();          // generic OpenAI-compatible
        expect(story(unset({ apiFormat: 'ollama', endpoint: 'http://localhost:11434' }))).toBeUndefined();
    });
});

describe('slot thinking — resolution', () => {
    beforeEach(() => {
        const settings = migrateSettings({
            settings: { providers: [flash], presets: [preset({ slotThinking: { story: 'high', utility: 'off', summarizer: 'low' } })], activePresetId: 'pr' },
        });
        useAppStore.setState({ settings });
    });

    it('one provider in two slots resolves to two levels without mutating the stored provider', () => {
        const s = useAppStore.getState();
        const stored = s.settings.providers[0];
        const before = { ...stored };
        expect(s.getActiveStoryEndpoint()?.thinkingEffort).toBe('high');
        expect(s.getActiveUtilityEndpoint()?.thinkingEffort).toBe('off');
        expect(s.getActiveSummarizerEndpoint()?.thinkingEffort).toBe('low');
        expect(s.getActiveStoryEndpoint()).not.toBe(stored);
        expect(stored).toEqual(before);
        expect(useAppStore.getState().settings.providers[0].thinkingEffort).toBe('medium');
    });

    it('returns a stable reference across calls (zustand selectors depend on it)', () => {
        const s = useAppStore.getState();
        expect(s.getActiveStoryEndpoint()).toBe(s.getActiveStoryEndpoint());
    });

    it('a slot with no level falls back to the provider legacy value', () => {
        const p = preset({ slotThinking: {} });
        expect(applySlotThinking(flash, p, 'story')).toBe(flash);
        expect(applySlotThinking(flash, p, 'story')?.thinkingEffort).toBe('medium');
    });

    it('a story fallback doing another slot\'s job takes that slot\'s level', () => {
        const settings = useAppStore.getState().settings;
        const story = useAppStore.getState().getActiveStoryEndpoint();
        expect(applyActiveSlotThinking(settings, 'summarizer', story)?.thinkingEffort).toBe('low');
        expect(applyActiveSlotThinking(settings, 'story', story)?.thinkingEffort).toBe('high');
    });
});

describe('slot thinking — precedence through buildChatBody', () => {
    const highSlot = applySlotThinking(flash, preset({ slotThinking: { story: 'high' } }), 'story')!;

    it('DeepSeek host: an explicit per-call off still disables thinking when the slot says high', () => {
        expect(buildChatBody(highSlot, MSGS, { thinkingEffort: 'off' }).thinking).toEqual({ type: 'disabled' });
        expect(buildChatBody(highSlot, MSGS, { thinkingEffort: 'off' }).reasoning_effort).toBeUndefined();
        // Without the per-call override, the slot level reaches the wire.
        expect(buildChatBody(highSlot, MSGS).reasoning_effort).toBe('high');
    });

    it('Claude: an explicit per-call off sends no thinking budget when the slot says high', () => {
        const claude: LLMProvider = { ...flash, id: 'c', endpoint: 'https://api.anthropic.com', apiFormat: 'claude', modelName: 'claude-x' };
        const slotted = applySlotThinking(claude, preset({ storyAIProviderId: 'c', slotThinking: { story: 'high' } }), 'story')!;
        expect(buildChatBody(slotted, MSGS, { thinkingEffort: 'off' }).thinking).toBeUndefined();
        expect(buildChatBody(slotted, MSGS).thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
    });

    it('slot level beats the provider legacy value', () => {
        const offSlot = applySlotThinking(flash, preset({ slotThinking: { utility: 'off' } }), 'utility')!;
        expect(buildChatBody(offSlot, MSGS).thinking).toEqual({ type: 'disabled' });
        expect(buildChatBody(flash, MSGS).reasoning_effort).toBe('medium');
    });
});
