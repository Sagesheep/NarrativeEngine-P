import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings, GameContext, ChatMessage, CondenserState } from '../types';

type AppState = {
    // Settings
    settings: AppSettings;
    updateSettings: (patch: Partial<AppSettings>) => void;

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

export const useAppStore = create<AppState>()(
    persist(
        (set) => ({
            // Settings defaults
            settings: {
                endpoint: 'http://localhost:11434/v1',
                apiKey: '',
                modelName: 'llama3',
                contextLimit: 4096,
                autoCondenseEnabled: true,
            },
            updateSettings: (patch) =>
                set((s) => ({ settings: { ...s.settings, ...patch } })),

            // Context defaults
            context: {
                loreRaw: '',
                rulesRaw: '',
                saveFormat1: '',
                saveFormat2: '',
                saveInstruction: '',
                saveStateMacro: '[SYSTEM: Please summarize the current inventory, HP, and quest status into a JSON block for saving.]',
                canonState: '',
                headerIndex: '',
                starter: '',
                continuePrompt: '',
                saveFormat1Active: false,
                saveFormat2Active: false,
                saveInstructionActive: false,
                saveStateMacroActive: true,
                canonStateActive: false,
                headerIndexActive: false,
                starterActive: false,
                continuePromptActive: false,
            },
            updateContext: (patch) =>
                set((s) => ({ context: { ...s.context, ...patch } })),

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
        }),
        {
            name: 'gm-cockpit-store',
            partialize: (state) => ({
                settings: state.settings,
                context: state.context,
                messages: state.messages,
                condenser: state.condenser,
            }),
        }
    )
);
