import type { StateCreator } from 'zustand';
import type { AppSettings, ProviderConfig, AIPreset, EndpointConfig } from '../../types';
import { get as idbGet, set as idbSet } from 'idb-keyval';
import { encryptSettingsPresets, decryptSettingsPresets } from '../../services/settingsCrypto';
import { uid } from '../../utils/uid';
import { toast } from '../../components/Toast';

const API = '/api';

// ── DEFAULT constants ──────────────────────────────────────────────────

export const DEFAULT_SURPRISE_TYPES = [
    "WEATHER_SHIFT", "ODD_SOUND", "NPC_QUIRK", "EQUIPMENT_HICCUP",
    "SCENERY_CHANGE", "ANIMAL_BEHAVIOR", "RUMOR_OVERHEARD",
    "STRANGE_SENSATION", "MINOR_MISHAP", "UNEXPECTED_KINDNESS"
];

export const DEFAULT_SURPRISE_TONES = [
    "CURIOUS", "UNSETTLING", "AMUSING", "EERIE",
    "MUNDANE", "WHOLESOME", "OMINOUS", "BIZARRE"
];

export const DEFAULT_ENCOUNTER_TYPES = [
    "AMBUSH", "RIVAL_APPEARANCE", "RESOURCE_CRISIS", "MORAL_DILEMMA",
    "UNEXPECTED_ALLY", "TRAP_TRIGGERED", "FACTION_CONFRONTATION",
    "BOUNTY_HUNTER", "SUPPLY_SHORTAGE", "BETRAYAL_HINT"
];

export const DEFAULT_ENCOUNTER_TONES = [
    "TENSE", "DESPERATE", "MYSTERIOUS", "AGGRESSIVE",
    "CHAOTIC", "CALCULATED", "GROTESQUE", "EPIC"
];

export const DEFAULT_WORLD_WHO = [
    "a major faction/organization", "a rogue splinter group", "a powerful leader/executive",
    "a dangerous anomaly", "a fanatic cult/extremist group", "a prominent conglomerate/merchant guild",
    "a desperate individual", "a completely random nobody", "an ancient/forgotten entity", "a chaotic force of nature"
];

export const DEFAULT_WORLD_WHERE = [
    "in a neighboring city/sector", "across the nearest border", "deep underground/in the lower levels",
    "in a remote outpost/village", "in the capital/central hub", "in a forgotten ruin/abandoned zone",
    "along a main trade/travel route", "in an uncharted area", "in a highly secure/restricted area", "in the wilderness/wasteland"
];

export const DEFAULT_WORLD_WHY = [
    "to seize power/control", "for brutal vengeance", "to protect a dangerous secret",
    "driven by a radical ideology/prophecy", "for untold wealth/resources", "due to an escalating misunderstanding",
    "out of pure desperation", "because someone dumb got lucky and found a legendary asset", "acting on an old grudge", "to reclaim lost glory/territory"
];

export const DEFAULT_WORLD_WHAT = [
    "declared open hostilities/war", "formed an unexpected alliance", "destroyed an important landmark/facility",
    "discovered a game-changing asset/relic", "assassinated/eliminated a key figure", "triggered a massive disaster",
    "monopolized a critical resource", "initiated a complete blockade/lockdown", "caused a mass exodus/evacuation", "staged a violent coup/takeover"
];

// ── Internal helpers ───────────────────────────────────────────────────

export const defaultPreset: AIPreset = {
    id: uid(),
    name: 'Default Setting',
    storyAI: {
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        modelName: 'llama3',
    },
    imageAI: { endpoint: '', apiKey: '', modelName: '' },
    summarizerAI: {
        endpoint: 'http://localhost:11434/v1',
        apiKey: '',
        modelName: 'llama3',
    },
    utilityAI: { endpoint: '', apiKey: '', modelName: '' }
};

export const defaultSettings: AppSettings = {
    presets: [defaultPreset],
    activePresetId: defaultPreset.id,
    contextLimit: 4096,
    autoCondenseEnabled: true,
    debugMode: false,
    theme: 'light',
    showReasoning: true,
};

export function applyTheme(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
}

