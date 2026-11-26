/* eslint-disable @typescript-eslint/no-explicit-any */
// Smart Retry v1 — Phase 2 stamping tests.
//
// Asserts stampRetryable fires on the two terminal exit branches (user abort +
// retry-exhausted) and does NOT fire on the intermediate retry branches
// (apiRetryCount 0 and 1 are still in flight). Also asserts the stamp targets
// the assistant bubble by id via updateLastAssistantMessage (never
// updateLastMessage), and that precontext.summary is populated from the bus.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { runTurn } from '../turnOrchestrator';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import type { ChatMessage } from '../../../types';

// ── Mocks ──
const capturePendingTurnSnapshotMock = vi.fn();
const updateLastAssistantMessageMock = vi.fn();
const updateLastAssistantMock = vi.fn();
const updateLastMessageMock = vi.fn();
const addMessageMock = vi.fn();
const setPipelinePhaseMock = vi.fn();
const setStreamingMock = vi.fn();

vi.mock('../pendingCommit', () => ({
    capturePendingTurnSnapshot: (...args: unknown[]) => capturePendingTurnSnapshotMock(...args),
    findPendingCommitMessage: () => null,
    findRetryableMessage: () => null,
}));

vi.mock('../../chatEngine', () => ({
    buildPayload: () => ({
        messages: [{ role: 'user', content: 'PAYLOAD' }],
        trace: [],
        debugSections: [],
    }),
    sendMessage: (...args: unknown[]) => sendMessageMock(...args),
}));

vi.mock('../contextGatherer', () => ({
    gatherContext: vi.fn(async () => ({
        archiveRecall: [{ id: 's1' }],
        recommendedNPCNames: ['Aldric'],
        timelineEvents: [],
        relevantLore: [{ id: 'l1' }],
        semanticArchiveIds: ['s1'],
        semanticLoreIds: ['l1'],
        inventoryCategories: ['weapon'],
        profileFields: ['appearance'],
        deepContextSummary: 'DEEP',
        semanticFactText: 'FACT',
        relevantRules: [{ id: 'r1' }],
        rulesManifest: 'MANIFEST',
        elevatedScenes: [],
        elevatedSceneRankedIds: ['s1'],
        slottedRagSnippets: [],
    })),
}));

vi.mock('../directorWatchdog', () => ({
    buildWatchdogDossier: vi.fn(() => ({ signals: [], dossierText: '', nudgeText: 'NUDGE' })),
}));

vi.mock('../directorBrief', () => ({
    runDirectorBrief: vi.fn(async () => null),
    lastAssistantContent: vi.fn(() => 'LAST_GM'),
    clearDirectorBriefCache: vi.fn(),
}));

vi.mock('../../lib/payloadSanitizer', () => ({
    sanitizePayloadForApi: (p: unknown[]) => p,
}));

vi.mock('../toolHandlers', () => ({
    getToolDefinitions: () => [],
}));

vi.mock('../toolRegistry', () => ({
    resolveToolHandler: () => null,
}));

vi.mock('../sceneStakesTag', () => ({
    extractAndStripSceneStakes: (t: string) => ({ displayText: t, stakes: 'calm' as const }),
}));

vi.mock('../engine/engineRolls', () => ({
    rollEngines: () => ({ appendToInput: '', updatedDCs: {} }),
    rollDiceFairness: () => '',
    resolveManualRoll: () => ({ rolls: [1], tier: 'fail', faceValue: 1, detail: 'd20' }),
}));

vi.mock('../engine/lootEngine', () => ({
    resolveLootDrop: () => ({ appendToInput: '' }),
}));

vi.mock('../oneshot/oneShotEvents', () => ({
    buildOneShotDirective: () => null,
}));

