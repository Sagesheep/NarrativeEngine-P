/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { isThinkingEnabled } from '../stable';
import type { AppSettings } from '../../../types';

const baseSettings = (): AppSettings => ({
    debugMode: true,
    contextLimit: 8192,
} as unknown as AppSettings);

describe('isThinkingEnabled — provider-slot resolution', () => {
    it('returns true when active preset storyAIProviderId references a provider with thinkingEffort low', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'low' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });

    it('returns true for medium effort', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'medium' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });

    it('returns true for high effort', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'high' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });

    it('returns true for max effort', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'max' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });

    it('returns false when thinkingEffort is "off" (regardless of model name)', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'deepseek-r1-distill', thinkingEffort: 'off' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('returns false when thinkingEffort is unset (regardless of model name)', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'deepseek-r1-distill' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        // Unset means "user hasn't enabled thinking" — do not inject CoT.
        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('model name alone no longer triggers CoT (regex removed) — gpt-4o with thinkingEffort medium is true', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'gpt-4o', thinkingEffort: 'medium' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });
});

describe('isThinkingEnabled — preset Story slot level', () => {
    // The provider-wide picker is gone; the Story slot is what the request sends,
    // so the CoT gate must read it rather than the stored provider's frozen value.
    it('slot off beats a provider legacy high', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'high' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a', slotThinking: { story: 'off' } }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('slot high enables CoT when the provider legacy level is unset (migrated DeepSeek)', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', endpoint: 'https://api.deepseek.com/v1', modelName: 'deepseek-v4-flash' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a', slotThinking: { story: 'high' } }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });

    it('another slot\'s level does not leak into the story gate', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [{ id: 'prov_a', modelName: 'anything' }],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_a', slotThinking: { utility: 'high', summarizer: 'max' } }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });
});

describe('isThinkingEnabled — legacy fallback', () => {
    it('falls back to activePreset.storyAI.thinkingEffort when storyAIProviderId is missing', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_legacy',
            providers: [],
            presets: [
                {
                    id: 'preset_legacy',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'anything', thinkingEffort: 'high' } as any,
                },
            ],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });

    it('returns false when legacy storyAI has thinkingEffort "off"', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_legacy',
            providers: [],
            presets: [
                {
                    id: 'preset_legacy',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'anything', thinkingEffort: 'off' } as any,
                },
            ],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('returns false when legacy storyAI has no thinkingEffort (even for old deepseek-r1 model names)', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_legacy',
            providers: [],
            presets: [
                {
                    id: 'preset_legacy',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'deepseek-r1' } as any,
                },
            ],
        } as unknown as AppSettings;

        // No thinkingEffort set → user has not opted in → no CoT.
        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('provider slot takes precedence over legacy storyAI', () => {
        // Provider slot has thinkingEffort high; legacy storyAI has none.
        // Two-tier resolution should win → true.
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_mixed',
            providers: [{ id: 'prov_thinking', modelName: 'anything', thinkingEffort: 'high' }],
            presets: [
                {
                    id: 'preset_mixed',
                    storyAIProviderId: 'prov_thinking',
                    storyAI: { endpoint: 'http://x', apiKey: '', modelName: 'anything' } as any,
                },
            ],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(true);
    });
});

describe('isThinkingEnabled — defensive cases', () => {
    it('returns false when no preset is active', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'missing',
            providers: [{ id: 'prov_a', modelName: 'anything', thinkingEffort: 'high' }],
            presets: [],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('returns false when active preset references a missing provider and has no legacy storyAI', () => {
        const settings = {
            ...baseSettings(),
            activePresetId: 'preset_1',
            providers: [],
            presets: [{ id: 'preset_1', storyAIProviderId: 'prov_missing' }],
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });

    it('returns false when providers/presets arrays are undefined (old campaign hydration)', () => {
        const settings = {
            ...baseSettings(),
        } as unknown as AppSettings;

        expect(isThinkingEnabled(settings)).toBe(false);
    });
});