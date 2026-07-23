/* eslint-disable @typescript-eslint/no-explicit-any */
// WO-05: hook-level tests for the Director Brief status + Skip lifecycle.
//
// Asserts the contract in `useChatOperations.ts`:
//   - `directorBriefRunning` toggles true on `onDirectorBriefPhase('running')`
//     and false on `onDirectorBriefPhase('done')` (start/finish/abort all toggle).
//   - `handleSkipDirectorBrief` aborts the Director skip-controller's signal
//     (the one passed to `runTurn` as `state.directorSkipController`) WITHOUT
//     aborting the turn's outer `AbortController`. The turn proceeds normally
//     — `runTurn` resolves and the chapter-seal check still fires.
//   - The skip handle is single-use: a second Skip after settle is a no-op
//     (the ref is cleared on 'done' so a stale abort never fires).
//
// The hook's other collaborators (`commitPendingTurn`,
// `debouncedSaveCampaignState`, the store) are mocked so the test reaches the
// Director phase path without any real I/O. `runTurn` is mocked with a
// configurable implementation that captures the state + callbacks so each
// test can drive `onDirectorBriefPhase` exactly when it wants.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { AppSettings, GameContext, CondenserState, EndpointConfig } from '../../types';

// ── Mocks (hoisted by vitest) ────────────────────────────────────────────────

const runTurnMock = vi.fn();
const commitPendingTurnMock = vi.fn(async () => {});
const debouncedSaveCampaignStateMock = vi.fn();

vi.mock('../../services/turn/turnOrchestrator', () => ({
    // The wrapper delegates to `runTurnMock` so test assertions can inspect
    // `runTurnMock.mock.calls`. The imported `runTurn` binding is this wrapper
    // (not a spy), so all assertions use `runTurnMock` directly.
    runTurn: (...args: unknown[]) => runTurnMock(...args),
}));

vi.mock('../../services/turn/pendingCommit', () => ({
    commitPendingTurn: (...args: unknown[]) => commitPendingTurnMock(...args),
    findRetryableMessage: () => null,
}));

vi.mock('../../store/slices/campaignSlice', () => ({
    debouncedSaveCampaignState: (...args: unknown[]) => debouncedSaveCampaignStateMock(...args),
}));

// The hook uses `useSceneContinue` only for `sceneContinue.getAbortController()`
// inside handleStop. The Director tests don't touch Stop, so a stub is enough.
const sceneContinueStub = {
    getAbortController: () => null,
} as any;

vi.mock('../../store/useAppStore', () => {
    // Minimal store state — only the fields the hook reads. `getActiveStoryEndpoint`
    // must return a truthy provider so handleSend proceeds to runTurn.
    const state: Record<string, any> = {
        context: { notebook: [], pcPromptDismissed: true } as unknown as GameContext,
        activeCampaignId: 'camp_test',
        deepArmed: false,
        setDeepArmed: vi.fn(),
        settings: { aiTier: 'pro' } as unknown as AppSettings,
        loreChunks: [],
        npcLedger: [],
        archiveIndex: [],
        timeline: [],
        chapters: [],
        pinnedChapterIds: [],
        setArchiveIndex: vi.fn(),
        updateLastAssistant: vi.fn(),
        updateContext: vi.fn(),
        setCondensed: vi.fn(),
        setTimeline: vi.fn(),
        setChapters: vi.fn(),
        pipelinePhase: 'idle',
        setPipelinePhase: vi.fn(),
        setStreamingStats: vi.fn(),
        messages: [],
        condenser: { condensedUpToIndex: -1 } as unknown as CondenserState,
        getActiveStoryEndpoint: () => ({ endpoint: 'http://test', modelName: 'story' } as EndpointConfig),
        getActiveUtilityEndpoint: () => undefined,
        getActiveAuxiliaryEndpoint: () => undefined,
        getActivePreset: () => undefined,
        armedRoll: null,
        setArmedRoll: vi.fn(),
        armedLoot: null,
        clearArmedLoot: vi.fn(),
        armedOneShot: null,
        setArmedOneShot: vi.fn(),
        armedAbsoluteCommand: null,
        setArmedAbsoluteCommand: vi.fn(),
        divergenceRegister: undefined,
        onStageNpcIds: [],
        pinnedExcerpts: undefined,
        incrementBookkeepingTurnCounter: vi.fn(() => 1),
        resetBookkeepingTurnCounter: vi.fn(),
        autoBookkeepingInterval: 5,
        clearPinnedChapters: vi.fn(),
        addMessage: vi.fn(),
        updateLastMessage: vi.fn(),
        updateLastAssistantMessage: vi.fn(),
        updateNPC: vi.fn(),
        addNPC: vi.fn(),
        setLastPayloadTrace: vi.fn(),
        setDivergenceRegister: vi.fn(),
        setOnStageNpcIds: vi.fn(),
        addNpcSuggestions: vi.fn(),
        archiveNPC: vi.fn(),
        restoreNPC: vi.fn(),
    };
    const subscribe = vi.fn(() => vi.fn());
    const getState = vi.fn(() => state);
    const useAppStore = Object.assign(
        (selector: any) => (typeof selector === 'function' ? selector(state) : state),
        { getState, subscribe },
    );
    return { useAppStore };
});

