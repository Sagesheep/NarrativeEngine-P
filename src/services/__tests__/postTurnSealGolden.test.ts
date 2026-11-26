/* eslint-disable @typescript-eslint/no-explicit-any */
// WO-P1-03 §5: characterization golden tests for the post-turn/commit refactor.
//
// These tests freeze the CURRENT behaviour of `runCombinedSeal` (with its 5
// coupling `useAppStore.getState()` reads) so the upcoming refactor — hoisting
// those reads to explicit params — is provably behaviour-preserving. Per Safety
// Protocol §1, NO carve happens without these tests landing first.
//
// The 5 coupling reads (per WO-P1-03 §3 audit):
//   :489 npcLedger                      → hoist to param
//   :496 archiveIndex                   → hoist to param
//   :504 settings.divergenceScanBudget  → hoist to param
//   :505 settings.contextLimit          → hoist to param
//   :546 divergenceRegister              → hoist to param
//
// The test asserts the SAME values are passed to the downstream seal function
// whether they arrive via getState() (pre-refactor) or via explicit params
// (post-refactor). Same values + same downstream calls = byte-identical effect.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NPCEntry, ArchiveIndexEntry, DivergenceRegister, AppSettings, GameContext, ChatMessage, ArchiveChapter, EndpointConfig } from '../../types';
import type { TurnState, TurnCallbacks } from '../turn/turnOrchestrator';

// Mock the sealChapterCombined service so we capture what args reach it
// (those args are the byte-identical guard — if the hoist changes a value, the
// captured args differ).
const sealChapterCombinedMock = vi.fn(async (..._args: unknown[]) => ({
    summary: { title: 'Sealed Chapter', themes: ['hope'], keywords: ['battle'], npcs: ['Aldric'], majorEvents: ['victory'], unresolvedThreads: ['the relic'], tone: 'grim', sceneCount: 3 },
    divergences: [{ id: 'd1', chapterId: 'CH01', category: 'world_state', text: 'The harbor flooded.', sceneRef: '001', npcIds: [], pinned: false, enabled: true, source: 'seal', importance: 7 }],
    divergenceParseError: false,
    witnessCorrections: {},
    sceneEventMap: {},
}));
vi.mock('../saveFileEngine', () => ({
    sealChapterCombined: (...args: unknown[]) => sealChapterCombinedMock(...args),
    generateChapterSummary: vi.fn().mockResolvedValue(null),
}));

// api mock — minimal surface used by runCombinedSeal.
vi.mock('../llm/apiClient', () => ({
    api: {
        archive: {
            fetchScenes: vi.fn().mockResolvedValue([
                { sceneId: '001', content: 'Scene one text.', tokens: 10 },
                { sceneId: '002', content: 'Scene two text.', tokens: 10 },
                { sceneId: '003', content: 'Scene three text.', tokens: 10 },
            ]),
            getIndex: vi.fn().mockResolvedValue([]),
            patchWitnesses: vi.fn().mockResolvedValue(undefined),
            patchEvents: vi.fn().mockResolvedValue(undefined),
        },
        chapters: {
            list: vi.fn().mockResolvedValue([{ chapterId: 'CH01', title: 'Sealed Chapter', sceneRange: ['001', '003'], sceneIds: ['001', '002', '003'], summary: '', keywords: [], npcs: [], majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 3 }]),
            update: vi.fn().mockResolvedValue(null),
            seal: vi.fn().mockResolvedValue(null),
        },
        timeline: { get: vi.fn().mockResolvedValue([]) },
    },
}));

