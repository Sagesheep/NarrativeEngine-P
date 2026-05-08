import type { StateCreator } from 'zustand';
import type { PayloadTrace, PipelinePhase, StreamingStats, LoreCheckResult, LoreCheckSelection } from '../../types';

// ── Slice type ─────────────────────────────────────────────────────────

export type UISlice = {
    settingsOpen: boolean;
    drawerOpen: boolean;
    npcLedgerOpen: boolean;
    backupModalOpen: boolean;
    lastPayloadTrace?: PayloadTrace[];
    pipelinePhase: PipelinePhase;
    streamingStats: StreamingStats | null;
    loreCheckOpen: boolean;
    loreCheckStatus: string;
    loreCheckError: string;
    loreCheckResult: LoreCheckResult | null;
    loreCheckSelection: LoreCheckSelection | null;
    toggleSettings: () => void;
    toggleDrawer: () => void;
    toggleNPCLedger: () => void;
    toggleBackupModal: () => void;
    setLastPayloadTrace: (trace?: PayloadTrace[]) => void;
    setPipelinePhase: (phase: PipelinePhase) => void;
    setStreamingStats: (stats: StreamingStats | null) => void;
    setLoreCheckStatus: (status: string) => void;
    setLoreCheckResult: (result: LoreCheckResult | null) => void;
    setLoreCheckError: (error: string) => void;
    openLoreCheck: (selection: LoreCheckSelection) => void;
    closeLoreCheck: () => void;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
    settingsOpen: false,
    drawerOpen: true,
    npcLedgerOpen: false,
    backupModalOpen: false,
    pipelinePhase: 'idle',
    streamingStats: null,
    loreCheckOpen: false,
    loreCheckStatus: '',
    loreCheckError: '',
    loreCheckResult: null,
    loreCheckSelection: null,
    toggleSettings: () => set((s) => ({ settingsOpen: !s.settingsOpen })),
    toggleDrawer: () => set((s) => ({ drawerOpen: !s.drawerOpen })),
    toggleNPCLedger: () => set((s) => ({ npcLedgerOpen: !s.npcLedgerOpen })),
    toggleBackupModal: () => set((s) => ({ backupModalOpen: !s.backupModalOpen })),
    setLastPayloadTrace: (trace) => set({ lastPayloadTrace: trace }),
    setPipelinePhase: (phase) => set({ pipelinePhase: phase }),
    setStreamingStats: (stats) => set({ streamingStats: stats }),
    setLoreCheckStatus: (status) => set({ loreCheckStatus: status }),
    setLoreCheckResult: (result) => set({ loreCheckResult: result }),
    setLoreCheckError: (error) => set({ loreCheckError: error }),
    openLoreCheck: (selection) => set({ loreCheckOpen: true, loreCheckSelection: selection, loreCheckResult: null, loreCheckError: '', loreCheckStatus: '' }),
    closeLoreCheck: () => set({ loreCheckOpen: false, loreCheckSelection: null, loreCheckResult: null, loreCheckError: '', loreCheckStatus: '' }),
});
