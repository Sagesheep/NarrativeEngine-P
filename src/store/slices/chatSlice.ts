import type { StateCreator } from 'zustand';
import type { ArchiveIndexEntry, ChatMessage, CondenserState, GameContext } from '../../types';
import { debouncedSaveCampaignState } from './campaignSlice';

// ── Slice type ─────────────────────────────────────────────────────────

export type ChatSlice = {
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
    clearArchive: () => void;

    condenser: CondenserState;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    resetCondenser: () => void;
    setCondenser: (state: CondenserState) => void;
};

// ── Cross-slice dependencies ───────────────────────────────────────────

type ChatDeps = ChatSlice & {
    activeCampaignId: string | null;
    context: GameContext;
    // archiveIndex lives in CampaignSlice but clearArchive touches it
    archiveIndex: ArchiveIndexEntry[];
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createChatSlice: StateCreator<ChatDeps, [], [], ChatSlice> = (set) => ({
    // Condenser defaults
    condenser: {
        condensedSummary: '',
        condensedUpToIndex: -1,
        isCondensing: false,
    },
    setCondensed: (summary, upToIndex) =>
        set((s) => {
            const newCondenser = { ...s.condenser, condensedSummary: summary, condensedUpToIndex: upToIndex };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    // isCondensing is ephemeral — intentionally not persisted. App.tsx hydration resets it to false on load.
    setCondensing: (v) =>
        set((s) => ({ condenser: { ...s.condenser, isCondensing: v } })),
    resetCondenser: () =>
        set({ condenser: { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false } } as Partial<ChatDeps>),
    setCondenser: (state) =>
        set((_s) => {
            debouncedSaveCampaignState();
            return { condenser: state };
        }),

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
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    deleteMessage: (id) =>
        set((s) => {
            const msgs = s.messages.filter(m => m.id !== id);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    deleteMessagesFrom: (id) =>
        set((s) => {
            const index = s.messages.findIndex(m => m.id === id);
            if (index === -1) return { messages: s.messages };
            const msgs = s.messages.slice(0, index);
            debouncedSaveCampaignState();
            return { messages: msgs };
        }),
    setStreaming: (v) => set({ isStreaming: v } as Partial<ChatDeps>),
    clearChat: () => set((_s) => {
        const newCondenser = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };
        debouncedSaveCampaignState();
        return { messages: [], condenser: newCondenser };
    }),
    // Fixed: archiveIndex belongs to CampaignSlice, so ChatDeps now includes it for valid typing.
    clearArchive: () => set({ archiveIndex: [] } as Partial<ChatDeps>),
});
