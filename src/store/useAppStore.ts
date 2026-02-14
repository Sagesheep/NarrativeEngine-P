import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { AppSettings, GameContext, ChatMessage } from '../types';

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
                saveFormat1Active: false,
                saveFormat2Active: false,
                saveInstructionActive: false,
                saveStateMacroActive: true,
            },
            updateContext: (patch) =>
                set((s) => ({ context: { ...s.context, ...patch } })),

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
            }),
        }
    )
);
