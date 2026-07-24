/* eslint-disable @typescript-eslint/no-explicit-any */
// Absolute Command v1 — orchestrator stage tests (WO §7 invariants 4 & 5).
//
// Asserts the contract in `turnStages.ts`:
//   - invariant 5: on `max` tier with an absolute command armed,
//     `runDirectorBrief` is called ZERO times. The gate at the top of
//     `runDirectorStage` returns before the tier-gated Director call.
//   - invariant 4 (corollary): `buildWatchdogDossier` is NOT invoked when
//     the command is armed (the gate returns before the dossier computation).
//     This leaves `ctx.watchdogNudge` undefined so `buildPayload` emits no
//     [STAGE NOTE] block (also asserted in the payload test file).
//
// Mocks heavy collaborators so the test reaches the gate without any real
// I/O. The real `aiTier.tierAllows` is used — the gate's behavior is the SUT.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings, GameContext, ChatMessage, NPCEntry, CondenserState, ArchiveIndexEntry, ArchiveChapter, DivergenceRegister, EndpointConfig } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';

// ── Mocks (hoisted by vitest) ────────────────────────────────────────────────

const runDirectorBriefMock = vi.fn(async () => null as string | null);
const lastAssistantContentMock = vi.fn(() => 'LAST_GM_TEXT');
vi.mock('../directorBrief', () => ({
    runDirectorBrief: (...args: unknown[]) => runDirectorBriefMock(...args),
    lastAssistantContent: (...args: unknown[]) => lastAssistantContentMock(...args),
    clearDirectorBriefCache: vi.fn(),
}));

const buildWatchdogDossierMock = vi.fn(() => ({ signals: [], dossierText: '', nudgeText: null }));
vi.mock('../directorWatchdog', () => ({
    buildWatchdogDossier: (...args: unknown[]) => buildWatchdogDossierMock(...args),
}));

vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: vi.fn(),
}));

vi.mock('../contextGatherer', () => ({
    gatherContext: vi.fn(async () => ({
        archiveRecall: undefined,
        recommendedNPCNames: undefined,
        timelineEvents: [],
        relevantLore: undefined,
        inventoryCategories: undefined,
        profileFields: undefined,
        deepContextSummary: undefined,
        semanticFactText: undefined,
        relevantRules: undefined,
        rulesManifest: undefined,
    })),
}));