/** Migrate old single-provider/multi-provider settings to presets format */
export function migrateSettings(data: Record<string, unknown>): AppSettings {
    const raw = (data.settings || {}) as Record<string, unknown>;

    // Already migrated -- has presets array
    if (Array.isArray(raw.presets) && raw.presets.length > 0) {
        return {
            presets: raw.presets as AIPreset[],
            activePresetId: (raw.activePresetId as string) || (raw.presets as AIPreset[])[0].id,
            contextLimit: (raw.contextLimit as number) ?? 4096,
            autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
            debugMode: (raw.debugMode as boolean) ?? false,
            theme: (raw.theme as 'light' | 'dark') ?? 'light',
            showReasoning: (raw.showReasoning as boolean) ?? true,
        };
    }

    // Migration from old provider structure
    let migratedStoryProvider: EndpointConfig = { ...defaultPreset.storyAI };

    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
        const oldActive = (raw.providers as ProviderConfig[]).find(p => p.id === raw.activeProviderId) || (raw.providers as ProviderConfig[])[0];
        migratedStoryProvider = {
            endpoint: oldActive.endpoint || defaultPreset.storyAI.endpoint,
            apiKey: oldActive.apiKey || '',
            modelName: oldActive.modelName || defaultPreset.storyAI.modelName
        };
    } else {
        migratedStoryProvider = {
            endpoint: (raw.endpoint as string) || defaultPreset.storyAI.endpoint,
            apiKey: (raw.apiKey as string) || '',
            modelName: (raw.modelName as string) || defaultPreset.storyAI.modelName
        };
    }

    const legacyId = uid();
    const migratedPreset: AIPreset = {
        id: legacyId,
        name: 'Default Preset',
        storyAI: migratedStoryProvider,
        imageAI: {
            endpoint: (raw.imageApiEndpoint as string) || '',
            apiKey: (raw.imageApiKey as string) || '',
            modelName: (raw.imageApiModel as string) || '',
        },
        summarizerAI: { ...migratedStoryProvider },
        utilityAI: { endpoint: '', apiKey: '', modelName: '' }
    };

    return {
        presets: [migratedPreset],
        activePresetId: legacyId,
        contextLimit: (raw.contextLimit as number) ?? 4096,
        autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
        debugMode: (raw.debugMode as boolean) ?? false,
        theme: (raw.theme as 'light' | 'dark') ?? 'light',
        showReasoning: (raw.showReasoning as boolean) ?? true,
    };
}

// Debounced save to avoid hammering the API on rapid changes
let saveTimer: ReturnType<typeof setTimeout> | null = null;
export function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
        const encryptedPresets = await encryptSettingsPresets(settings.presets);
        const encryptedSettings = { ...settings, presets: encryptedPresets };

        idbSet('nn_settings', { settings: encryptedSettings, activeCampaignId })
            .catch((e) => { console.error(e); toast.error('Failed to save settings to browser storage'); });

        fetch(`${API}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings, activeCampaignId }),
        }).catch((e) => { console.error(e); toast.warning('Settings saved locally but server backup failed'); });
    }, 500);
}

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
    getActiveStoryEndpoint: () => EndpointConfig | undefined;
    getActiveImageEndpoint: () => EndpointConfig | undefined;
    getActiveSummarizerEndpoint: () => EndpointConfig | undefined;
    getActiveUtilityEndpoint: () => EndpointConfig | undefined;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createSettingsSlice: StateCreator<SettingsSlice & { activeCampaignId: string | null }, [], [], SettingsSlice> = (set, get) => ({
    settings: { ...defaultSettings },
    settingsLoaded: false,

    loadSettings: async () => {
        try {
            const localSettings = await idbGet('nn_settings');
            if (localSettings && localSettings.settings) {
                const migrated = migrateSettings(localSettings);
                const decryptedPresets = await decryptSettingsPresets(migrated.presets);
                const decrypted = { ...migrated, presets: decryptedPresets };
                set({
                    settings: decrypted,
                    settingsLoaded: true,
                } as Partial<SettingsSlice>);
                applyTheme(decrypted.theme ?? 'light');
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
                debouncedSaveSettings(migrated, null);
                return;
            }
        } catch (e) {
            console.warn('Failed to load settings, using defaults', e);
            toast.warning('Could not load saved settings — using defaults');
        }
        set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
        set((s) => {
            const newSettings = { ...s.settings, ...patch };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            if (patch.theme) {
                applyTheme(patch.theme);
            }
            return { settings: newSettings };
        });
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
            if (newPresets.length === 0) return {};
            const newActiveId = s.settings.activePresetId === id
                ? newPresets[0].id
                : s.settings.activePresetId;
            const newSettings = { ...s.settings, presets: newPresets, activePresetId: newActiveId };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    setActivePreset: (id) => {
        set((s) => {
            const newSettings = { ...s.settings, activePresetId: id };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    getActivePreset: () => {
        const s = get();
        return s.settings.presets.find((p) => p.id === s.settings.activePresetId) || s.settings.presets[0];
    },

    getActiveStoryEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.storyAI;
    },

    getActiveImageEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.imageAI;
    },

    getActiveSummarizerEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.summarizerAI;
    },

    getActiveUtilityEndpoint: () => {
        const preset = get().getActivePreset();
        return preset?.utilityAI;
    },
});