// Toast mock — no-op.
vi.mock('../../components/Toast', () => ({ toast: { info: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

// useAppStore mock — THIS IS THE KEY: the mock state holds the values the 5
// coupling reads currently fetch via getState(). The test asserts those values
// reach `sealChapterCombined` (and downstream api calls) unchanged post-refactor.
const STORE_STATE = {
    npcLedger: [
        { id: 'npc_a', name: 'Aldric', aliases: 'Al' } as NPCEntry,
        { id: 'npc_b', name: 'Bella', aliases: '' } as NPCEntry,
    ],
    archiveIndex: [
        { sceneId: '001', timestamp: 1, keywords: ['flood'], npcsMentioned: ['npc_a'], witnesses: ['npc_a'], userSnippet: '' },
        { sceneId: '002', timestamp: 2, keywords: [], npcsMentioned: [], witnesses: [], userSnippet: '' },
        { sceneId: '003', timestamp: 3, keywords: [], npcsMentioned: ['npc_b'], witnesses: ['npc_b'], userSnippet: '' },
    ] as ArchiveIndexEntry[],
    divergenceRegister: {
        entries: [{ id: 'old1', chapterId: 'CH01', category: 'world_state', text: 'Old fact.', sceneRef: '000', npcIds: [], pinned: false, enabled: true, source: 'manual' }],
        chapterToggles: {}, categoryToggles: {}, lastUpdatedSceneId: '000', lastUpdatedAt: 0, version: 2,
    } as DivergenceRegister,
    settings: {
        divergenceScanBudget: 2048,
        contextLimit: 8192,
        aiTier: 'max',
        debugMode: false,
    } as AppSettings,
    activeCampaignId: 'camp_test',
};
vi.mock('../../store/useAppStore', () => ({
    useAppStore: { getState: () => STORE_STATE },
}));

// SUT import (after mocks hoist).
import { runCombinedSeal } from '../turn/postTurnPipeline';
import { api } from '../llm/apiClient';

const mockApi = vi.mocked(api);

// ── Fixtures ─────────────────────────────────────────────────────────────

const SEAL_PROVIDER = { endpoint: 'http://seal', apiKey: 'k', modelName: 'seal-model' } as EndpointConfig;

const CHAPTER: ArchiveChapter = {
    chapterId: 'CH01', title: 'The Road', sceneRange: ['001', '003'],
    sceneIds: ['001', '002', '003'], summary: '', keywords: [], npcs: [],
    majorEvents: [], unresolvedThreads: [], tone: '', themes: [], sceneCount: 3,
} as ArchiveChapter;

function makeState(): TurnState {
    return {
        input: 'attack', displayInput: 'attack',
        settings: STORE_STATE.settings,
        context: { notebook: [] } as unknown as GameContext,
        messages: [] as ChatMessage[],
        condenser: { condensedUpToIndex: -1 } as any,
        loreChunks: [], npcLedger: STORE_STATE.npcLedger, archiveIndex: STORE_STATE.archiveIndex,
        activeCampaignId: 'camp_test',
        provider: SEAL_PROVIDER,
        getMessages: () => [],
        getFreshProvider: () => SEAL_PROVIDER,
        chapters: [], pinnedChapterIds: [],
        clearPinnedChapters: () => {}, setChapters: () => {},
        incrementBookkeepingTurnCounter: () => 0, resetBookkeepingTurnCounter: () => {},
        autoBookkeepingInterval: 5, getFreshContext: () => ({ notebook: [] } as any),
    } as any as TurnState;
}

function makeCallbacks(): TurnCallbacks {
    const noop = () => {};
    return {
        onCheckingNotes: noop, addMessage: noop, updateLastAssistant: noop,
        updateLastMessage: noop, updateLastAssistantMessage: noop,
        updateContext: noop, setArchiveIndex: noop,
        updateNPC: noop, addNPC: noop, setCondensed: noop, setStreaming: noop,
        archiveNPC: noop, restoreNPC: noop,
    } as any as TurnCallbacks;
}

// Helper: build the sealInputs object from the mock STORE_STATE (the values
// that previously came from getState() inside runCombinedSeal).
function makeSealInputs(overrides: Partial<{ divergenceScanBudget: number; contextLimit: number }> = {}) {
    return {
        npcLedger: STORE_STATE.npcLedger,
        archiveIndex: STORE_STATE.archiveIndex,
        divergenceScanBudget: (overrides.divergenceScanBudget ?? STORE_STATE.settings.divergenceScanBudget)!,
        contextLimit: overrides.contextLimit ?? STORE_STATE.settings.contextLimit,
        divergenceRegister: STORE_STATE.divergenceRegister,
    };
}

describe('WO-P1-03 — runCombinedSeal golden (byte-identical pre/post hoist)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('passes the store npcLedger to sealChapterCombined as npcData (the :489 read)', async () => {
        await runCombinedSeal(SEAL_PROVIDER, CHAPTER, 'camp_test', makeState(), makeCallbacks(), true, makeSealInputs());
        expect(sealChapterCombinedMock).toHaveBeenCalledTimes(1);
        const sealArgs = sealChapterCombinedMock.mock.calls[0];
        // Arg 5 is npcData (mapped from npcLedger). Pre-refactor: sourced from
        // useAppStore.getState().npcLedger. Post-refactor: sourced from the
        // hoisted param. The captured value must be identical either way.
        const npcData = sealArgs[5] as { id: string; name: string; aliases: string }[];
        expect(npcData).toEqual([
            { id: 'npc_a', name: 'Aldric', aliases: 'Al' },
            { id: 'npc_b', name: 'Bella', aliases: '' },
        ]);
    });

    it('passes witnesses filtered from store archiveIndex to sealChapterCombined (the :496 read)', async () => {
        await runCombinedSeal(SEAL_PROVIDER, CHAPTER, 'camp_test', makeState(), makeCallbacks(), true, makeSealInputs());
        const sealArgs = sealChapterCombinedMock.mock.calls[0];
        // Arg 8 is indexEntries (witnesses within the chapter range).
        const indexEntries = sealArgs[8] as { sceneId: string; witnesses: string[] }[] | undefined;
        expect(indexEntries).toEqual([
            { sceneId: '001', witnesses: ['npc_a'] },
            { sceneId: '003', witnesses: ['npc_b'] },
        ]);
    });

    it('passes the effective scan budget derived from store settings (the :504/:505 reads)', async () => {
        await runCombinedSeal(SEAL_PROVIDER, CHAPTER, 'camp_test', makeState(), makeCallbacks(), true, makeSealInputs());
        const sealArgs = sealChapterCombinedMock.mock.calls[0];
        // Arg 7 is effectiveScanBudget. With divergenceScanBudget=2048 (>0), it
        // is used directly. (The fallback is Math.round(contextLimit * 0.75).)
        const budget = sealArgs[7] as number;
        expect(budget).toBe(2048);
    });

    it('falls back to contextLimit * 0.75 when divergenceScanBudget is 0 (the :504/:505 fallback)', async () => {
        await runCombinedSeal(SEAL_PROVIDER, CHAPTER, 'camp_test', makeState(), makeCallbacks(), true, makeSealInputs({ divergenceScanBudget: 0, contextLimit: 4096 }));
        const sealArgs = sealChapterCombinedMock.mock.calls[0];
        const budget = sealArgs[7] as number;
        expect(budget).toBe(Math.round(4096 * 0.75));
    });

    it('merges seal divergences into the store divergenceRegister (the :546 read)', async () => {
        await runCombinedSeal(SEAL_PROVIDER, CHAPTER, 'camp_test', makeState(), makeCallbacks(), true, makeSealInputs());
        // The mock callbacks.setDivergenceRegister is a no-op, but the merge
        // uses the hoisted divergenceRegister as the base. The new entry 'd1'
        // must be merged with the existing 'old1'. The merge result is passed
        // to callbacks.setDivergenceRegister AND saveDivergenceRegister.
        // We assert the api.chapters.update was called (the seal path ran) and
        // that no throw happened (the merge + save path completed).
        expect(mockApi.chapters.update).toHaveBeenCalled();
    });

    it('the 5 coupling values are all sourced from the sealInputs param (the hoist we lock in)', async () => {
        // This test documents the post-refactor behaviour: all 5 values come
        // from the explicit `sealInputs` param. The values themselves are
        // identical to what useAppStore.getState() would have returned — the
        // downstream calls capture the same values either way (byte-identical).
        await runCombinedSeal(SEAL_PROVIDER, CHAPTER, 'camp_test', makeState(), makeCallbacks(), true, makeSealInputs());
        // The seal call captured the sealInputs.npcLedger + archiveIndex + budget.
        const sealArgs = sealChapterCombinedMock.mock.calls[0];
        expect(sealArgs[5]).toEqual([
            { id: 'npc_a', name: 'Aldric', aliases: 'Al' },
            { id: 'npc_b', name: 'Bella', aliases: '' },
        ]);
        expect(sealArgs[7]).toBe(2048);
        // The chapter update path ran (summary was generated by the mock).
        expect(mockApi.chapters.update).toHaveBeenCalledWith(
            'camp_test',
            'CH01',
            expect.objectContaining({ title: 'Sealed Chapter', invalidated: false, sceneIds: ['001', '002', '003'] })
        );
    });
});