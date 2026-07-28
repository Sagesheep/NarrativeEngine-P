/* eslint-disable @typescript-eslint/no-explicit-any */
// WO-04b §7: focused `runTurn` call-site tests for the Director Brief gate.
//
// Asserts that `turnOrchestrator.ts` owns the tier gate for `runDirectorBrief`:
//   - lite tier completes the pre-payload path without invoking runDirectorBrief
//   - pro tier invokes runDirectorBrief exactly once
//   - max tier invokes runDirectorBrief exactly once
//
// The service itself is ungated (its tests cover its own contract). This file
// mocks heavy collaborators (`gatherContext`, `buildPayload`, `sendMessage`,
// `buildWatchdogDossier`, `capturePendingTurnSnapshot`, the engine rolls, the
// loot engine, the one-shot injector, `toast`, `sanitizePayloadForApi`,
// `extractAndStripSceneStakes`, tool handlers, `useAppStore`) so the test
// reaches the gate at `turnOrchestrator.ts:245` without any real I/O. The real
// `aiTier.tierAllows` is used — the gate's behavior is the SUT, not a mock.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AppSettings, GameContext, ChatMessage, NPCEntry, CondenserState, ArchiveIndexEntry, ArchiveChapter, DivergenceRegister, EndpointConfig } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';

// ── Mocks (hoisted by vitest) ────────────────────────────────────────────────

// The Director service mock — tracks invocations. The real `lastAssistantContent`
// is a pure function but we mock it too so the test never touches the real module
// (keeps the SUT's only Director dependency the gated `runDirectorBrief` call).
const runDirectorBriefMock = vi.fn(async () => null as string | null);
const lastAssistantContentMock = vi.fn(() => 'LAST_GM_TEXT');
vi.mock('../directorBrief', () => ({
    runDirectorBrief: (...args: unknown[]) => runDirectorBriefMock(...args),
    lastAssistantContent: (...args: unknown[]) => lastAssistantContentMock(...args),
    clearDirectorBriefCache: vi.fn(),
}));

// The watchdog dossier mock — returns an empty dossier so the orchestrator's
// `watchdogNudge` is undefined (no nudge in the payload; irrelevant to the gate).
vi.mock('../directorWatchdog', () => ({
    buildWatchdogDossier: vi.fn(() => ({ signals: [], dossierText: '', nudgeText: null })),
}));

// pendingCommit mock — capturePendingTurnSnapshot is called in the onDone path.
vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: vi.fn(),
}));

// gatherContext mock — returns the minimal GatheredContext shape. The
// orchestrator destructures these fields, so they must all be present.
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

// chatEngine mock — buildPayload returns a one-message payload; sendMessage
// invokes the onDone callback synchronously so `runTurn` resolves cleanly.
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

// payloadSanitizer mock — identity (returns the payload as-is).
vi.mock('../../lib/payloadSanitizer', () => ({
    sanitizePayloadForApi: (p: unknown) => p,
}));

