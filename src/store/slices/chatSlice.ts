import type { StateCreator } from 'zustand';
import type { ArchiveIndexEntry, ChatMessage, CondenserState, GameContext, DivergenceRegister, DivergenceEntry, PrunedEntry } from '../../types';
import { safeSceneNum } from '../../utils/helpers';

const MAX_PRUNED_LOG = 100;

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

    divergenceRegister: DivergenceRegister;
    setDivergenceRegister: (register: DivergenceRegister) => void;
    editDivergenceEntry: (id: string, patch: Partial<DivergenceEntry>) => void;
    updateMessageDivergence: (messageId: string, divergenceIds: string[]) => void;
    resetDivergenceRegister: () => void;
    confirmReviewEntry: (id: string) => void;
    deleteReviewedEntry: (id: string) => void;
    restorePrunedEntry: (prunedIndex: number) => void;
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
            // Guard: never overwrite a real summary with empty string
            const safeSummary = summary || s.condenser.condensedSummary;
            const newCondenser = { ...s.condenser, condensedSummary: safeSummary, condensedUpToIndex: upToIndex };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    // isCondensing is ephemeral — intentionally not persisted. App.tsx hydration resets it to false on load.
    setCondensing: (v) =>
        set((s) => ({ condenser: { ...s.condenser, isCondensing: v } })),
    resetCondenser: () =>
        set(() => {
            const newCondenser = { condensedSummary: '', condensedUpToIndex: -1, isCondensing: false };
            debouncedSaveCampaignState();
            return { condenser: newCondenser };
        }),
    setCondenser: (state) =>
        set((_s) => {
            debouncedSaveCampaignState();
            return { condenser: state };
        }),

    divergenceRegister: { entries: [], prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 },
    setDivergenceRegister: (register) =>
        set((_s) => {
            debouncedSaveCampaignState();
            return { divergenceRegister: register };
        }),
    editDivergenceEntry: (id, patch) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e => {
                if (e.id !== id) return e;
                const updated = { ...e, ...patch };
                const fieldsChanged = patch.category !== undefined || patch.subject !== undefined || patch.divergence !== undefined || patch.sceneRef !== undefined;
                if (fieldsChanged && updated.parseError) updated.parseError = false;
                return updated;
            });
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    updateMessageDivergence: (messageId, divergenceIds) =>
        set((s) => {
            const msgs = s.messages.map(m =>
                m.id === messageId ? { ...m, divergenceIds } : m
            );
            return { messages: msgs };
        }),
    resetDivergenceRegister: () =>
        set(() => {
            const newDivReg: DivergenceRegister = { entries: [], prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 };
            debouncedSaveCampaignState();
            return { divergenceRegister: newDivReg };
        }),
    confirmReviewEntry: (id) =>
        set((s) => {
            const entries = s.divergenceRegister.entries.map(e =>
                e.id === id ? { ...e, reviewFlag: false } : e
            );
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, lastUpdatedAt: Date.now() } };
        }),
    deleteReviewedEntry: (id) =>
        set((s) => {
            const entry = s.divergenceRegister.entries.find(e => e.id === id);
            if (!entry) return {};
            const entries = s.divergenceRegister.entries.filter(e => e.id !== id);
            const newPruned: PrunedEntry = {
                originalEntry: entry,
                prunedAt: Date.now(),
                chapterId: '',
                verdict: 'user_deleted_review',
                reason: 'User manually deleted after review',
            };
            const prunedLog = [...(s.divergenceRegister.prunedLog ?? []), newPruned].slice(-MAX_PRUNED_LOG);
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, prunedLog, lastUpdatedAt: Date.now() } };
        }),
    restorePrunedEntry: (prunedIndex) =>
        set((s) => {
            const prunedLog = s.divergenceRegister.prunedLog ?? [];
            if (prunedIndex < 0 || prunedIndex >= prunedLog.length) return {};
            const restored = prunedLog[prunedIndex];
            const entry: DivergenceEntry = { ...restored.originalEntry, reviewFlag: false };
            const newLog = prunedLog.filter((_, i) => i !== prunedIndex);
            const entries = [...s.divergenceRegister.entries, entry];
            entries.sort((a, b) => safeSceneNum(a.sceneRef) - safeSceneNum(b.sceneRef));
            debouncedSaveCampaignState();
            return { divergenceRegister: { ...s.divergenceRegister, entries, prunedLog: newLog, lastUpdatedAt: Date.now() } };
        }),

    // Chat defaults
    messages: [],
    isStreaming: false,
    addMessage: (msg) =>
        set((s) => ({ messages: [...s.messages, msg] })),
    updateLastAssistant: (content) =>
        set((s) => {
            const msgs = [...s.messages];
            for (let i = msgs.length - 1; i >= 0; i--) {
                if (msgs[i].role === 'assistant') {
                    msgs[i] = { ...msgs[i], content };
                    return { messages: msgs };
                }
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
        const newDivReg = { entries: [], prunedLog: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 1 };
        debouncedSaveCampaignState();
        return { messages: [], condenser: newCondenser, divergenceRegister: newDivReg, context: { ..._s.context, notebook: [] } } as Partial<ChatDeps>;
    }),
    clearArchive: () => set({ archiveIndex: [] } as Partial<ChatDeps>),
});