vi.mock('../../components/Toast', () => ({
    toast: { warning: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

// sendMessage mock — configured per test to drive a specific callback branch.
const sendMessageMock = vi.fn();

function baseState(): TurnState {
    return {
        input: 'hi',
        displayInput: 'hi',
        settings: { debugMode: false, aiTier: 'lite', contextLimit: 8192 } as any,
        context: { diceFairnessActive: false, diceSystem: { catastrophe: 2, failure: 6, success: 15, triumph: 19, crit: 20 } } as any,
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        activeCampaignId: 'camp1',
        provider: { endpoint: 'http://x', modelName: 'm' } as any,
        getMessages: () => [] as ChatMessage[],
        getFreshProvider: () => ({ endpoint: 'http://x', modelName: 'm' } as any),
        getUtilityEndpoint: () => undefined,
        getFreshAuxiliaryProvider: () => ({ endpoint: 'http://aux', modelName: 'aux' } as any),
        onStageNpcIds: [],
        timeline: [],
        chapters: [],
        pinnedChapterIds: [],
        clearPinnedChapters: () => {},
        setChapters: () => {},
        incrementBookkeepingTurnCounter: () => 0,
        resetBookkeepingTurnCounter: () => {},
        autoBookkeepingInterval: 5,
        getFreshContext: () => ({}) as any,
        sampling: undefined,
        deepSearchThisTurn: false,
        armedRoll: null,
        armedLoot: null,
        armedOneShot: null,
        absoluteCommand: null,
    } as any as TurnState;
}

function baseCallbacks(): TurnCallbacks {
    const noop = () => {};
    return {
        onCheckingNotes: noop,
        addMessage: (...args: unknown[]) => addMessageMock(...args),
        updateLastAssistant: (...args: unknown[]) => updateLastAssistantMock(...args),
        updateLastMessage: (...args: unknown[]) => updateLastMessageMock(...args),
        updateLastAssistantMessage: (...args: unknown[]) => updateLastAssistantMessageMock(...args),
        updateContext: noop,
        setArchiveIndex: noop,
        updateNPC: noop,
        addNPC: noop,
        setCondensed: noop,
        setStreaming: (...args: unknown[]) => setStreamingMock(...args),
        setPipelinePhase: (...args: unknown[]) => setPipelinePhaseMock(...args),
        archiveNPC: noop,
        restoreNPC: noop,
    } as any as TurnCallbacks;
}

/** Drive sendMessage's error callback as a user abort (error string contains 'abort'). */
function wireSendAbort(): void {
    sendMessageMock.mockImplementation(
        (_p: unknown, _m: unknown, _onChunk: unknown, _onDone: unknown, onError: (e: string) => void) => {
            Promise.resolve().then(() => onError('AbortError'));
            return Promise.resolve();
        },
    );
}

describe('Smart Retry v1 — Phase 2 stampRetryable', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Default: complete normally (no error). Tests override.
        sendMessageMock.mockImplementation(
            (_p: unknown, _m: unknown, _onChunk: unknown, onDone: (t: string) => void) => {
                Promise.resolve().then(() => onDone('GM text'));
                return Promise.resolve();
            },
        );
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('user abort stamps retryable via updateLastAssistantMessage (NOT updateLastMessage)', async () => {
        wireSendAbort();
        await runTurn(baseState(), baseCallbacks(), new AbortController());
        // stampRetryable calls updateLastAssistantMessage with retryable:true + precontext.
        const stampCalls = updateLastAssistantMessageMock.mock.calls.filter(
            (c: unknown[]) => (c[0] as { retryable?: boolean }).retryable === true,
        );
        expect(stampCalls.length).toBe(1);
        const patch = stampCalls[0][0] as { retryable?: boolean; precontext?: { summary?: string } };
        expect(patch.retryable).toBe(true);
        expect(patch.precontext?.summary).toBeTruthy();
        // Must NOT use updateLastMessage (would stamp the tool message after a tool call).
        const wrongStamp = updateLastMessageMock.mock.calls.filter(
            (c: unknown[]) => (c[0] as { retryable?: boolean }).retryable === true,
        );
        expect(wrongStamp.length).toBe(0);
    });

    it('retry-exhausted (apiRetryCount 2) stamps retryable with a precontext summary built from the gathered context', async () => {
        // Drive three consecutive errors: first two schedule retries, the third
        // exhausts and stamps. Each sendMessage call fires its onError immediately.
        let calls = 0;
        sendMessageMock.mockImplementation(
            (_p: unknown, _m: unknown, _onChunk: unknown, _onDone: unknown, onError: (e: string) => void) => {
                calls++;
                // All three calls error — the orchestrator's setTimeout retries are
                // synchronous-ish here because we resolve immediately; but the retry
                // uses setTimeout(…, 2000/4000). We can't await those without fake timers.
                Promise.resolve().then(() => onError(`fail-${calls}`));
                return Promise.resolve();
            },
        );
        // Use fake timers to advance the setTimeout-based retries.
        vi.useFakeTimers();
        try {
            const p = runTurn(baseState(), baseCallbacks(), new AbortController());
            // Flush the microtask that fires the first onError.
            await vi.advanceTimersByTimeAsync(0);
            // First error (apiRetryCount 0) schedules a 2s retry.
            await vi.advanceTimersByTimeAsync(2000);
            // Second error (apiRetryCount 1) schedules a 4s retry.
            await vi.advanceTimersByTimeAsync(4000);
            // Third error (apiRetryCount 2) is terminal — stamps retryable.
            await vi.advanceTimersByTimeAsync(0);
            await p;
        } finally {
            vi.useRealTimers();
        }
        const stampCalls = updateLastAssistantMessageMock.mock.calls.filter(
            (c: unknown[]) => (c[0] as { retryable?: boolean }).retryable === true,
        );
        expect(stampCalls.length).toBe(1);
        const patch = stampCalls[0][0] as { precontext?: { summary?: string } };
        // Summary reflects the gathered context (Lore×1 · Rules×1 · Archive×1 · Hits×1 · NPCs×1 · DeepScan).
        expect(patch.precontext?.summary).toContain('Lore');
        expect(patch.precontext?.summary).toContain('DeepScan');
    });

    it('intermediate retry (apiRetryCount 0) does NOT stamp retryable', async () => {
        // Fire ONE error (apiRetryCount 0), then let the retry succeed.
        let firstCall = true;
        sendMessageMock.mockImplementation(
            (_p: unknown, _m: unknown, _onChunk: unknown, onDone: (t: string) => void, onError: (e: string) => void) => {
                if (firstCall) {
                    firstCall = false;
                    Promise.resolve().then(() => onError('fail-0'));
                } else {
                    Promise.resolve().then(() => onDone('recovered GM text'));
                }
                return Promise.resolve();
            },
        );
        vi.useFakeTimers();
        try {
            const p = runTurn(baseState(), baseCallbacks(), new AbortController());
            await vi.advanceTimersByTimeAsync(0);
            await vi.advanceTimersByTimeAsync(2000);
            await p;
        } finally {
            vi.useRealTimers();
        }
        const stampCalls = updateLastAssistantMessageMock.mock.calls.filter(
            (c: unknown[]) => (c[0] as { retryable?: boolean }).retryable === true,
        );
        expect(stampCalls.length).toBe(0);
    });
});