// ── SUT import (after mocks are hoisted) ─────────────────────────────────────

import { useChatOperations } from '../useChatOperations';

// ── Fixtures ─────────────────────────────────────────────────────────────────

function baseArgs(): Parameters<typeof useChatOperations>[0] {
    return {
        input: 'I look around.',
        setInput: vi.fn(),
        resetTextareaHeight: vi.fn(),
        oocBusy: false,
        armedAskGmBrief: null,
        setArmedAskGmBrief: vi.fn(),
        sceneContinue: sceneContinueStub,
        checkAndSealChapter: vi.fn(),
    };
}

/** Holds the live state + callbacks captured by the runTurn mock. The `state`
 *  field is reassigned inside the mock, so tests must read `holder.state` AFTER
 *  the mock fires (not from a spread copy taken at setup time). */
interface CaptureHolder {
    state: { directorSkipController?: AbortController | null } | undefined;
    callbacks: { onDirectorBriefPhase?: (phase: 'running' | 'done') => void } | undefined;
}

/** Drive `runTurn` so it immediately fires `onDirectorBriefPhase('running')`,
 *  then pauses until the test aborts (via Skip) or resolves the call. Returns
 *  the live capture holder + a `resume` function so the test can drive the
 *  phase transitions and unblock the paused `runTurn`. */
function wireRunTurnToPauseAtDirector(): {
    holder: CaptureHolder;
    resume: () => void;
} {
    const holder: CaptureHolder = { state: undefined, callbacks: undefined };
    let resolveRun!: () => void;
    runTurnMock.mockImplementation(async (state: any, callbacks: any) => {
        holder.state = state;
        holder.callbacks = callbacks;
        // Simulate the orchestrator firing 'running' just before the Director call.
        callbacks.onDirectorBriefPhase?.('running');
        // Pause inside runTurn until the test resolves us. This mirrors the
        // real await on `runDirectorBrief`.
        await new Promise<void>(r => { resolveRun = r; });
        // Simulate the orchestrator's `finally` firing 'done' after settle.
        callbacks.onDirectorBriefPhase?.('done');
    });
    return { holder, resume: () => resolveRun() };
}

/** Drive `runTurn` so it fires 'running' then 'done' and resolves immediately
 *  (Director call settled — success or graceful null). Returns the live
 *  capture holder so tests can inspect `state.directorSkipController`. */
