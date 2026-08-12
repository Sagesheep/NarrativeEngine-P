import type { StateCreator } from 'zustand';
import type { PayloadTrace, PipelinePhase, StreamingStats, LoreCheckResult, LoreCheckSelection, ArmedLoot } from '../../types';
import type { OneShotEventId } from '../../services/oneshot/oneShotEvents';

export type ContextScreenId = 'sys' | 'rules-mgr' | 'world' | 'eng' | 'chpt' | 'mem';


// ── Slice type ─────────────────────────────────────────────────────────

export type UISlice = {
    settingsOpen: boolean;
    drawerOpen: boolean;
    npcLedgerOpen: boolean;
    pcPanelOpen: boolean;
    locationLedgerOpen: boolean;
    blockViewOpen: boolean;
    backupModalOpen: boolean;
    contextScreen: ContextScreenId | null;
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
    togglePCPanel: () => void;
    toggleLocationLedger: () => void;
    toggleBlockView: () => void;
    toggleBackupModal: () => void;
    openContextScreen: (screen: ContextScreenId) => void;
    closeContextScreen: () => void;
    setLastPayloadTrace: (trace?: PayloadTrace[]) => void;
    setPipelinePhase: (phase: PipelinePhase) => void;
    setStreamingStats: (stats: StreamingStats | null) => void;
    setLoreCheckStatus: (status: string) => void;
    setLoreCheckResult: (result: LoreCheckResult | null) => void;
    setLoreCheckError: (error: string) => void;
    openLoreCheck: (selection: LoreCheckSelection) => void;
    closeLoreCheck: () => void;
    divergenceEntryOpen: boolean;
    openDivergenceEntry: () => void;
    closeDivergenceEntry: () => void;
    deepArmed: boolean;
    setDeepArmed: (v: boolean) => void;
    toggleDeepArmed: () => void;
    // Player-called dice ("dice me"): the armed roll request, resolved at send time. null = not armed.
    // Accepts the new ManualRollRequest shape OR legacy '1d20'|'adv'|'disadv' string.
    armedRoll: import('../../types').ManualRollRequest | string | null;
    setArmedRoll: (mode: import('../../types').ManualRollRequest | string | null) => void;
    // Dice roll modal (3-gate configurator)
    diceRollModalOpen: boolean;
    openDiceRollModal: () => void;
    closeDiceRollModal: () => void;
    // Loot Engine WO-05: armed loot drop config, resolved at send time. Mirrors armedRoll.
    armedLoot: ArmedLoot | null;
    armLoot: (payload: ArmedLoot) => void;
    clearArmedLoot: () => void;
    lootRollModalOpen: boolean;
    openLootRollModal: () => void;
    closeLootRollModal: () => void;
    // One-Shot Event Injector v1: armed event id, appended to the next turn's
    // LLM input (after historyInput capture) and cleared by the caller. Mirrors
    // armedRoll/armedLoot — fires once, never persists in chat history.
    armedOneShot: OneShotEventId | null;
    setArmedOneShot: (id: OneShotEventId | null) => void;
    // Absolute Command v1: armed binding OOC instruction for this turn only.
    // Mirrors armedOneShot — cleared before runTurn so it fires exactly once,
    // never persists in chat history. Suppresses Director Brief, watchdog nudge,
    // and GM_REMINDER; placed last in the prompt for maximum recency.
    armedAbsoluteCommand: string | null;
    setArmedAbsoluteCommand: (text: string | null) => void;
    troubleModalOpen: boolean;
    troubleLoading: boolean;
    troubleOptions: string[];
    openTroubleModal: (options: string[]) => void;
    closeTroubleModal: () => void;
    setTroubleLoading: (v: boolean) => void;
    composerInjection: string | null;
    injectToComposer: (text: string) => void;
    consumeComposerInjection: () => void;
    pinnedMemoriesOpen: boolean;
    togglePinnedMemories: () => void;
    closePinnedMemories: () => void;
    // Inline Scene Image V1
    sceneImageModalOpen: boolean;
    sceneImageDraft: import('../../types').SceneImageDraft | null;
    openSceneImageModal: (draft: import('../../types').SceneImageDraft) => void;
    closeSceneImageModal: () => void;
    updateSceneImageDraft: (patch: Partial<import('../../types').SceneImageDraft>) => void;
    setComposingSceneImage: (v: boolean) => void;
    setGeneratingSceneImage: (v: boolean) => void;
};

// ── Slice creator ──────────────────────────────────────────────────────

