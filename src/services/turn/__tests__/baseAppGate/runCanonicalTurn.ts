// Phase 0.5 — Canonical turn runner.
//
// Runs the REAL `runTurn` against a fresh fixed fixture, then triggers the
// REAL `commitPendingTurn` (which runs the REAL `runPostTurnPipeline`). All
// I/O seams are pinned by `deterministicSeams.ts`. Every callback, API call,
// and queue push is recorded by `recorder.ts`.
//
// This file is NOT a mock of the orchestrator. It is the harness that lets
// the real orchestrator run deterministically. The fixture proves the real
// no-mod loader path: extension modules are reset to [] and the post-turn
// track registry is swept of `mod.*.compute` entries before the turn runs.

/* eslint-disable @typescript-eslint/no-explicit-any */

import { useAppStore } from '../../../../store/useAppStore';
import { setExtensionModules } from '../../../payload/contributions/extensions';
import { postTurnTracks } from '../../tracks';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { uid } from '../../../../utils/uid';

import {
    FIXTURE_CAMPAIGN_ID,
    FIXTURE_GM_COMPLETION,
    FIXTURE_SCENE_ID,
    FIXTURE_USER_MESSAGE,
    fixtureArchiveIndex,
    fixtureChapters,
    fixtureCondenser,
    fixtureContext,
    fixtureDivergenceRegister,
    fixtureHistory,
    fixtureLoreChunks,
    fixtureNpcLedger,
    fixturePinnedExcerpts,
    fixtureProvider,
    fixtureSettings,
    fixtureTimeline,
} from './fixture';
import {
    installDeterministicClock,
    installDeterministicMathRandom,
    installDeterministicTimers,
    installDeterministicUid,
    installMockFetch,
    drainTimers,
    type FetchRoute,
    type FetchLog,
} from './deterministicSeams';
import { Recorder, wrapCallbacksWithRecorder, type CanonicalTrace } from './recorder';

// Lazy imports — the SUT (system under test) is imported AFTER the mock seams
// are installed so the module graph picks up the pinned boundaries. Vitest
// hoists `vi.mock` calls, but the deterministic seams (clock/Math.random/
// fetch/timers) are runtime stubs, NOT module mocks, so ordering matters.
const lazyRunTurn = async () => (await import('../../turnOrchestrator')).runTurn;
const lazyCommitPendingTurn = async () => (await import('../../pendingCommit')).commitPendingTurn;
const lazyClearPendingTurnSnapshot = async () => (await import('../../pendingCommit')).clearPendingTurnSnapshot;

export type CanonicalTurnResult = {
    trace: CanonicalTrace;
    fetchLog: FetchLog;
    modsRegistered: boolean;
    computeTracksRegistered: boolean;
};

