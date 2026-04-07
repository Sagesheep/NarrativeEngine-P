import type { StateCreator } from 'zustand';
import type { PayloadTrace } from '../../types';

// ── Slice type ─────────────────────────────────────────────────────────

export type UISlice = {
    settingsOpen: boolean;
    drawerOpen: boolean;
    npcLedgerOpen: boolean;
    backupModalOpen: boolean;
    lastPayloadTrace?: PayloadTrace[];
    toggleSettings: () => void;
    toggleDrawer: () => void;
    toggleNPCLedger: () => void;
    toggleBackupModal: () => void;
    setLastPayloadTrace: (trace?: PayloadTrace[]) => void;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
    settingsOpen: false,
    drawerOpen: true,
    npcLedgerOpen: false,
    backupModalOpen: false,
    toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
    toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
    toggleNPCLedger: () => set((s) => ({ npcLedgerOpen: !s.npcLedgerOpen })),
    toggleBackupModal: () => set((s) => ({ backupModalOpen: !s.backupModalOpen })),
    setLastPayloadTrace: (trace) => set({ lastPayloadTrace: trace }),
});
