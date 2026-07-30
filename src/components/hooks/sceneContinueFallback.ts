import type { TurnState } from '../../services/turn/turnOrchestrator';
import { useAppStore } from '../../store/useAppStore';

/**
 * Scene Continue fallback path (§6) — builds a fresh TurnState from the live store
 * WITHOUT store mutation. Mirrors the shape of `rebuildStateFromLiveStore` in
 * pendingCommit.ts (which is private and not exported), with these overrides:
 *
 *  - `clearPinnedChapters: () => {}` — no-op is mandatory. gatherContext →
 *    injectPinnedChapters consumes pins; a continue must never spend pins the user
 *    set up for their next real turn.
 *  - `deepSearchThisTurn: false`.
 *
 * This lives in its own module (rather than being exported from pendingCommit.ts)
 * because the workorder explicitly says "do not export/reuse the private function
 * unless trivially exportable" — and the fallback here needs a different
 * clearPinnedChapters behaviour than the launch-reconciliation path.
 */
export function rebuildStateFromLiveStoreLike(
    store: ReturnType<typeof useAppStore.getState>,
    overrides: {
        clearPinnedChapters: () => void;
        deepSearchThisTurn?: boolean;
    },
): TurnState {
    return {
        input: '',
        displayInput: '',
        settings: store.settings,
        context: store.context,
        messages: store.messages,
        condenser: store.condenser,
        loreChunks: store.loreChunks,
        npcLedger: store.npcLedger,
        archiveIndex: store.archiveIndex,
        activeCampaignId: store.activeCampaignId,
        provider: store.getActiveStoryEndpoint(),
        getMessages: () => useAppStore.getState().messages,
        getFreshProvider: () => store.getActiveStoryEndpoint(),
        getUtilityEndpoint: () => store.getActiveUtilityEndpoint(),
        getFreshAuxiliaryProvider: () => {
            const aux = store.getActiveAuxiliaryEndpoint?.();
            return aux?.modelName ? aux : store.getActiveStoryEndpoint();
        },
        getRawAuxiliaryProvider: () => store.getActiveAuxiliaryEndpoint(),
        getRawSummariserProvider: () => store.getActiveSummarizerEndpoint(),
        chapters: store.chapters ?? [],
        pinnedChapterIds: useAppStore.getState().pinnedChapterIds,
        clearPinnedChapters: overrides.clearPinnedChapters,
        setChapters: (chapters) => useAppStore.getState().setChapters(chapters),
        incrementBookkeepingTurnCounter: () => useAppStore.getState().incrementBookkeepingTurnCounter(),
        resetBookkeepingTurnCounter: () => useAppStore.getState().resetBookkeepingTurnCounter(),
        autoBookkeepingInterval: useAppStore.getState().autoBookkeepingInterval,
        getFreshContext: () => useAppStore.getState().context,
        timeline: store.timeline,
        divergenceRegister: store.divergenceRegister,
        onStageNpcIds: store.onStageNpcIds,
        pinnedExcerpts: store.pinnedExcerpts,
        deepSearchThisTurn: overrides.deepSearchThisTurn ?? false,
    };
}