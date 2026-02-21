import { create } from 'zustand';
import type { AppSettings, GameContext, ChatMessage, CondenserState, LoreChunk, ProviderConfig } from '../types';

const API = '/api';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

const defaultProvider: ProviderConfig = {
    id: uid(),
    label: 'Local',
    endpoint: 'http://localhost:11434/v1',
    apiKey: '',
    modelName: 'llama3',
};

type AppState = {
    // Settings
    settings: AppSettings;
    settingsLoaded: boolean;
    updateSettings: (patch: Partial<AppSettings>) => void;
    loadSettings: () => Promise<void>;

    // Providers
    addProvider: (provider: ProviderConfig) => void;
    updateProvider: (id: string, patch: Partial<ProviderConfig>) => void;
    removeProvider: (id: string) => void;
    setActiveProvider: (id: string) => void;
    getActiveProvider: () => ProviderConfig;

    // Campaign
    activeCampaignId: string | null;
    setActiveCampaign: (id: string | null) => void;
    loreChunks: LoreChunk[];
    setLoreChunks: (chunks: LoreChunk[]) => void;

    // Context
    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;

    // Chat
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    setStreaming: (v: boolean) => void;
    clearChat: () => void;

    // Condenser
    condenser: CondenserState;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    resetCondenser: () => void;

    // UI
    settingsOpen: boolean;
    drawerOpen: boolean;
    toggleSettings: () => void;
    toggleDrawer: () => void;
};

// Debounced save to avoid hammering the API on rapid changes
let saveTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveSettings(settings: AppSettings, activeCampaignId: string | null) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
        fetch(`${API}/settings`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ settings, activeCampaignId }),
        }).catch(console.error);
    }, 500);
}

// Debounced save for campaign state (context, messages, condenser)
let stateTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveCampaignState(campaignId: string | null, state: { context: GameContext; messages: ChatMessage[]; condenser: CondenserState }) {
    if (!campaignId) return;
    if (stateTimer) clearTimeout(stateTimer);
    stateTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/state`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state),
        }).catch(console.error);
    }, 1000);
}

const defaultSettings: AppSettings = {
    providers: [defaultProvider],
    activeProviderId: defaultProvider.id,
    contextLimit: 4096,
    autoCondenseEnabled: true,
};

const defaultContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    saveFormat1: '',
    saveFormat2: '',
    saveInstruction: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    surpriseDC: 95,
    saveFormat1Active: false,
    saveFormat2Active: false,
    saveInstructionActive: false,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
};

/** Migrate old single-provider settings to providers[] format */
function migrateSettings(data: Record<string, unknown>): AppSettings {
    const raw = (data.settings || {}) as Record<string, unknown>;

    // Already migrated — has providers array
    if (Array.isArray(raw.providers) && raw.providers.length > 0) {
        return {
            providers: raw.providers as ProviderConfig[],
            activeProviderId: (raw.activeProviderId as string) || (raw.providers as ProviderConfig[])[0].id,
            contextLimit: (raw.contextLimit as number) ?? 4096,
            autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
        };
    }

    // Legacy format — single endpoint/apiKey/modelName
    const legacyId = uid();
    const migratedProvider: ProviderConfig = {
        id: legacyId,
        label: 'Default',
        endpoint: (raw.endpoint as string) || defaultProvider.endpoint,
        apiKey: (raw.apiKey as string) || '',
        modelName: (raw.modelName as string) || defaultProvider.modelName,
    };

    return {
        providers: [migratedProvider],
        activeProviderId: legacyId,
        contextLimit: (raw.contextLimit as number) ?? 4096,
        autoCondenseEnabled: (raw.autoCondenseEnabled as boolean) ?? true,
    };
}

export const useAppStore = create<AppState>()((set, get) => ({
    // Settings defaults
    settings: { ...defaultSettings },
    settingsLoaded: false,

    loadSettings: async () => {
        try {
            const res = await fetch(`${API}/settings`);
            if (res.ok) {
                const data = await res.json();
                const migrated = migrateSettings(data);
                set({
                    settings: migrated,
                    activeCampaignId: data.activeCampaignId ?? null,
                    settingsLoaded: true,
                });
                // Persist migrated format
                debouncedSaveSettings(migrated, data.activeCampaignId ?? null);
                return;
            }
        } catch (e) {
            console.warn('Failed to load settings from API, using defaults', e);
        }
        set({ settingsLoaded: true });
    },

    updateSettings: (patch) => {
        set((s) => {
            const newSettings = { ...s.settings, ...patch };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    // Provider management
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
            const newProviders = s.settings.providers.filter((p) => p.id !== id);
            if (newProviders.length === 0) return {}; // Can't remove last provider
            const newActiveId = s.settings.activeProviderId === id
                ? newProviders[0].id
                : s.settings.activeProviderId;
            const newSettings = { ...s.settings, providers: newProviders, activeProviderId: newActiveId };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    setActiveProvider: (id) => {
        set((s) => {
            const newSettings = { ...s.settings, activeProviderId: id };
            debouncedSaveSettings(newSettings, s.activeCampaignId);
            return { settings: newSettings };
        });
    },

    getActiveProvider: () => {
        const s = get();
        return s.settings.providers.find((p) => p.id === s.settings.activeProviderId) || s.settings.providers[0];
    },

    // Campaign defaults
    activeCampaignId: null,
    setActiveCampaign: (id) => {
        set({ activeCampaignId: id });
        const s = get();
        debouncedSaveSettings(s.settings, id);
    },
    loreChunks: [],
    setLoreChunks: (chunks) => set({ loreChunks: chunks }),

    // Context defaults
    context: { ...defaultContext },
    updateContext: (patch) =>
        set((s) => {
            const newContext = { ...s.context, ...patch };
            debouncedSaveCampaignState(s.activeCampaignId, { context: newContext, messages: s.messages, condenser: s.condenser });
            return { context: newContext };
        }),

    // Condenser defaults
    condenser: {
        condensedSummary: '',
        condensedUpToIndex: -1,
        isCondensing: false,
    },
    setCondensed: (summary, upToIndex) =>
        set((s) => ({ condenser: { ...s.condenser, condensedSummary: summary, condensedUpToIndex: upToIndex } })),
    setCondensing: (v) =>
        set((s) => ({ condenser: { ...s.condenser, isCondensing: v } })),
    resetCondenser: () =>
        set({ condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false } }),

    // Chat defaults
    messages: [],
    isStreaming: false,
    addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
    updateLastAssistant: (content) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0 && msgs[lastIdx].role === 'assistant') {
                msgs[lastIdx] = { ...msgs[lastIdx], content };
            }
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v }),
    clearChat: () => set({ messages: [] }),

    // UI defaults
    settingsOpen: false,
    drawerOpen: true,
    toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
    toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
}));
