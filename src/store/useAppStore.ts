import { create } from 'zustand';

import { createSettingsSlice, type SettingsSlice } from './slices/settingsSlice';
import { createCampaignSlice, type CampaignSlice } from './slices/campaignSlice';
import { createChatSlice, type ChatSlice } from './slices/chatSlice';
import { createUISlice, type UISlice } from './slices/uiSlice';
import { createMapSlice, type MapSlice } from './slices/mapSlice';
import { createWorldLoreSlice, type WorldLoreSlice } from './slices/worldLoreSlice';

// Re-export DEFAULT_* constants for backward compatibility
export {
    DEFAULT_SURPRISE_TYPES,
    DEFAULT_SURPRISE_TONES,
    DEFAULT_ENCOUNTER_TYPES,
    DEFAULT_ENCOUNTER_TONES,
    DEFAULT_WORLD_WHO,
    DEFAULT_WORLD_WHERE,
    DEFAULT_WORLD_WHY,
    DEFAULT_WORLD_WHAT,
} from './slices/settingsSlice';

// ── Combined store type ────────────────────────────────────────────────

type AppState = SettingsSlice & CampaignSlice & ChatSlice & UISlice & MapSlice & WorldLoreSlice;

// ── Store ──────────────────────────────────────────────────────────────

export const useAppStore = create<AppState>()((...a) => ({
    ...createSettingsSlice(...a),
    ...createCampaignSlice(...a),
    ...createChatSlice(...a),
    ...createUISlice(...a),
    ...createMapSlice(...a),
    ...createWorldLoreSlice(...a),
}));
