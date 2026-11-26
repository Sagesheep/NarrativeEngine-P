import type { StateCreator } from 'zustand';
import type { WorldMap, MapPin } from '../../types';
import { generateWorldMap, loadWorld } from '../../services/mapEngine/worldOrchestrator';

export type MapSlice = {
    overworldMap: WorldMap | null;
    isMapOpen: boolean;
    isMapLoading: boolean;
    playerPosition: { x: number; y: number };
    isPinMode: boolean;
    pendingPin: { x: number; y: number } | null;

    toggleMap: () => void;
    openMap: () => void;
    closeMap: () => void;
    setOverworldMap: (map: WorldMap | null) => void;
    setMapLoading: (loading: boolean) => void;
    setPlayerPosition: (pos: { x: number; y: number }) => void;
    generateMap: (campaignId: string, lore: string, llmConfig: { endpoint: string; apiKey: string; model: string }) => Promise<void>;
    loadMap: (campaignId: string) => Promise<void>;
    togglePinMode: () => void;
    setPendingPin: (pos: { x: number; y: number } | null) => void;
    saveMap: (campaignId: string) => Promise<void>;
    addPin: (campaignId: string, pin: MapPin) => Promise<void>;
    deletePin: (campaignId: string, id: string) => Promise<void>;
};

type MapDeps = MapSlice;

export const createMapSlice: StateCreator<MapDeps, [], [], MapSlice> = (set, _get) => ({
    overworldMap: null,
    isMapOpen: false,
    isMapLoading: false,
    playerPosition: { x: 50, y: 50 },
    isPinMode: false,
    pendingPin: null,

    toggleMap: () => set((s) => ({ isMapOpen: !s.isMapOpen })),
    openMap: () => set({ isMapOpen: true }),
    closeMap: () => set({ isMapOpen: false }),
    setOverworldMap: (map) => set((s) => {
        const pos = map
            ? (s.overworldMap === null ? { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) } : s.playerPosition)
            : s.playerPosition;
        return { overworldMap: map, playerPosition: pos };
    }),
    setMapLoading: (loading) => set({ isMapLoading: loading }),
    setPlayerPosition: (pos) => set({ playerPosition: pos }),

    generateMap: async (campaignId, lore, llmConfig) => {
        set({ isMapLoading: true });
        try {
            const map = await generateWorldMap(campaignId, lore, llmConfig);
            set({
                overworldMap: map,
                playerPosition: { x: Math.floor(map.width / 2), y: Math.floor(map.height / 2) },
                isMapLoading: false,
            });
        } catch (err) {
            console.error('[MapSlice] Generate failed:', err);
            set({ isMapLoading: false });
            throw err;
        }
    },

    loadMap: async (campaignId) => {
        set({ isMapLoading: true });
        try {
            const map = await loadWorld(campaignId);
            const normalized = map ? { ...map, pins: map.pins ?? [] } : null;
            set({
                overworldMap: normalized,
                playerPosition: normalized
                    ? { x: Math.floor(normalized.width / 2), y: Math.floor(normalized.height / 2) }
                    : { x: 50, y: 50 },
                isMapLoading: false,
            });
        } catch (err) {
            console.error('[MapSlice] Load failed:', err);
            set({ isMapLoading: false });
        }
    },

    togglePinMode: () => set((s) => ({ isPinMode: !s.isPinMode, pendingPin: null })),
    setPendingPin: (pos) => set({ pendingPin: pos }),

    saveMap: async (campaignId) => {
        const map = _get().overworldMap;
        if (!map) return;
        await fetch(`/api/campaigns/${campaignId}/overworld`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(map),
        });
    },

    addPin: async (campaignId, pin) => {
        set((s) => {
            if (!s.overworldMap) return {};
            return {
                overworldMap: { ...s.overworldMap, pins: [...(s.overworldMap.pins ?? []), pin] },
                isPinMode: false,
                pendingPin: null,
            };
        });
        await _get().saveMap(campaignId);
    },

    deletePin: async (campaignId, id) => {
        set((s) => {
            if (!s.overworldMap) return {};
            return {
                overworldMap: { ...s.overworldMap, pins: s.overworldMap.pins.filter((p) => p.id !== id) },
            };
        });
        await _get().saveMap(campaignId);
    },
});