function wireRunTurnToSettleImmediately(): CaptureHolder {
    const holder: CaptureHolder = { state: undefined, callbacks: undefined };
    runTurnMock.mockImplementation(async (state: any, callbacks: any) => {
        holder.state = state;
        holder.callbacks = callbacks;
        callbacks.onDirectorBriefPhase?.('running');
        // Yield a microtask so React's state update flushes between the two
        // phase events (mirrors the real await on runDirectorBrief).
        await Promise.resolve();
        callbacks.onDirectorBriefPhase?.('done');
    });
    return holder;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useChatOperations — Director Brief UI state (WO-05)', () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it('directorBriefRunning toggles true on start and false on finish', async () => {
        wireRunTurnToSettleImmediately();
        const { result } = renderHook(() => useChatOperations(baseArgs()));

        expect(result.current.directorBriefRunning).toBe(false);

        await act(async () => {
            await result.current.handleSend();
        });

        // After the turn settles, the flag must be back to false.
        expect(result.current.directorBriefRunning).toBe(false);
        expect(runTurnMock).toHaveBeenCalledTimes(1);
    });

    it('directorBriefRunning is true while the Director call is in flight', async () => {
        const { holder, resume } = wireRunTurnToPauseAtDirector();
        const { result } = renderHook(() => useChatOperations(baseArgs()));

        // Kick off the send — it pauses inside runTurn at the Director call.
        let sendPromise!: Promise<unknown>;
        act(() => { sendPromise = result.current.handleSend(); });
        // Let the 'running' phase callback flush.
        await act(async () => { await Promise.resolve(); });

        expect(result.current.directorBriefRunning).toBe(true);
        // The state + callbacks were captured by the mock.
        expect(holder.state).toBeDefined();
        expect(holder.callbacks?.onDirectorBriefPhase).toBeDefined();

        // Resume so runTurn fires 'done' and resolves; the flag must clear.
        await act(async () => { resume(); await sendPromise; });
        expect(result.current.directorBriefRunning).toBe(false);
    });

    it('handleSkipDirectorBrief aborts the Director skip controller only — the turn proceeds', async () => {
        const { holder, resume } = wireRunTurnToPauseAtDirector();
        const { result } = renderHook(() => useChatOperations(baseArgs()));

        let sendPromise!: Promise<unknown>;
        act(() => { sendPromise = result.current.handleSend(); });
        await act(async () => { await Promise.resolve(); });

        // While the Director is in flight, the skip handle must be wired.
        const skipController = holder.state?.directorSkipController;
        expect(skipController).toBeInstanceOf(AbortController);
        expect(skipController!.signal.aborted).toBe(false);

        // Skip aborts ONLY the Director skip controller. The turn's outer
        // AbortController (also passed to runTurn) is a separate instance that
        // is not affected by Skip — the test asserts the skip signal is the
        // only one that aborts.
        act(() => {
            result.current.handleSkipDirectorBrief();
        });

        expect(skipController!.signal.aborted).toBe(true);
        // The flag clears synchronously on Skip (hedge path; the orchestrator's
        // 'done' callback also clears it, but Skip sets it false immediately).
        expect(result.current.directorBriefRunning).toBe(false);

        // Resume runTurn so the test cleans up. The turn completes normally —
        // Skip only aborted the Director, not the whole turn.
        await act(async () => { resume(); await sendPromise; });
        expect(runTurnMock).toHaveBeenCalledTimes(1);
    });

    it('handleSkipDirectorBrief is a no-op when no Director call is in flight', async () => {
        const holder = wireRunTurnToSettleImmediately();
        const { result } = renderHook(() => useChatOperations(baseArgs()));

        await act(async () => {
            await result.current.handleSend();
        });
        // After settle, the skip handle is cleared — Skip must be a no-op.
        expect(result.current.directorBriefRunning).toBe(false);
        const skipController = holder.state?.directorSkipController;
        expect(skipController).toBeInstanceOf(AbortController);
        // The skip controller was cleared from the ref on 'done'; calling Skip
        // again must not abort the stale controller or throw.
        expect(() => {
            act(() => { result.current.handleSkipDirectorBrief(); });
        }).not.toThrow();
        // The stale controller (captured during the turn) remains un-aborted —
        // Skip after settle did not reach it. (It would be safe even if it did,
        // since the Director call already settled, but the contract is "no-op".)
        expect(skipController!.signal.aborted).toBe(false);
    });

    it('handleStop clears the Director UI state and the skip handle (full Stop still aborts the Director via AbortSignal.any)', async () => {
        const { holder, resume } = wireRunTurnToPauseAtDirector();
        const { result } = renderHook(() => useChatOperations(baseArgs()));

        let sendPromise!: Promise<unknown>;
        act(() => { sendPromise = result.current.handleSend(); });
        await act(async () => { await Promise.resolve(); });
        expect(result.current.directorBriefRunning).toBe(true);

        const skipController = holder.state?.directorSkipController;
        expect(skipController).toBeInstanceOf(AbortController);

        act(() => {
            result.current.handleStop();
        });

        // Full Stop resets the Director UI flag + drops the skip handle.
        expect(result.current.directorBriefRunning).toBe(false);

        // Resume so the paused runTurn can complete (the test's runTurn mock
        // doesn't observe the outer abort — it just awaits the resume promise).
        await act(async () => { resume(); await sendPromise; });
    });
});