export const createUISlice: StateCreator<UISlice, [], [], UISlice> = (set) => ({
    settingsOpen: false,
    drawerOpen: true,
    npcLedgerOpen: false,
    pcPanelOpen: false,
    locationLedgerOpen: false,
    blockViewOpen: false,
    backupModalOpen: false,
    contextScreen: null,
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
    togglePCPanel: () => set((s) => ({ pcPanelOpen: !s.pcPanelOpen })),
    toggleLocationLedger: () => set((s) => ({ locationLedgerOpen: !s.locationLedgerOpen })),
    toggleBlockView: () => set((s) => ({ blockViewOpen: !s.blockViewOpen })),
    toggleBackupModal: () => set((s) => ({ backupModalOpen: !s.backupModalOpen })),
    openContextScreen: (screen) => set({ contextScreen: screen }),
    closeContextScreen: () => set({ contextScreen: null }),
    setLastPayloadTrace: (trace) => set({ lastPayloadTrace: trace }),
    setPipelinePhase: (phase) => set({ pipelinePhase: phase }),
    setStreamingStats: (stats) => set({ streamingStats: stats }),
    setLoreCheckStatus: (status) => set({ loreCheckStatus: status }),
    setLoreCheckResult: (result) => set({ loreCheckResult: result }),
    setLoreCheckError: (error) => set({ loreCheckError: error }),
    openLoreCheck: (selection) => set({ loreCheckOpen: true, loreCheckSelection: selection, loreCheckResult: null, loreCheckError: '', loreCheckStatus: '' }),
    closeLoreCheck: () => set({ loreCheckOpen: false, loreCheckSelection: null, loreCheckResult: null, loreCheckError: '', loreCheckStatus: '' }),
    divergenceEntryOpen: false,
    openDivergenceEntry: () => set({ divergenceEntryOpen: true }),
    closeDivergenceEntry: () => set({ divergenceEntryOpen: false }),
    deepArmed: false,
    setDeepArmed: (v) => set({ deepArmed: v }),
    toggleDeepArmed: () => set((s) => ({ deepArmed: !s.deepArmed })),
    armedRoll: null,
    setArmedRoll: (mode) => set({ armedRoll: mode }),
    diceRollModalOpen: false,
    openDiceRollModal: () => set({ diceRollModalOpen: true }),
    closeDiceRollModal: () => set({ diceRollModalOpen: false }),
    armedLoot: null,
    armLoot: (payload) => set({ armedLoot: payload }),
    clearArmedLoot: () => set({ armedLoot: null }),
    lootRollModalOpen: false,
    openLootRollModal: () => set({ lootRollModalOpen: true }),
    closeLootRollModal: () => set({ lootRollModalOpen: false }),
    armedOneShot: null,
    setArmedOneShot: (id) => set({ armedOneShot: id }),
    armedAbsoluteCommand: null,
    setArmedAbsoluteCommand: (text) => set({ armedAbsoluteCommand: text }),
    troubleModalOpen: false,
    troubleLoading: false,
    troubleOptions: [],
    openTroubleModal: (options) => set({ troubleOptions: options, troubleModalOpen: true, troubleLoading: false }),
    closeTroubleModal: () => set({ troubleModalOpen: false, troubleOptions: [], troubleLoading: false }),
    setTroubleLoading: (v) => set({ troubleLoading: v }),
    composerInjection: null,
    injectToComposer: (text) => set({ composerInjection: text }),
    consumeComposerInjection: () => set({ composerInjection: null }),
    pinnedMemoriesOpen: false,
    togglePinnedMemories: () => set((s) => ({ pinnedMemoriesOpen: !s.pinnedMemoriesOpen })),
    closePinnedMemories: () => set({ pinnedMemoriesOpen: false }),
    sceneImageModalOpen: false,
    sceneImageDraft: null,
    openSceneImageModal: (draft) => set({ sceneImageModalOpen: true, sceneImageDraft: draft }),
    closeSceneImageModal: () => set({ sceneImageModalOpen: false, sceneImageDraft: null }),
    updateSceneImageDraft: (patch) => set((s) => ({
        sceneImageDraft: s.sceneImageDraft ? { ...s.sceneImageDraft, ...patch } : null,
    })),
    setComposingSceneImage: (v) => set((s) => ({
        sceneImageDraft: s.sceneImageDraft ? { ...s.sceneImageDraft, isComposing: v } : null,
    })),
    setGeneratingSceneImage: (v) => set((s) => ({
        sceneImageDraft: s.sceneImageDraft ? { ...s.sceneImageDraft, isGenerating: v } : null,
    })),
});