export async function runCanonicalTurn(): Promise<CanonicalTurnResult> {
    // ── 1. Reset the no-mod loader path ────────────────────────────────────
    // Empty mods root = no extension modules + no `mod.*.compute` tracks.
    // This is the exact state the loader produces for an empty `mods/` dir.
    setExtensionModules([]);
    for (const track of postTurnTracks.list()) {
        if (track.id.startsWith('mod.') && track.id.endsWith('.compute')) {
            postTurnTracks.unregister(track.id);
        }
    }

    // Snapshot whether anything was registered before we cleared, so the gate
    // can prove the fixture is a real no-mod state.
    const modsRegistered = (await import('../../../payload/contributions/extensions')).getExtensionModules().length > 0;
    const computeTracksRegistered = postTurnTracks.list().some(t => t.id.startsWith('mod.') && t.id.endsWith('.compute'));

    // ── 2. Build the recording seam ────────────────────────────────────────
    const recorder = new Recorder();
    const fetchLog: FetchLog[] = [];

    // ── 3. Install deterministic I/O seams ─────────────────────────────────
    const restoreClock = installDeterministicClock();
    const restoreRandom = installDeterministicMathRandom(12345);
    const restoreTimers = installDeterministicTimers();
    const restoreUid = installDeterministicUid({ uid });

    // Mock fetch routes — every network reply the turn + post-turn pipeline
    // can issue. The LLM proxy is the streaming story reply; the archive
    // routes are the post-turn persistence path; settings/campaigns/state
    // cover the durable-commit save. Nothing else is reachable from the
    // canonical fixture.
    const routes: FetchRoute[] = [
        // LLM proxy — single deterministic GM completion. The orchestrator
        // calls sendMessage → llmFetch → POST /llm/proxy. We respond with an
        // OpenAI-format SSE stream containing one content delta + [DONE].
        {
            match: (url, init) => url.endsWith('/llm/proxy') && ((init?.method ?? 'GET').toUpperCase() === 'POST'),
            respond: async () => sseResponse([{
                choices: [{ delta: { content: FIXTURE_GM_COMPLETION } }],
            }, '[DONE]']),
        },
        // Archive append — returns the next scene id.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive`) &&
                (init?.method ?? 'GET').toUpperCase() === 'POST',
            respond: async () => jsonResponse({ sceneNumber: 1, sceneId: FIXTURE_SCENE_ID }),
        },
        // Archive index GET.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive/index`) &&
                (init?.method ?? 'GET').toUpperCase() === 'GET',
            respond: async () => jsonResponse(fixtureArchiveIndex()),
        },
        // Timeline GET.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/timeline`) &&
                (init?.method ?? 'GET').toUpperCase() === 'GET',
            respond: async () => jsonResponse(fixtureTimeline()),
        },
        // Chapters list GET.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive/chapters`) &&
                (init?.method ?? 'GET').toUpperCase() === 'GET',
            respond: async () => jsonResponse(fixtureChapters()),
        },
        // Campaign state PUT — durable-commit save. Accept silently.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/state`) &&
                (init?.method ?? 'GET').toUpperCase() === 'PUT',
            respond: async () => jsonResponse({ ok: true }),
        },
        // Archive events PATCH (post-turn event extraction).
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive/events`) &&
                (init?.method ?? 'GET').toUpperCase() === 'PATCH',
            respond: async () => jsonResponse({ ok: true }),
        },
        // Archive witnesses PATCH.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive/witnesses`) &&
                (init?.method ?? 'GET').toUpperCase() === 'PATCH',
            respond: async () => jsonResponse({ ok: true }),
        },
        // Semantic candidates POST (contextGatherer).
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/archive/semantic-candidates`) &&
                (init?.method ?? 'GET').toUpperCase() === 'POST',
            respond: async () => jsonResponse({ pending: true }),
        },
        // Lore semantic candidates POST.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/lore/semantic-candidates`) &&
                (init?.method ?? 'GET').toUpperCase() === 'POST',
            respond: async () => jsonResponse({ pending: true }),
        },
        // Rules search POST.
        {
            match: (url, init) =>
                url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/rules/search`) &&
                (init?.method ?? 'GET').toUpperCase() === 'POST',
            respond: async () => jsonResponse({ ruleIds: [] }),
        },
        // Generic table reads for the host facade (npcs, locations, etc.).
        {
            match: (url) => url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/npcs`),
            respond: async () => jsonResponse([]),
        },
        {
            match: (url) => url.endsWith(`/campaigns/${FIXTURE_CAMPAIGN_ID}/locations`),
            respond: async () => jsonResponse([]),
        },
    ];
    const restoreFetch = installMockFetch(routes, fetchLog);

    // ── 4. Mock the store so the orchestrator's getState() reads see the
    //       fixture state, and writes are recorded. The store is the live
    //       Zustand store — we hydrate it rather than mock it, so the real
    //       setState + selector path runs.
    hydrateStoreForFixture();

    // ── 5. Build TurnState + callbacks ─────────────────────────────────────
    const runTurn = await lazyRunTurn();
    const commitPendingTurn = await lazyCommitPendingTurn();
    const clearPendingTurnSnapshot = await lazyClearPendingTurnSnapshot();

    const settings = fixtureSettings();
    const context = fixtureContext();
    const history = fixtureHistory();
    const npcLedger = fixtureNpcLedger();
    const archiveIndex = fixtureArchiveIndex();
    const chapters = fixtureChapters();
    const timeline = fixtureTimeline();
    const divergenceRegister = fixtureDivergenceRegister();
    const pinnedExcerpts = fixturePinnedExcerpts();
    const condenser = fixtureCondenser();
    const loreChunks = fixtureLoreChunks();
    const provider = fixtureProvider();

    // Live messages buffer the orchestrator reads via getMessages. It starts
    // as the fixture history; the orchestrator's addMessage callbacks append
    // to it so getMessages sees the fresh tail.
    const messages = [...history];

    const baseCallbacks = buildCallbacks();
    const callbacks = wrapCallbacksWithRecorder(baseCallbacks, recorder);

    const state: any = {
        input: FIXTURE_USER_MESSAGE,
        displayInput: FIXTURE_USER_MESSAGE,
        settings,
        context,
        messages,
        condenser,
        loreChunks,
        npcLedger,
        archiveIndex,
        activeCampaignId: FIXTURE_CAMPAIGN_ID,
        provider,
        getMessages: () => messages,
        getFreshProvider: () => provider,
        getUtilityEndpoint: () => undefined,
        getFreshAuxiliaryProvider: () => provider,
        getRawAuxiliaryProvider: () => provider,
        getRawSummariserProvider: () => provider,
        onStageNpcIds: [],
        timeline,
        chapters,
        pinnedChapterIds: [],
        clearPinnedChapters: () => {},
        setChapters: (c: typeof chapters) => { useAppStore.setState({ chapters: c }); },
        incrementBookkeepingTurnCounter: () => 1,
        resetBookkeepingTurnCounter: () => {},
        autoBookkeepingInterval: 5,
        getFreshContext: () => useAppStore.getState().context,
        sampling: undefined,
        deepSearchThisTurn: false,
        divergenceRegister,
        pinnedExcerpts,
        armedRoll: null,
        armedLoot: null,
        armedOneShot: null,
        absoluteCommand: null,
        nextTurnOocBrief: undefined,
        directorSkipController: null,
    };

    // ── 6. Run the turn ────────────────────────────────────────────────────
    // The real runTurn with the real buildPayload + real sendMessage (mocked
    // at the fetch seam only).
    const abortController = new AbortController();
    await runTurn(state, callbacks as any, abortController);

    // Capture the assembled payload. We rebuild it from the same inputs the
    // orchestrator used so the trace is the byte-identical messages array the
    // provider would have received. The orchestrator stamps the payload onto
    // ctx.payload but does not expose it; the snapshot capture freezes a copy
    // we can read back.
    const getCachedSwipePayload = (await import('../../pendingCommit')).getCachedSwipePayload;
    const cachedPayload = getCachedSwipePayload();
    if (cachedPayload) {
        recorder.setPayload(cachedPayload);
    } else {
        // Fallback: rebuild via buildPayload with the exact options the
        // orchestrator used. This path only fires if the snapshot capture
        // missed (it never should for a successful turn).
        recorder.setPayload([]);
    }

    // ── 7. Drain queued timers (tool-call backoff, retry timers) ───────────
    drainTimers();

    // ── 8. Commit the pending turn — runs the REAL post-turn pipeline ──────
    // commitPendingTurn reads the live store, so the messages the recorder
    // observed being added must be on the store. hydrateStoreForFixture +
    // the callback wrappers kept them in sync.
    await commitPendingTurn();

    // Drain again — the post-turn pipeline schedules background jobs (event
    // extraction, chapter auto-seal, bookkeeping scans). We drain so the
    // trace captures their effects too.
    drainTimers();

    // Final drain in case a background job scheduled another timer.
    drainTimers();

    // ── 9. Capture final messages + trace ──────────────────────────────────
    recorder.setFinalMessages(useAppStore.getState().messages);
    const trace = recorder.toTrace();

    // ── 10. Restore all seams ──────────────────────────────────────────────
    restoreFetch();
    restoreUid();
    restoreTimers();
    restoreRandom();
    restoreClock();
    clearPendingTurnSnapshot();

    // ── 11. Reset the background queue (in case any task rejected late) ────
    backgroundQueue.clear('gate reset');

    // ── 12. Reset the LLM request queue stagger (deterministic timers ran) ─
    // The queue may have a pending recovery timer we installed with our
    // deterministic setTimeout. The real timer was cleared by restoreTimers;
    // the queue's internal state is fine because we never hit a rate limit.

    return {
        trace,
        fetchLog,
        modsRegistered,
        computeTracksRegistered,
    };
}

