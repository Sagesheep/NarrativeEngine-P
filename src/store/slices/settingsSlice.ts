import type { StateCreator } from 'zustand';
import type { AiTier, AppSettings, LLMProvider, AIPreset } from '../../types';
import { emitCoreEvent } from '../../services/mods/events';
import { get as idbGet } from 'idb-keyval';
import { decryptSettingsProviders, decryptSettingsPresets } from '../../services/infrastructure/settingsCrypto';
import { toast } from '../../components/Toast';
import { api } from '../../services/llm/apiClient';

import { API_BASE as API } from '../../lib/apiBase';

import {
    migrateSettings,
    applyTheme,
    applyUIScale,
    applyLocale,
    debouncedSaveSettings,
    defaultSettings,
} from './settingsHelpers';

// Re-export the public helper surface so external importers keep working untouched.
export {
    DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHY, DEFAULT_WORLD_WHAT,
    defaultProvider, defaultPreset, defaultSettings,
    applyTheme, systemTheme, applyUIScale, applyLocale, migrateSettings, debouncedSaveSettings,
} from './settingsHelpers';

// ── Slice type ─────────────────────────────────────────────────────────

export type SettingsSlice = {
    settings: AppSettings;
    settingsLoaded: boolean;
    updateSettings: (patch: Partial<AppSettings>) => void;
    loadSettings: () => Promise<void>;

    // Vault state
    vaultStatus: { exists: boolean; unlocked: boolean; hasRemember: boolean } | null;
    vaultLoading: boolean;
    checkVaultStatus: () => Promise<void>;
    setupVault: (password: string | null, remember: boolean) => Promise<boolean>;
    unlockVault: (password: string, remember: boolean) => Promise<boolean>;
    unlockVaultWithRemembered: () => Promise<boolean>;
    lockVault: () => Promise<void>;
    saveVaultKeys: () => Promise<void>;
    exportVault: (password: string) => Promise<Blob>;
    importVault: (file: string, password: string, merge: boolean) => Promise<void>;

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
        return s.settings.providers.find(p => p.id === preset.storyAIProviderId);
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
        return s.settings.providers.find(p => p.id === preset.summarizerAIProviderId);
    },

    getActiveUtilityEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.utilityAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.utilityAIProviderId);
    },

    getActiveAuxiliaryEndpoint: () => {
        const s = get();
        const preset = s.getActivePreset();
        if (!preset || !preset.auxiliaryAIProviderId) return undefined;
        return s.settings.providers.find(p => p.id === preset.auxiliaryAIProviderId);
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
                return updated;
            });
            const newSettings = { ...s.settings, providers: newProviders, presets: newPresets };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    // ── Vault methods ──────────────────────────────────────────────────────

    vaultStatus: null,
    vaultLoading: false,

    checkVaultStatus: async () => {
        try {
            const status = await api.vault.status();
            set({ vaultStatus: status });
        } catch (e) {
            console.error('[Vault] Failed to check status:', e);
            set({ vaultStatus: { exists: false, unlocked: false, hasRemember: false } });
        }
    },

    setupVault: async (password, remember) => {
        set({ vaultLoading: true });
        try {
            const presets = get().settings.presets;
            const providers = get().settings.providers;
            await api.vault.setup(password, presets, providers);
            set({ vaultStatus: { exists: true, unlocked: true, hasRemember: remember } });
            toast.success(password ? 'Secure vault created' : 'Machine-only vault created');
            return true;
        } catch (e) {
            console.error('[Vault] Setup failed:', e);
            toast.error('Failed to create vault');
            return false;
        } finally {
            set({ vaultLoading: false });
        }
    },

    unlockVault: async (password, remember) => {
        set({ vaultLoading: true });
        try {
            await api.vault.unlock(password, remember);
            const data = await api.vault.getKeys();
            // Merge vault presets and providers into settings
            set((s) => ({
                settings: {
                    ...s.settings,
                    ...(data.presets && data.presets.length > 0 ? { presets: data.presets } : {}),
                    ...(data.providers && data.providers.length > 0 ? { providers: data.providers } : {}),
                }
            }));
            set({ vaultStatus: { exists: true, unlocked: true, hasRemember: remember } });
            toast.success('Vault unlocked');
            return true;
        } catch (e) {
            console.error('[Vault] Unlock failed:', e);
            return false;
        } finally {
            set({ vaultLoading: false });
        }
    },

    unlockVaultWithRemembered: async () => {
        set({ vaultLoading: true });
        try {
            await api.vault.unlockWithRemembered();
            const data = await api.vault.getKeys();
            set((s) => ({
                settings: {
                    ...s.settings,
                    ...(data.presets && data.presets.length > 0 ? { presets: data.presets } : {}),
                    ...(data.providers && data.providers.length > 0 ? { providers: data.providers } : {}),
                }
            }));
            set({ vaultStatus: { exists: true, unlocked: true, hasRemember: true } });
            return true;
        } catch (e) {
            console.error('[Vault] Remembered unlock failed:', e);
            set({ vaultStatus: { exists: true, unlocked: false, hasRemember: false } });
            return false;
        } finally {
            set({ vaultLoading: false });
        }
    },

    lockVault: async () => {
        try {
            await api.vault.lock();
            set({ vaultStatus: { exists: true, unlocked: false, hasRemember: false } });
            toast.success('Vault locked');
        } catch (e) {
            console.error('[Vault] Lock failed:', e);
        }
    },

    saveVaultKeys: async () => {
        try {
            const presets = get().settings.presets;
            const providers = get().settings.providers;
            await api.vault.saveKeys({ presets, providers });
        } catch (e) {
            console.error('[Vault] Save failed:', e);
            toast.error('Failed to save keys to vault');
        }
    },

    exportVault: async (password) => {
        try {
            const blob = await api.vault.export(password);
            return blob;
        } catch (e) {
            console.error('[Vault] Export failed:', e);
            throw e;
        }
    },

    importVault: async (file, password, merge) => {
        try {
            await api.vault.import(file, password, merge);
            const data = await api.vault.getKeys();
            set((s) => ({
                settings: {
                    ...s.settings,
                    ...(data.presets && data.presets.length > 0 ? { presets: data.presets } : {}),
                    ...(data.providers && data.providers.length > 0 ? { providers: data.providers } : {}),
                }
            }));
            toast.success('Vault imported successfully');
        } catch (e) {
            console.error('[Vault] Import failed:', e);
            toast.error('Failed to import vault - wrong password?');
            throw e;
        }
    },
});
