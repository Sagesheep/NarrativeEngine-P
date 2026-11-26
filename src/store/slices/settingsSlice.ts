import type { StateCreator } from 'zustand';
import type { AiTier, AppSettings, LLMProvider, AIPreset } from '../../types';
import { emitCoreEvent } from '../../services/mods/events';
import { get as idbGet } from 'idb-keyval';
import { decryptSettingsProviders, decryptSettingsPresets } from '../../services/infrastructure/settingsCrypto';
import { toast } from '../../components/Toast';
import { applySlotThinking } from './slotThinking';

import { API_BASE as API } from '../../lib/apiBase';

import {
    migrateSettings,
    applyTheme,
    applyUIScale,
    applyBetaUi,
    applyLocale,
    debouncedSaveSettings,
    defaultSettings,
} from './settingsHelpers';

// Re-export the public helper surface so external importers keep working untouched.
export {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
    defaultProvider, defaultPreset, defaultSettings,
    applyTheme, systemTheme, applyUIScale, applyBetaUi, applyLocale, migrateSettings, debouncedSaveSettings,
} from './settingsHelpers';

// ── Slice type ─────────────────────────────────────────────────────────

export type SettingsSlice = {
    settings: AppSettings;
    settingsLoaded: boolean;
    updateSettings: (patch: Partial<AppSettings>) => void;
    loadSettings: () => Promise<void>;

    addPreset: (preset: AIPreset) => void;
    updatePreset: (id: string, patch: Partial<AIPreset>) => void;
    removePreset: (id: string) => void;
    setActivePreset: (id: string) => void;
    getActivePreset: () => AIPreset | undefined;
    getActiveStoryEndpoint: () => LLMProvider | undefined;
    getActiveImageEndpoint: () => LLMProvider | undefined;
    getActiveSummarizerEndpoint: () => LLMProvider | undefined;
    getActiveUtilityEndpoint: () => LLMProvider | undefined;
    getActiveAuxiliaryEndpoint: () => LLMProvider | undefined;
    getActiveVisionEndpoint: () => LLMProvider | undefined;

    addProvider: (provider: LLMProvider) => void;
    updateProvider: (id: string, patch: Partial<LLMProvider>) => void;
    removeProvider: (id: string) => void;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createSettingsSlice: StateCreator<SettingsSlice & { activeCampaignId: string | null }, [], [], SettingsSlice> = (set, get) => ({
    settings: { ...defaultSettings },
    settingsLoaded: false,

    loadSettings: async () => {
        try {
            const localSettings = await idbGet('nn_settings');
            if (localSettings && localSettings.settings) {
                const raw = localSettings as any;

                // Decrypt providers (new two-tier) and legacy inline-config presets (if still present).
                const providersPlain = await decryptSettingsProviders(raw.settings?.providers ?? []);
                const presetsPlain = await decryptSettingsPresets(raw.settings?.presets ?? []);

                const migrated = migrateSettings({
                    settings: {
                        ...(raw.settings || {}),
                        providers: providersPlain,
                        presets: presetsPlain,
                    },
                });

                set({
                    settings: migrated,
                    settingsLoaded: true,
                } as Partial<SettingsSlice>);
                applyTheme(migrated.theme ?? 'light');
                applyUIScale(migrated.uiScale ?? 1.0);
                applyBetaUi(migrated.betaUi ?? false);
                applyLocale(migrated.locale ?? 'en');
                return;
            }

            const res = await fetch(`${API}/settings`);
            if (res.ok) {
                const data = await res.json();
                const migrated = migrateSettings(data);
                set({
                    settings: migrated,
                    settingsLoaded: true,
                } as Partial<SettingsSlice>);
                applyTheme(migrated.theme ?? 'light');
                applyUIScale(migrated.uiScale ?? 1.0);
                applyBetaUi(migrated.betaUi ?? false);
                applyLocale(migrated.locale ?? 'en');
                debouncedSaveSettings(migrated, null);
                return;
            }
        } catch (e) {
            console.warn('Failed to load settings, using defaults', e);
            toast.warning('Could not load saved settings — using defaults');
        }
        // No stored settings: state is still `defaultSettings`, whose locale was
        // seeded from the browser. Project it so the document matches the state.
        applyLocale(get().settings?.locale ?? 'en');
        set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
        let previousTier: AiTier | undefined;
        set((s) => {
            previousTier = s.settings?.aiTier;
            const newSettings = { ...s.settings, ...patch };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            if (patch.theme) {
                applyTheme(patch.theme);
            }
            if (patch.uiScale !== undefined) {
                applyUIScale(patch.uiScale);
            }
            if (patch.betaUi !== undefined) {
                applyBetaUi(patch.betaUi);
            }
            if (patch.locale) {
                applyLocale(patch.locale);
            }
            return { settings: newSettings };
        });
        // Phase 3.2 / `EVENTS.md` §6.8 — the single funnel every settings write
        // passes through. **Key names only** (§3): `AppSettings.providers`
        // carries `EndpointConfig` records with API keys in them, and a payload
        // of "the new settings" would hand every native mod the user's
        // credentials through a channel `CONTRACT.md`'s permanent prohibition
        // closes everywhere else.
        emitCoreEvent('settings.changed', { changedKeys: Object.keys(patch) });
        // `aiTier` is the one setting a mod can read (`ctx.config.aiTier`) and
        // the one that gates what a mod may do, so it gets its own event rather
        // than making every tier-aware mod string-match inside `changedKeys` on
        // every unrelated settings write. Both fire, `changed` first — the one
        // deliberate overlap in the taxonomy.
        if ('aiTier' in patch && patch.aiTier !== previousTier) {
            emitCoreEvent('settings.tierChanged', { tier: patch.aiTier, previous: previousTier });
        }
    },

    addPreset: (preset) => {
        set((s) => {
            const newSettings = {
                ...s.settings,
                presets: [...s.settings.presets, preset],
            };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    updatePreset: (id, patch) => {
        set((s) => {
            const newPresets = s.settings.presets.map((p) =>
                p.id === id ? { ...p, ...patch } : p
            );
            const newSettings = { ...s.settings, presets: newPresets };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    removePreset: (id) => {
        set((s) => {
            const newPresets = s.settings.presets.filter((p) => p.id !== id);
            if (newPresets.length === 0) {
                toast.error('Cannot remove the last preset');
                return {};
            }
            const newActiveId = s.settings.activePresetId === id
                ? newPresets[0].id
                : s.settings.activePresetId;
            const newSettings = { ...s.settings, presets: newPresets, activePresetId: newActiveId };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    setActivePreset: (id) => {
        let name = '';
        set((s) => {
            name = s.settings.presets.find((p) => p.id === id)?.name ?? '';
            const newSettings = { ...s.settings, activePresetId: id };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
        // Phase 3.2 / `EVENTS.md` §6.8 — ST's `PRESET_CHANGED`. Carries the id
        // and the display name and **never the preset body**, which holds
        // provider ids that resolve to credential-bearing `EndpointConfig`
        // records (§3).
        emitCoreEvent('settings.presetChanged', { presetId: id, name });
    },

    getActivePreset: () => {
        const s = get();
        return s.settings.presets.find((p) => p.id === s.settings.activePresetId) || s.settings.presets[0];
    },

    getActiveStoryEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset) return undefined;
        return applySlotThinking(s.settings.providers.find(p => p.id === preset.storyAIProviderId), preset, 'story');
    },

    getActiveImageEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.imageAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.imageAIProviderId);
    },

    getActiveSummarizerEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.summarizerAIProviderId) return undefined;
        return applySlotThinking(s.settings.providers.find(p => p.id === preset.summarizerAIProviderId), preset, 'summarizer');
    },

    getActiveUtilityEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.utilityAIProviderId) return undefined;
        return applySlotThinking(s.settings.providers.find(p => p.id === preset.utilityAIProviderId), preset, 'utility');
    },

    getActiveAuxiliaryEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.auxiliaryAIProviderId) return undefined;
        return applySlotThinking(s.settings.providers.find(p => p.id === preset.auxiliaryAIProviderId), preset, 'auxiliary');
    },

    getActiveVisionEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.visionAIProviderId) return undefined;
        return applySlotThinking(s.settings.providers.find(p => p.id === preset.visionAIProviderId), preset, 'vision');
    },

    addProvider: (provider) => {
        set((s) => {
            const newSettings = {
                ...s.settings,
                providers: [...s.settings.providers, provider],
            };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    updateProvider: (id, patch) => {
        set((s) => {
            const newProviders = s.settings.providers.map((p) =>
                p.id === id ? { ...p, ...patch } : p
            );
            const newSettings = { ...s.settings, providers: newProviders };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    removeProvider: (id) => {
        set((s) => {
            if (s.settings.providers.length <= 1) return {};
            const newProviders = s.settings.providers.filter(p => p.id !== id);
            const firstProviderId = newProviders[0].id;
            const newPresets = s.settings.presets.map(preset => {
                const updated = { ...preset };
                if (updated.storyAIProviderId === id) {
                    updated.storyAIProviderId = firstProviderId;
                }
                if (updated.summarizerAIProviderId === id) {
                    updated.summarizerAIProviderId = '';
                }
                if (updated.utilityAIProviderId === id) {
                    updated.utilityAIProviderId = '';
                }
                if (updated.auxiliaryAIProviderId === id) {
                    updated.auxiliaryAIProviderId = '';
                }
                if (updated.imageAIProviderId === id) {
                    updated.imageAIProviderId = '';
                }
                if (updated.visionAIProviderId === id) {
                    updated.visionAIProviderId = '';
                }
                return updated;
            });
            const newSettings = { ...s.settings, providers: newProviders, presets: newPresets };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },
});
