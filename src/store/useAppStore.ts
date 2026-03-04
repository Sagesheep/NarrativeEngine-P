import { create } from 'zustand';
import type { AppSettings, GameContext, ChatMessage, CondenserState, LoreChunk, ProviderConfig, NPCEntry, ArchiveChunk } from '../types';

const API = '/api';

export const DEFAULT_SURPRISE_TYPES = [
    "ENVIRONMENTAL_HAZARD", "NPC_ACTION", "BEAST_BEHAVIOR",
    "SYSTEM_FAILURE", "SUDDEN_WEATHER", "MAGIC_SURGE"
];

export const DEFAULT_SURPRISE_TONES = [
    "MYSTERIOUS", "CHAOTIC", "GROTESQUE", "WHOLESOME", "EPIC", "MUNDANE"
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
    updateLoreChunk: (id: string, patch: Partial<LoreChunk>) => void;
    archiveChunks: ArchiveChunk[];
    setArchiveChunks: (chunks: ArchiveChunk[]) => void;
    npcLedger: NPCEntry[];
    setNPCLedger: (npcs: NPCEntry[]) => void;
    addNPC: (npc: NPCEntry) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    removeNPC: (id: string) => void;

    // Context
    context: GameContext;
    updateContext: (patch: Partial<GameContext>) => void;

    // Chat
    messages: ChatMessage[];
    isStreaming: boolean;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateMessageContent: (id: string, content: string) => void;
    deleteMessage: (id: string) => void;
    deleteMessagesFrom: (id: string) => void;
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
    npcLedgerOpen: boolean;
    toggleSettings: () => void;
    toggleDrawer: () => void;
    toggleNPCLedger: () => void;
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

// Debounced save for NPC Ledger
let npcTimer: ReturnType<typeof setTimeout> | null = null;
function debouncedSaveNPCLedger(campaignId: string | null, npcs: NPCEntry[]) {
    if (!campaignId) return;
    if (npcTimer) clearTimeout(npcTimer);
    npcTimer = setTimeout(() => {
        fetch(`${API}/campaigns/${campaignId}/npcs`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(npcs),
        }).catch(console.error);
    }, 1000);
}

/**
 * Deduplicates the NPC ledger by name comparison:
 *   Rule 1: Exact full-name match → keep the newer (later in array) entry
 *   Rule 2: First-name-only entry matches a full-name entry → keep the fuller/newer entry
 *   Rule 3: Same first name but different last names → do NOT touch
 */
function dedupeNPCLedger(ledger: NPCEntry[]): NPCEntry[] {
    const removeIndices = new Set<number>();

    for (let i = 0; i < ledger.length; i++) {
        if (removeIndices.has(i)) continue;

        const nameI = ledger[i].name.trim().toLowerCase();
        const partsI = nameI.split(/\s+/);
        const firstI = partsI[0];
        const hasLastI = partsI.length > 1;

        for (let j = i + 1; j < ledger.length; j++) {
            if (removeIndices.has(j)) continue;

            const nameJ = ledger[j].name.trim().toLowerCase();
            const partsJ = nameJ.split(/\s+/);
            const firstJ = partsJ[0];
            const hasLastJ = partsJ.length > 1;

            // Rule 1: Exact full name match → remove the older (i)
            if (nameI === nameJ) {
                console.log(`[NPC Dedup] Exact match: "${ledger[i].name}" == "${ledger[j].name}" → removing older entry`);
                removeIndices.add(i);
                break;
            }

            // Rule 2: First-name-only entry matches a first+last entry
            // e.g. "Ash" (i) vs "Ash Ketchum" (j) → remove the first-name-only (i)
            if (!hasLastI && hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[i].name}" ⊂ "${ledger[j].name}" → removing shorter entry`);
                removeIndices.add(i);
                break;
            }
            // e.g. "Ash Ketchum" (i) vs "Ash" (j) → remove the first-name-only (j)
            if (hasLastI && !hasLastJ && firstI === firstJ) {
                console.log(`[NPC Dedup] Partial match: "${ledger[j].name}" ⊂ "${ledger[i].name}" → removing shorter entry`);
                removeIndices.add(j);
                continue;
            }

            // Rule 3: Same first name, different last names → do NOT touch
        }
    }

    if (removeIndices.size > 0) {
        console.log(`[NPC Dedup] Removed ${removeIndices.size} duplicate(s) from ledger`);
    }

    return ledger.filter((_, idx) => !removeIndices.has(idx));
}