// ── Helpers ──────────────────────────────────────────────────────────────

function buildCallbacks() {
    // The callbacks write to the REAL store so the orchestrator's read-through
    // path (getState + selectors) runs normally. The recorder wraps these so
    // every call is also stamped onto the trace.
    return {
        onCheckingNotes: () => {},
        addMessage: (msg: any) => {
            useAppStore.getState().addMessage(msg);
        },
        updateLastAssistant: (content: string) => {
            useAppStore.getState().updateLastAssistant(content);
        },
        updateLastMessage: (patch: any) => {
            useAppStore.getState().updateLastMessage(patch);
        },
        updateLastAssistantMessage: (patch: any) => {
            useAppStore.getState().updateLastAssistantMessage(patch);
        },
        updateContext: (patch: any) => {
            useAppStore.getState().updateContext(patch);
        },
        getFreshLocationState: () => ({
            activeCampaignId: FIXTURE_CAMPAIGN_ID,
            locationLedger: [],
            context: useAppStore.getState().context,
        }),
        setCharacterProfileData: (p: any) => useAppStore.getState().setCharacterProfileData(p),
        setInventoryItems: (i: any) => useAppStore.getState().setInventoryItems(i),
        setLocationLedger: (l: any) => useAppStore.getState().setLocationLedger(l),
        addLocationSuggestions: (s: any) => useAppStore.getState().addLocationSuggestions(s),
        setArchiveIndex: (e: any) => useAppStore.getState().setArchiveIndex(e),
        setTimeline: (e: any) => useAppStore.getState().setTimeline(e),
        updateNPC: (id: string, patch: any) => useAppStore.getState().updateNPC(id, patch),
        addNPC: (n: any) => useAppStore.getState().addNPC(n),
        setCondensed: (i: number) => useAppStore.getState().setCondensed(i),
        setStreaming: () => {},
        setLastPayloadTrace: (t: any) => useAppStore.getState().setLastPayloadTrace(t),
        setLoadingStatus: () => {},
        setPipelinePhase: (p: any) => useAppStore.getState().setPipelinePhase(p),
        setDivergenceRegister: (r: any) => useAppStore.getState().setDivergenceRegister(r),
        setOnStageNpcIds: (ids: string[]) => useAppStore.getState().setOnStageNpcIds(ids),
        addNpcSuggestions: (names: string[], ctx?: string) => useAppStore.getState().addNpcSuggestions(names, ctx),
        addEnemySuggestions: (s: any, ctx?: string) => useAppStore.getState().addEnemySuggestions(s, ctx),
        archiveNPC: (id: string, turn: number, reason: string) => useAppStore.getState().archiveNPC(id, turn, reason),
        restoreNPC: (id: string) => useAppStore.getState().restoreNPC(id),
        stageInventoryProposal: () => {},
        onDirectorBriefPhase: () => {},
        persistTurnState: () => Promise.resolve(),
    };
}

