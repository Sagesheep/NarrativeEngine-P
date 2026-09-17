import type { StateCreator } from 'zustand';
import type { WorldLoreDraft, WorldLoreItem } from '../../types';
import { uid } from '../../utils/uid';

const STORAGE_KEY = 'nn_world_lore_drafts';

function loadDrafts(): WorldLoreDraft[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        return raw ? JSON.parse(raw) : [];
    } catch {
        return [];
    }
}

function persistDrafts(drafts: WorldLoreDraft[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
    } catch (e) {
        console.error('[WorldLore] Failed to persist drafts:', e);
    }
}

const EMPTY_DRAFT: Omit<WorldLoreDraft, 'id' | 'name' | 'createdAt' | 'updatedAt'> = {
    background: '',
    languages: '',
    powerSystem: '',
    techEconomy: '',
    timeline: '',
    toneBoundaries: '',
    houseRules: '',
    locations: [],
    cultures: [],
    factions: [],
    threats: [],
    npcs: [],
    characterCreationQuestions: '',
};

export type WorldLoreSlice = {
    worldLoreDrafts: WorldLoreDraft[];
    worldLoreActiveDraftId: string | null;
    worldLoreModalOpen: boolean;

    createDraft: (name?: string) => string;
    importWorldDraft: (draft: WorldLoreDraft) => void;
    deleteDraft: (id: string) => void;
    updateDraftField: <K extends keyof WorldLoreDraft>(id: string, field: K, value: WorldLoreDraft[K]) => void;
    addItem: (id: string, listKey: 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs', item?: WorldLoreItem) => void;
    updateItem: (id: string, listKey: 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs', itemId: string, patch: Partial<WorldLoreItem>) => void;
    removeItem: (id: string, listKey: 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs', itemId: string) => void;
    setActiveDraft: (id: string | null) => void;
    toggleWorldLoreModal: () => void;
    loadWorldLoreDrafts: () => void;
};

export const createWorldLoreSlice: StateCreator<WorldLoreSlice, [], [], WorldLoreSlice> = (set, get) => ({
    worldLoreDrafts: [],
    worldLoreActiveDraftId: null,
    worldLoreModalOpen: false,

    createDraft: (name?: string) => {
        const now = Date.now();
        const draft: WorldLoreDraft = {
            id: uid(),
            name: name || `World ${get().worldLoreDrafts.length + 1}`,
            ...EMPTY_DRAFT,
            createdAt: now,
            updatedAt: now,
        };
        set((s) => {
            const drafts = [...s.worldLoreDrafts, draft];
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts, worldLoreActiveDraftId: draft.id };
        });
        return draft.id;
    },

    importWorldDraft: (draft) => {
        const copy = { ...draft, id: uid(), createdAt: Date.now(), updatedAt: Date.now() };
        const drafts = [...get().worldLoreDrafts, copy];
        // Import must not report success when the browser storage is full.
        localStorage.setItem(STORAGE_KEY, JSON.stringify(drafts));
        set({ worldLoreDrafts: drafts, worldLoreActiveDraftId: copy.id });
    },

    deleteDraft: (id) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.filter((d) => d.id !== id);
            persistDrafts(drafts);
            const activeId = s.worldLoreActiveDraftId === id ? null : s.worldLoreActiveDraftId;
            return { worldLoreDrafts: drafts, worldLoreActiveDraftId: activeId };
        });
    },

    updateDraftField: (id, field, value) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id ? { ...d, [field]: value, updatedAt: Date.now() } : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    addItem: (id, listKey, item) => {
        const newItem: WorldLoreItem = item ?? { id: uid(), title: '', body: '' };
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id ? { ...d, [listKey]: [...d[listKey], newItem], updatedAt: Date.now() } : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    updateItem: (id, listKey, itemId, patch) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id
                    ? {
                          ...d,
                          [listKey]: d[listKey].map((item) =>
                              item.id === itemId ? { ...item, ...patch } : item
                          ),
                          updatedAt: Date.now(),
                      }
                    : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    removeItem: (id, listKey, itemId) => {
        set((s) => {
            const drafts = s.worldLoreDrafts.map((d) =>
                d.id === id
                    ? { ...d, [listKey]: d[listKey].filter((item) => item.id !== itemId), updatedAt: Date.now() }
                    : d
            );
            persistDrafts(drafts);
            return { worldLoreDrafts: drafts };
        });
    },

    setActiveDraft: (id) => set({ worldLoreActiveDraftId: id }),

    toggleWorldLoreModal: () => set((s) => ({ worldLoreModalOpen: !s.worldLoreModalOpen })),

    loadWorldLoreDrafts: () => {
        const drafts = loadDrafts();
        set({ worldLoreDrafts: drafts });
    },
});