const defaultSettings: AppSettings = {
    providers: [defaultProvider],
    activeProviderId: defaultProvider.id,
    contextLimit: 4096,
    autoCondenseEnabled: true,
    debugMode: false,
    theme: 'light',
};

function applyTheme(theme: 'light' | 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
}

const defaultContext: GameContext = {
    loreRaw: '',
    rulesRaw: '',
    canonState: '',
    headerIndex: '',
    starter: '',
    continuePrompt: '',
    inventory: '',
    characterProfile: '',
    surpriseDC: 95,
    worldEventDC: 198,
    canonStateActive: false,
    headerIndexActive: false,
    starterActive: false,
    continuePromptActive: false,
    inventoryActive: false,
    characterProfileActive: false,
    surpriseEngineActive: true,
    worldEngineActive: true,
    diceFairnessActive: true,
    diceConfig: {
        catastrophe: 2,
        failure: 6,
        success: 15,
        triumph: 19,
        crit: 20
    },
    surpriseConfig: {
        initialDC: 98,
        dcReduction: 3,
        types: [...DEFAULT_SURPRISE_TYPES],
        tones: [...DEFAULT_SURPRISE_TONES],
    },
    worldEventConfig: {
        initialDC: 198,
        dcReduction: 3,
        who: [...DEFAULT_WORLD_WHO],
        where: [...DEFAULT_WORLD_WHERE],
        why: [...DEFAULT_WORLD_WHY],
        what: [...DEFAULT_WORLD_WHAT],
    },
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
            debugMode: (raw.debugMode as boolean) ?? false,
            theme: (raw.theme as 'light' | 'dark') ?? 'light',
            imageApiEndpoint: (raw.imageApiEndpoint as string) || '',
            imageApiKey: (raw.imageApiKey as string) || '',
            imageApiModel: (raw.imageApiModel as string) || '',
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
        debugMode: (raw.debugMode as boolean) ?? false,
        theme: (raw.theme as 'light' | 'dark') ?? 'light',
        imageApiEndpoint: (raw.imageApiEndpoint as string) || '',
        imageApiKey: (raw.imageApiKey as string) || '',
        imageApiModel: (raw.imageApiModel as string) || '',
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
                // Apply persisted theme
                applyTheme(migrated.theme ?? 'light');
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
            // Apply theme to DOM immediately when it changes
            if (patch.theme) {
                applyTheme(patch.theme);
            }
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
    updateLoreChunk: (id, patch) => set((s) => {
        const newChunks = s.loreChunks.map(c => c.id === id ? { ...c, ...patch } : c);
        if (s.activeCampaignId) {
            import('../store/campaignStore').then(mod => mod.saveLoreChunks(s.activeCampaignId!, newChunks));
        }
        return { loreChunks: newChunks };
    }),
    archiveChunks: [],
    setArchiveChunks: (chunks) => set({ archiveChunks: chunks }),
    npcLedger: [],
    setNPCLedger: (npcs) => set({ npcLedger: npcs }),
    addNPC: (npc) => set((s) => {
        const withNew = [...s.npcLedger, npc];
        const deduped = dedupeNPCLedger(withNew);
        debouncedSaveNPCLedger(s.activeCampaignId, deduped);
        return { npcLedger: deduped };
    }),
    updateNPC: (id, patch) => set((s) => {
        const newLedger = s.npcLedger.map(n => n.id === id ? { ...n, ...patch } : n);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),
    removeNPC: (id) => set((s) => {
        const newLedger = s.npcLedger.filter(n => n.id !== id);
        debouncedSaveNPCLedger(s.activeCampaignId, newLedger);
        return { npcLedger: newLedger };
    }),

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
    updateLastMessage: (patch) =>
        set((s) => {
            const msgs = [...s.messages];
            const lastIdx = msgs.length - 1;
            if (lastIdx >= 0) {
                msgs[lastIdx] = { ...msgs[lastIdx], ...patch };
            }
            return { messages: msgs };
        }),
    updateMessageContent: (id, content) =>
        set((s) => {
            const msgs = s.messages.map(m => m.id === id ? { ...m, content } : m);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
            return { messages: msgs };
        }),
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState(s.activeCampaignId, { context: s.context, messages: msgs, condenser: s.condenser });
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v }),
    clearChat: () => set({ messages: [] }),

    // UI defaults
    settingsOpen: false,
    drawerOpen: true,
    npcLedgerOpen: false,
    toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
    toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
    toggleNPCLedger: () => set((s) => ({ npcLedgerOpen: !s.npcLedgerOpen })),
}));