const buildPayloadMock = vi.fn(() => ({
    messages: [{ role: 'user', content: 'hello' }],
    trace: [],
    debugSections: [],
}));
const sendMessageMock = vi.fn();
vi.mock('../../chatEngine', () => ({
    buildPayload: (...args: unknown[]) => buildPayloadMock(...args),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

vi.mock('../../lib/payloadSanitizer', () => ({
    sanitizePayloadForApi: (p: unknown) => p,
}));
vi.mock('../../components/Toast', () => ({
    toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
vi.mock('../sceneStakesTag', () => ({
    extractAndStripSceneStakes: (text: string) => ({ displayText: text, stakes: 'calm' as const }),
}));
vi.mock('../toolHandlers', () => ({
    getToolDefinitions: vi.fn(() => []),
}));
vi.mock('../toolRegistry', () => ({
    resolveToolHandler: vi.fn(() => null),
}));
vi.mock('../../engine/engineRolls', () => ({
    rollEngines: vi.fn(() => ({ appendToInput: '', updatedDCs: {} })),
    rollDiceFairness: vi.fn(() => ''),
    resolveManualRoll: vi.fn(() => ({
        rolls: [10], detail: '1d20', tier: 'Regular', faceValue: '10',
    })),
}));
vi.mock('../../engine/lootEngine', () => ({
    resolveLootDrop: vi.fn(() => ({ appendToInput: '' })),
}));
vi.mock('../../oneshot/oneShotEvents', () => ({
    buildOneShotDirective: vi.fn(() => null),
}));

vi.mock('../../../store/useAppStore', () => ({
    useAppStore: {
        getState: () => ({
            locationLedger: [],
            getActiveAuxiliaryEndpoint: () => undefined,
            getActiveStoryEndpoint: () => ({ endpoint: 'http://test', modelName: 'story' } as any),
        }),
    },
}));

// ── SUT import (after mocks are hoisted) ─────────────────────────────────────
import { runTurn } from '../turnOrchestrator';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseSettings(aiTier: 'lite' | 'pro' | 'max'): AppSettings {
    return {
        aiTier,
        contextLimit: 8192,
        debugMode: false,
        matureMode: false,
        rulesBudgetPct: 10,
    } as any as AppSettings;
}

function baseContext(): GameContext {
    return {
        npcIntroEngineActive: false,
        surpriseEngineActive: false,
        encounterEngineActive: false,
        worldEngineActive: false,
        diceFairnessActive: false,
        notebookActive: false,
        inventoryActive: false,
        characterProfileActive: false,
        canonStateActive: false,
        headerIndexActive: false,
        starterActive: false,
        continuePromptActive: false,
        sceneNoteActive: false,
        diceSystem: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 },
        surpriseConfig: { initialDC: 95, dcReduction: 3, types: [], tones: [] },
        encounterConfig: { initialDC: 198, dcReduction: 2, types: [], tones: [] },
        worldEventConfig: { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] },
        notebook: [],
    } as any as GameContext;
}

function baseState(aiTier: 'lite' | 'pro' | 'max', absoluteCommand: string | null): TurnState {
    return {
        input: 'I look around.',
        displayInput: 'I look around.',
        settings: baseSettings(aiTier),
        context: baseContext(),
        messages: [] as ChatMessage[],
        condenser: { condensedUpToIndex: -1 } as any as CondenserState,
        loreChunks: [],
        npcLedger: [] as NPCEntry[],
        archiveIndex: [] as ArchiveIndexEntry[],
        activeCampaignId: 'camp_test',
        provider: { endpoint: 'http://test', modelName: 'story' } as any as EndpointConfig,
        getMessages: () => [] as ChatMessage[],
        getFreshProvider: () => ({ endpoint: 'http://test', modelName: 'story' } as any),
        getUtilityEndpoint: () => undefined,
        getFreshAuxiliaryProvider: () => undefined,
        onStageNpcIds: [],
        timeline: [],
        chapters: [] as ArchiveChapter[],
        pinnedChapterIds: [],
        clearPinnedChapters: () => {},
        setChapters: () => {},
        incrementBookkeepingTurnCounter: () => 0,
        resetBookkeepingTurnCounter: () => {},
        autoBookkeepingInterval: 5,
        getFreshContext: () => baseContext(),
        sampling: undefined,
        deepSearchThisTurn: false,
        divergenceRegister: undefined as DivergenceRegister | undefined,
        armedRoll: null,
        armedLoot: null,
        armedOneShot: null,
        absoluteCommand,
        nextTurnOocBrief: undefined,
    } as any as TurnState;
}

function baseCallbacks(): TurnCallbacks {
    const noop = () => {};
    return {
        onCheckingNotes: noop, addMessage: noop, updateLastAssistant: noop,
        updateLastMessage: noop, updateLastAssistantMessage: noop,
        updateContext: noop, setArchiveIndex: noop,
        updateNPC: noop, addNPC: noop, setCondensed: noop, setStreaming: noop,
        archiveNPC: noop, restoreNPC: noop,
    } as any as TurnCallbacks;
}

function wireSendMessageToComplete(): void {
    sendMessageMock.mockImplementation(
        (_provider: unknown, _messages: unknown, _onChunk: unknown, onDone: any) => {
            Promise.resolve().then(() => onDone('Final GM text.', undefined, undefined));
            return Promise.resolve();
        },
    );
}

const COMMAND = 'Elara has known him for years — stop writing her as hostile.';

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Absolute Command v1 — runDirectorStage gate (WO §7 invariants 4 & 5)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wireSendMessageToComplete();
    });

    it('invariant 5: max tier with absoluteCommand armed invokes runDirectorBrief ZERO times', async () => {
        await runTurn(baseState('max', COMMAND), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(0);
    });

    it('invariant 4: max tier with absoluteCommand armed does NOT call buildWatchdogDossier', async () => {
        await runTurn(baseState('max', COMMAND), baseCallbacks(), new AbortController());
        expect(buildWatchdogDossierMock).toHaveBeenCalledTimes(0);
    });

    it('pro tier with absoluteCommand armed invokes runDirectorBrief ZERO times', async () => {
        await runTurn(baseState('pro', COMMAND), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(0);
    });

    it('lite tier with absoluteCommand armed invokes runDirectorBrief ZERO times (lite has no Director anyway)', async () => {
        await runTurn(baseState('lite', COMMAND), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(0);
    });

    it('without absoluteCommand, max tier invokes runDirectorBrief exactly once (control — proves the gate is the cause)', async () => {
        await runTurn(baseState('max', null), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(1);
    });

    it('without absoluteCommand, max tier calls buildWatchdogDossier once (control)', async () => {
        await runTurn(baseState('max', null), baseCallbacks(), new AbortController());
        expect(buildWatchdogDossierMock).toHaveBeenCalledTimes(1);
    });

    it('without absoluteCommand, pro tier invokes runDirectorBrief exactly once (control)', async () => {
        await runTurn(baseState('pro', null), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(1);
    });

    it('without absoluteCommand, lite tier invokes runDirectorBrief ZERO times (control — tier gate)', async () => {
        await runTurn(baseState('lite', null), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(0);
    });

    it('with absoluteCommand armed, buildPayload receives absoluteCommand in its options', async () => {
        await runTurn(baseState('max', COMMAND), baseCallbacks(), new AbortController());
        expect(buildPayloadMock).toHaveBeenCalledTimes(1);
        const opts = buildPayloadMock.mock.calls[0][0] as Record<string, unknown>;
        expect(opts.absoluteCommand).toBe(COMMAND);
    });

    it('without absoluteCommand, buildPayload receives absoluteCommand as undefined', async () => {
        await runTurn(baseState('max', null), baseCallbacks(), new AbortController());
        const opts = buildPayloadMock.mock.calls[0][0] as Record<string, unknown>;
        expect(opts.absoluteCommand).toBeUndefined();
    });
});