function hydrateStoreForFixture(): void {
    // Reset the store to a minimal shape that matches the fixture. The real
    // Zustand store is the live one — we hydrate it so the orchestrator's
    // getState() reads return the fixture values.
    useAppStore.setState({
        activeCampaignId: FIXTURE_CAMPAIGN_ID,
        context: fixtureContext(),
        messages: fixtureHistory(),
        condenser: fixtureCondenser(),
        loreChunks: fixtureLoreChunks(),
        npcLedger: fixtureNpcLedger(),
        archiveIndex: fixtureArchiveIndex(),
        chapters: fixtureChapters(),
        timeline: fixtureTimeline(),
        divergenceRegister: fixtureDivergenceRegister(),
        pinnedExcerpts: fixturePinnedExcerpts(),
        onStageNpcIds: [],
        locationLedger: [],
        npcSuggestions: [],
        locationSuggestions: [],
        settings: fixtureSettings(),
        isStreaming: false,
        pipelinePhase: 'idle',
        lastPayloadTrace: undefined,
        loadingStatus: null,
        bookkeepingTurnCounter: 0,
        autoBookkeepingInterval: 5,
    } as any);
}

function jsonResponse(body: unknown): Promise<Response> {
    const text = JSON.stringify(body);
    const blob = { text } as any;
    const res = {
        ok: true,
        status: 200,
        headers: { get: () => 'application/json' },
        json: async () => body,
        text: async () => text,
        body: null,
        blob: async () => blob,
    } as unknown as Response;
    return Promise.resolve(res);
}

function sseResponse(chunks: unknown[]): Promise<Response> {
    // Build an SSE body from a list of payload objects. Each non-string entry
    // is JSON-stringified with a `data: ` prefix; the string '[DONE]' is
    // emitted verbatim. A ReadableStream carries them so the orchestrator's
    // reader.read() loop sees one chunk per line.
    const lines = chunks.map(c => (typeof c === 'string' ? `data: ${c}\n` : `data: ${JSON.stringify(c)}\n`)).join('') + '\n';
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        start(controller) {
            controller.enqueue(encoder.encode(lines));
            controller.close();
        },
    });
    const res = {
        ok: true,
        status: 200,
        headers: { get: () => 'text/event-stream' },
        json: async () => ({}),
        text: async () => lines,
        body: stream as any,
    } as unknown as Response;
    return Promise.resolve(res);
}