// toast mock — no-op.
vi.mock('../../components/Toast', () => ({
    toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// sceneStakesTag mock — identity (no stakes to strip).
vi.mock('../sceneStakesTag', () => ({
    extractAndStripSceneStakes: (text: string) => ({ displayText: text, stakes: 'calm' as const }),
}));

// Tool handlers / registry mocks — no tools, no handler.
vi.mock('../toolHandlers', () => ({
    getToolDefinitions: vi.fn(() => []),
}));
vi.mock('../toolRegistry', () => ({
    resolveToolHandler: vi.fn(() => null),
}));

// Engine mocks — no-op rolls. Path resolves to src/services/engine/engineRolls
// (the SUT imports from '../engine/engineRolls' relative to src/services/turn/).
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

// One-shot mock — no directive. Path resolves to src/services/oneshot/oneShotEvents.
vi.mock('../../oneshot/oneShotEvents', () => ({
    buildOneShotDirective: vi.fn(() => null),
}));

// useAppStore mock — the orchestrator reads `getActiveAuxiliaryEndpoint()`
// (only if npcIntroEngineActive — we set it false) and `locationLedger` (read
// unconditionally at buildPayload time). Return a minimal state.
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
    // npcIntroEngineActive = false → skips the intro-engine branch (which
    // reads useAppStore.getState().getActiveAuxiliaryEndpoint). All other
    // engine flags off so the engine rolls are no-ops.
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

function baseState(aiTier: 'lite' | 'pro' | 'max'): TurnState {
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
        absoluteCommand: null,
        nextTurnOocBrief: undefined,
    } as any as TurnState;
}

function baseCallbacks(): TurnCallbacks {
    // All callbacks are no-ops; the test only cares about whether
    // runDirectorBrief was invoked. The onDone path calls
    // capturePendingTurnSnapshot (mocked) and a few callbacks — all safe no-ops.
    const noop = () => {};
    return {
        onCheckingNotes: noop,
        addMessage: noop,
        updateLastAssistant: noop,
        updateLastMessage: noop,
        updateLastAssistantMessage: noop,
        updateContext: noop,
        setArchiveIndex: noop,
        updateNPC: noop,
        addNPC: noop,
        setCondensed: noop,
        setStreaming: noop,
        archiveNPC: noop,
        restoreNPC: noop,
    } as any as TurnCallbacks;
}

/** Configure sendMessage to invoke onDone synchronously with a minimal final text. */
function wireSendMessageToComplete(): void {
    sendMessageMock.mockImplementation(
        (_provider: unknown, _messages: unknown, _onChunk: unknown, onDone: any) => {
            // Synchronous onDone — no tool call, no reasoning content.
            Promise.resolve().then(() => onDone('Final GM text.', undefined, undefined));
            return Promise.resolve();
        },
    );
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('runTurn — Director Brief tier gate (WO-04b §7)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        wireSendMessageToComplete();
    });

    it('lite tier completes the pre-payload path without invoking runDirectorBrief', async () => {
        await runTurn(baseState('lite'), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).not.toHaveBeenCalled();
    });

    it('pro tier invokes runDirectorBrief exactly once', async () => {
        await runTurn(baseState('pro'), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(1);
    });

    it('max tier invokes runDirectorBrief exactly once', async () => {
        await runTurn(baseState('max'), baseCallbacks(), new AbortController());
        expect(runDirectorBriefMock).toHaveBeenCalledTimes(1);
    });

    it('the gate is owned by turnOrchestrator, not the service — runDirectorBrief mock returns null and the turn still completes', async () => {
        // The mock returns null (graceful failure). The orchestrator must
        // proceed to buildPayload + sendMessage + onDone without throwing.
        runDirectorBriefMock.mockResolvedValueOnce(null);
        const callbacks = baseCallbacks();
        await runTurn(baseState('pro'), callbacks, new AbortController());
        // buildPayload was reached (the gate didn't short-circuit the turn).
        expect(buildPayloadMock).toHaveBeenCalledTimes(1);
        // sendMessage was reached (the turn completed the pre-payload path).
        expect(sendMessageMock).toHaveBeenCalledTimes(1);
    });

    it('pro tier passes the expected inputs to runDirectorBrief (dossier, userMessage, campaignId, provider)', async () => {
        await runTurn(baseState('pro'), baseCallbacks(), new AbortController());
        const call = runDirectorBriefMock.mock.calls[0][0] as any;
        expect(call).toBeDefined();
        expect(call.campaignId).toBe('camp_test');
        expect(call.userMessage).toContain('I look around.');
        expect(call.provider).toBeDefined();
        // The watchdog dossier is empty (mocked) — dossierText is ''.
        expect(call.dossierText).toBe('');
        // lastAssistantContent is mocked to return 'LAST_GM_TEXT'.
        expect(call.lastAssistant).toBe('LAST_GM_TEXT');
    });
});