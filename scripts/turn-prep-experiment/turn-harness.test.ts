// Turn Prep Experiment — turn harness (Upgrade/Turn-Prep-Experiment/SPEC.md §6, §7).
//
// Plays ONE probe message through the app's real turn pipeline, the way the Send button
// does, against a campaign served by the running backend (http://localhost:3001), then
// stops before the commit. Records per-stage timing, every model call, the exact payload
// and the reply. Never writes campaign data: every mutating request is blocked and logged.
//
//   EXP_CAMPAIGN=exp-c1-rebuilt EXP_PROBE=P2 EXP_ARM=FULL EXP_SAMPLE=1 \
//   EXP_STORY="GLM 5.2 NanoGPT" EXP_UTILITY="DS v4 Flash" [EXP_MOCK=1] \
//   npx vitest run --config scripts/turn-prep-experiment/vitest.experiment.config.ts turn-harness
//
// Arms (§3): FULL = the Max tier matrix as shipped. SIMPLE = Max minus the model calls
// that run before the first token. U1..U4 = SIMPLE plus one unit added back.
// Real model calls need API keys, which live only in the browser. Supply them in
// scripts/turn-prep-experiment/.keys.json ({ "<provider label>": "<key>" }, gitignored).
// EXP_MOCK=1 replaces every model call with a canned reply to validate the plumbing.

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { test, vi } from 'vitest';

// jsdom has no IndexedDB. The app keeps settings there in the browser; here loadSettings
// must fall through to its server path (GET /api/settings), exactly as on a fresh device.
const idbMemory = new Map<string, unknown>();
vi.mock('idb-keyval', () => ({
    get: async (k: string) => idbMemory.get(k),
    set: async (k: string, v: unknown) => { idbMemory.set(k, v); },
    del: async (k: string) => { idbMemory.delete(k); },
}));

// SPEC §3: arms without the Recommender get a deterministic replacement, not nothing.
// Off, the app returns `undefined`, which means NO inventory/profile block under smart
// bookkeeping (volatile.ts) and a bare name scan for NPCs (world.ts). The replacement
// passes every valid category and field, and selects NPCs by the same name scan ∪ the
// on-stage IDs. Arms that keep the Recommender get the real module.
const recommenderStandIn = vi.hoisted(() => ({ npcs: [] as string[], onStageAdded: [] as string[] }));
vi.mock('../../src/services/context-gatherer/recommenderGather', async (importOriginal) => {
    const original = await importOriginal<typeof import('../../src/services/context-gatherer/recommenderGather')>();
    const arm = process.env.EXP_ARM ?? 'FULL';
    if (arm === 'FULL' || arm === 'U2' || arm === 'MAX') return original;
    return {
        ...original,
        gatherRecommender: async (state: any, finalInput: string, _pinned: unknown, _signal: unknown, facade: any) => {
            const npcLedger: any[] = facade?.data?.npcLedger ?? state.npcLedger ?? [];
            const messages: any[] = facade?.data?.messages ?? state.messages ?? [];
            const onStage = new Set<string>(facade?.data?.onStageNpcIds ?? state.onStageNpcIds ?? []);
            const scan = (messages.slice(-10).map(m => m.content || '').join(' ') + ' ' + finalInput).toLowerCase();
            const live = npcLedger.filter(n => !n.archived && n.name);
            const byScan = live.filter(n => [n.name, ...String(n.aliases || '').split(',')]
                .map((a: string) => a.trim().toLowerCase()).filter(Boolean).some((p: string) => scan.includes(p)));
            const byStage = live.filter(n => onStage.has(n.id) && !byScan.includes(n));
            recommenderStandIn.npcs = [...byScan, ...byStage].map(n => n.name);
            recommenderStandIn.onStageAdded = byStage.map(n => n.name);
            return {
                recommendedNPCNames: recommenderStandIn.npcs.length ? recommenderStandIn.npcs : undefined,
                inventoryCategories: ['equipped', 'weapon', 'armor', 'consumable', 'key', 'currency', 'misc'],
                profileFields: ['name', 'race', 'class', 'level', 'hp', 'mp', 'stats', 'skills', 'abilities', 'traits', 'notes'],
            };
        },
    };
});

const SERVER = process.env.EXP_SERVER ?? 'http://localhost:3001';
const CAMPAIGN = process.env.EXP_CAMPAIGN ?? 'exp-c1-rebuilt';
const PROBE = process.env.EXP_PROBE ?? 'P1';
const ARM = process.env.EXP_ARM ?? 'FULL';
const SAMPLE = process.env.EXP_SAMPLE ?? '1';
const MOCK = process.env.EXP_MOCK === '1';
const STORY = process.env.EXP_STORY ?? '';
const UTILITY = process.env.EXP_UTILITY ?? STORY;
const HERE = path.resolve('scripts/turn-prep-experiment');
const RUNS_NAME = process.env.EXP_RUNS || 'runs';

const PRE_TOKEN_MODEL_FEATURES = ['planner', 'archiveFunnel', 'recommender', 'directorBrief', 'expandQuery', 'reranker', 'introEngine'] as const;
const ADD_BACK: Record<string, string[]> = {
    U1: ['planner', 'archiveFunnel'],
    U2: ['recommender'],
    U3: ['directorBrief'],
    U4: ['expandQuery', 'reranker'],
    // The Max tier as shipped after 2026-10-03: every pre-token step except the chapter funnel.
    MAX: ['planner', 'recommender', 'directorBrief', 'expandQuery', 'reranker', 'introEngine'],
};

// Read-only POST endpoints the turn may call. Every other non-GET request is blocked.
const READ_ONLY_POST = /\/llm\/proxy$|semantic-candidates$|\/search$|\/query$|\/recall$|\/rerank$/;

type Mark = { t: number; event: string; detail?: unknown };
type Usage = {
    prompt_tokens?: number; completion_tokens?: number;
    prompt_cache_hit_tokens?: number; prompt_cache_miss_tokens?: number;
    completion_tokens_details?: { reasoning_tokens?: number };
};
type ModelRequest = {
    t: number; stream: boolean; model?: string; promptChars: number; head: string;
    ms?: number; status?: number; usage?: Usage;
    firstReasoningMs?: number; firstContentMs?: number; endMs?: number;
    toolCall?: string; finishReason?: string;
};

test(`turn harness: ${CAMPAIGN} ${PROBE} ${ARM} s${SAMPLE}${MOCK ? ' (mock)' : ''}`, async () => {
    const t0 = performance.now();
    const marks: Mark[] = [];
    const mark = (event: string, detail?: unknown) => marks.push({ t: Math.round(performance.now() - t0), event, detail });
    const blockedWrites: string[] = [];
    const modelRequests: ModelRequest[] = [];
    const watchers: Promise<void>[] = [];

    // ── Network seam: absolute URLs, write blocking, optional mock model ─────
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: any, init?: RequestInit) => {
        let url = typeof input === 'string' ? input : input?.url ?? String(input);
        if (url.startsWith('/')) url = SERVER + url;
        const method = (init?.method ?? 'GET').toUpperCase();
        if (method !== 'GET' && !READ_ONLY_POST.test(url.split('?')[0])) {
            blockedWrites.push(`${method} ${url.replace(SERVER, '')}`);
            return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (url.endsWith('/llm/proxy')) {
            const outer = JSON.parse(String(init?.body ?? '{}'));
            const inner = outer.body ? JSON.parse(outer.body) : {};
            const system = (inner.messages ?? []).find((m: any) => m.role === 'system')?.content;
            const rec: ModelRequest = {
                t: Math.round(performance.now() - t0), stream: !!inner.stream, model: inner.model,
                promptChars: JSON.stringify(inner.messages ?? inner.prompt ?? '').length,
                head: typeof system === 'string' ? system.slice(0, 80) : '',
            };
            modelRequests.push(rec);
            const started = performance.now();
            if (MOCK) await new Promise(r => setTimeout(r, inner.stream ? 400 : 250));
            // EXP_MOCK_TOOL=1: the first story stream calls the lore tool, as the real model often does.
            const mockToolCall = MOCK && process.env.EXP_MOCK_TOOL === '1' && inner.stream && !modelRequests.slice(0, -1).some(r => r.stream);
            const res = MOCK ? (inner.stream ? (mockToolCall ? mockToolStream() : mockStream()) : mockJson()) : await realFetch(url, init);
            rec.ms = Math.round(performance.now() - started); // time to response headers
            rec.status = res.status;
            if (!res.body) return res;
            if (inner.stream) {
                // Read our own copy of the stream for usage and thinking/content timing.
                const [mine, theirs] = res.body.tee();
                watchers.push(watchStream(mine, rec, started));
                return new Response(theirs, { status: res.status, statusText: res.statusText, headers: res.headers });
            }
            watchers.push(res.clone().json().then((j: any) => { rec.usage = j?.usage; rec.endMs = Math.round(performance.now() - started); }, () => {}));
            return res;
        }
        return realFetch(url, init);
    }) as typeof fetch;

    // ── Console seam: keep the gather trace, silence the rest ────────────────
    const gatherTrace: string[] = [];
    const realLog = console.log;
    console.log = (...args: unknown[]) => {
        const line = args.map(a => (typeof a === 'string' ? a : '')).join(' ');
        if (line.includes('[GatherTrace]')) gatherTrace.push(line);
    };
    console.debug = () => {};

    try {
        const { useAppStore } = await import('../../src/store/useAppStore');
        const { hydrateCampaign } = await import('../../src/store/campaignHydrator');
        const { MATRIX } = await import('../../src/services/turn/aiTier');
        const { runTurn } = await import('../../src/services/turn/turnOrchestrator');
        const { getCachedSwipePayload, clearPendingTurnSnapshot } = await import('../../src/services/turn/pendingCommit');
        const { getCallHistory } = await import('../../src/services/llm/utilityCallTracker');

        // ── App startup: settings, then the campaign (App.tsx order) ─────────
        await useAppStore.getState().loadSettings();
        const s0 = useAppStore.getState().settings;
        const providers = s0.providers ?? [];
        const byLabel = (label: string) => providers.find(p => p.label === label);
        const story = STORY ? byLabel(STORY) : undefined;
        const utility = UTILITY ? byLabel(UTILITY) : undefined;
        if (STORY && !story) throw new Error(`No provider labelled "${STORY}". Have: ${providers.map(p => p.label).join(', ')}`);
        if (UTILITY && !utility) throw new Error(`No provider labelled "${UTILITY}"`);
        if (!MOCK) {
            const keysPath = path.join(HERE, '.keys.json');
            if (!fs.existsSync(keysPath)) throw new Error('Real model calls need scripts/turn-prep-experiment/.keys.json (see header). Use EXP_MOCK=1 to validate the plumbing.');
            const keys = JSON.parse(fs.readFileSync(keysPath, 'utf8')) as Record<string, string>;
            for (const p of providers) if (keys[p.label]) p.apiKey = keys[p.label];
            for (const p of [story, utility]) if (p && !p.apiKey) throw new Error(`No key for "${p.label}" in .keys.json`);
        }
        const presets = (s0.presets ?? []).map(p => p.id !== s0.activePresetId ? p : {
            ...p,
            ...(story ? { storyAIProviderId: story.id } : {}),
            ...(utility ? { utilityAIProviderId: utility.id, auxiliaryAIProviderId: utility.id, summarizerAIProviderId: utility.id } : {}),
        });
        useAppStore.setState({ settings: { ...s0, providers, presets, aiTier: 'max', debugMode: true, moduleEnabled: {} } } as any);

        useAppStore.setState({ activeCampaignId: CAMPAIGN } as any);
        await hydrateCampaign(CAMPAIGN);

        // Without current embeddings, recall silently falls back to keywords (SPEC V12).
        const emb = await (await realFetch(`${SERVER}/api/campaigns/${CAMPAIGN}/embeddings/status`)).json();
        const sceneCount = (useAppStore.getState() as any).archiveIndex?.length ?? 0;
        if (emb.scenes.stale || emb.lore.stale || emb.scenes.current < sceneCount) {
            throw new Error(`Embeddings not ready for ${CAMPAIGN}: ${JSON.stringify(emb)} vs ${sceneCount} scenes. Run embed-campaigns.mjs.`);
        }
        mark('hydrated');

        // ── Arm: explicit feature matrix (never via settings — SPEC V8) ─────
        const enabled = new Set<string>(ARM === 'FULL' ? PRE_TOKEN_MODEL_FEATURES : (ADD_BACK[ARM] ?? []));
        for (const f of PRE_TOKEN_MODEL_FEATURES) (MATRIX.max as any)[f] = enabled.has(f);

        // ── The turn, built exactly like handleSend (useChatOperations.ts) ───
        const probes = JSON.parse(fs.readFileSync(path.join(HERE, 'probes.json'), 'utf8'));
        const group = Object.values(probes).find((g: any) => g?.campaigns?.includes(CAMPAIGN)) as any;
        const input: string = group?.probes?.[PROBE];
        if (!input) throw new Error(`No probe ${PROBE} for ${CAMPAIGN}`);

        const st = useAppStore.getState() as any;
        let firstToken: number | null = null;
        let firstVisibleToken: number | null = null;
        let lastPayloadTrace: unknown = null;
        const visible = (c: string) => c.replace(/<think>[\s\S]*?(<\/think>|$)/g, '').trim();
        const abort = new AbortController();

        await runTurn({
            input, displayInput: input,
            settings: st.settings, context: st.context, messages: st.messages, condenser: st.condenser,
            loreChunks: st.loreChunks, npcLedger: st.npcLedger, archiveIndex: st.archiveIndex,
            activeCampaignId: CAMPAIGN, provider: st.getActiveStoryEndpoint(),
            getMessages: () => useAppStore.getState().messages,
            getFreshProvider: () => useAppStore.getState().getActiveStoryEndpoint(),
            getUtilityEndpoint: () => useAppStore.getState().getActiveUtilityEndpoint(),
            getRawAuxiliaryProvider: () => useAppStore.getState().getActiveAuxiliaryEndpoint(),
            getRawSummariserProvider: () => useAppStore.getState().getActiveSummarizerEndpoint(),
            timeline: st.timeline, chapters: st.chapters, pinnedChapterIds: st.pinnedChapterIds,
            clearPinnedChapters: st.clearPinnedChapters, setChapters: st.setChapters,
            incrementBookkeepingTurnCounter: st.incrementBookkeepingTurnCounter,
            resetBookkeepingTurnCounter: st.resetBookkeepingTurnCounter,
            autoBookkeepingInterval: st.autoBookkeepingInterval,
            getFreshContext: () => useAppStore.getState().context,
            sampling: st.getActivePreset()?.sampling,
            deepSearchThisTurn: false,
            divergenceRegister: st.divergenceRegister, onStageNpcIds: st.onStageNpcIds,
            relationshipMemoriesNpcToMc: st.relationshipMemoriesNpcToMc,
            relationshipMemoriesNpcToNpc: st.relationshipMemoriesNpcToNpc,
            relationshipMemoryFaults: st.relationshipMemoryFaults,
            pinnedExcerpts: st.pinnedExcerpts,
            armedRoll: null, armedLoot: null, armedOneShot: null, absoluteCommand: null,
            getFreshAuxiliaryProvider: () => {
                const aux = useAppStore.getState().getActiveAuxiliaryEndpoint();
                return aux?.modelName ? aux : useAppStore.getState().getActiveStoryEndpoint();
            },
            nextTurnOocBrief: undefined, directorSkipController: null,
        } as any, {
            onCheckingNotes: () => {},
            addMessage: st.addMessage,
            updateLastAssistant: (content: string, ...rest: unknown[]) => {
                if (firstToken === null && content) { firstToken = performance.now(); mark('first-token'); }
                if (firstVisibleToken === null && content && visible(content)) { firstVisibleToken = performance.now(); mark('first-visible-token'); }
                return (useAppStore.getState() as any).updateLastAssistant(content, ...rest);
            },
            updateLastMessage: st.updateLastMessage,
            updateLastAssistantMessage: st.updateLastAssistantMessage,
            updateContext: st.updateContext,
            getFreshLocationState: () => { const f = useAppStore.getState() as any; return { activeCampaignId: f.activeCampaignId, locationLedger: f.locationLedger, context: f.context }; },
            setCharacterProfileData: st.setCharacterProfileData,
            setInventoryItems: st.setInventoryItems,
            setLocationLedger: st.setLocationLedger,
            addLocationSuggestions: st.addLocationSuggestions,
            setArchiveIndex: st.setArchiveIndex,
            setTimeline: st.setTimeline,
            updateNPC: st.updateNPC, addNPC: st.addNPC,
            setCondensed: st.setCondensed,
            setStreaming: (on: boolean) => mark(on ? 'streaming-on' : 'streaming-off'),
            setLoadingStatus: (status: string | null) => { if (status) mark('status', status); },
            setPipelinePhase: (phase: string) => { mark(`phase:${phase}`); st.setPipelinePhase?.(phase); },
            setLastPayloadTrace: (trace: unknown) => { lastPayloadTrace = trace; },
            setDivergenceRegister: st.setDivergenceRegister,
            setOnStageNpcIds: st.setOnStageNpcIds,
            addNpcSuggestions: st.addNpcSuggestions,
            archiveNPC: st.archiveNPC, restoreNPC: st.restoreNPC,
            stageInventoryProposal: () => {},
            persistTurnState: () => {},
            onDirectorBriefPhase: (phase: string) => mark(`director:${phase}`),
        } as any, abort);
        // runTurn resolves after the FIRST generation round. A tool call (or an API retry)
        // continues on a timer, so the turn is only over when the pipeline returns to idle
        // and stays there. Collecting at the promise saved empty replies for every turn in
        // which the model called a tool.
        const lastPhase = () => [...marks].reverse().find(m => m.event.startsWith('phase:'))?.event;
        const deadline = performance.now() + 600_000;
        for (;;) {
            if (lastPhase() === 'phase:idle') {
                const seen = marks.length;
                await new Promise(r => setTimeout(r, 2000));
                if (marks.length === seen && lastPhase() === 'phase:idle') break;
            } else {
                await new Promise(r => setTimeout(r, 250));
            }
            if (performance.now() > deadline) throw new Error(`turn never returned to idle (last phase: ${lastPhase()})`);
        }
        mark('turn-done');
        await Promise.allSettled(watchers);

        // ── Collect ──────────────────────────────────────────────────────────
        const messages = useAppStore.getState().messages;
        const reply = [...messages].reverse().find(m => m.role === 'assistant')?.content ?? '';
        const payload = getCachedSwipePayload();
        const at = (e: string) => marks.find(m => m.event === e)?.t ?? null;
        const turnStart = at('hydrated') ?? 0;
        const firstVisible = firstVisibleToken === null ? null : Math.round(firstVisibleToken - t0);
        // The first streamed request is the story generation; everything before it is preparation.
        const storyIdx = modelRequests.findIndex(r => r.stream);
        const pre = storyIdx < 0 ? modelRequests : modelRequests.slice(0, storyIdx);
        const sum = (rs: ModelRequest[], f: (u: Usage) => number | undefined) => rs.reduce((n, r) => n + (r.usage ? f(r.usage) ?? 0 : 0), 0);
        const tokens = (rs: ModelRequest[]) => ({
            calls: rs.length,
            withUsage: rs.filter(r => r.usage).length,
            prompt: sum(rs, u => u.prompt_tokens),
            cacheHit: sum(rs, u => u.prompt_cache_hit_tokens),
            completion: sum(rs, u => u.completion_tokens),
            reasoning: sum(rs, u => u.completion_tokens_details?.reasoning_tokens),
        });
        const storyReq = storyIdx < 0 ? undefined : modelRequests[storyIdx];
        const failedRequests = modelRequests.filter(r => r.status !== undefined && (r.status < 200 || r.status >= 300));
        const record = {
            campaign: CAMPAIGN, probe: PROBE, input, arm: ARM, sample: SAMPLE, mock: MOCK,
            story: story?.label ?? '(preset default)', utility: utility?.label ?? '(preset default)',
            models: [...new Set(modelRequests.map(r => r.model).filter(Boolean))],
            appCommit: gitHead(),
            ranAt: new Date().toISOString(),
            enabledPreTokenModelFeatures: [...enabled],
            recommenderStandIn: enabled.has('recommender') ? null : recommenderStandIn,
            timing: {
                ttftMs: firstVisible === null ? null : firstVisible - turnStart,
                firstAnyTokenMs: firstToken === null ? null : Math.round(firstToken - t0) - turnStart,
                prepMs: storyReq ? storyReq.t - turnStart : null,
                storyThinkingMs: storyReq?.firstReasoningMs !== undefined && storyReq.firstContentMs !== undefined
                    ? storyReq.firstContentMs - storyReq.firstReasoningMs : null,
                directorMs: (at('director:done') ?? 0) - (at('director:running') ?? 0) || null,
                totalMs: (at('turn-done') ?? 0) - turnStart,
                gatherTrace,
                marks: marks.map(m => ({ ...m, t: m.t - turnStart })),
            },
            tokens: { preToken: tokens(pre), story: tokens(modelRequests.slice(Math.max(storyIdx, 0)).filter(r => r.stream)) },
            failedRequests: failedRequests.map(r => ({ status: r.status, model: r.model, head: r.head })),
            modelRequests: modelRequests.map(r => ({ ...r, t: r.t - turnStart })),
            trackedCalls: getCallHistory().map((c: any) => ({ label: c.label, endpoint: c.endpointName, status: c.status, durationMs: c.durationMs })),
            blockedWrites,
            payloadMessages: payload?.length ?? 0,
            payloadChars: JSON.stringify(payload ?? []).length,
            payloadTrace: lastPayloadTrace,
            payload,
            reply,
        };
        const outDir = path.join(HERE, 'work', RUNS_NAME, CAMPAIGN, PROBE);
        fs.mkdirSync(outDir, { recursive: true });
        // A provider error or an empty reply is not a result: tag it so the runner retries it.
        const failed = failedRequests.length > 0 || firstVisibleToken === null || !reply.trim();
        const tag = `${ARM}__${(story?.label ?? 'default').replace(/[^A-Za-z0-9.]+/g, '-')}__s${SAMPLE}${MOCK ? '__mock' : ''}${failed ? '__FAILED' : ''}`;
        fs.writeFileSync(path.join(outDir, `${tag}.json`), JSON.stringify(record, null, 2));
        clearPendingTurnSnapshot();
        const t = record.tokens.preToken;
        realLog(`[turn-harness] ${CAMPAIGN} ${PROBE} ${ARM} s${SAMPLE}: ttft=${record.timing.ttftMs}ms prep=${record.timing.prepMs}ms thinking=${record.timing.storyThinkingMs}ms total=${record.timing.totalMs}ms preTokenCalls=${t.calls} preTokenIn=${t.prompt} preTokenOut=${t.completion} blockedWrites=${blockedWrites.length} reply=${reply.length}ch → work/${RUNS_NAME}/${CAMPAIGN}/${PROBE}/${tag}.json`);
        if (failed) throw new Error(`Run failed: ${failedRequests.length} provider error(s) [${failedRequests.map(r => r.status).join(', ')}], reply ${reply.length} chars`);
    } finally {
        globalThis.fetch = realFetch;
        console.log = realLog;
    }
}, 900_000);

async function watchStream(body: ReadableStream<Uint8Array>, rec: ModelRequest, started: number): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const since = () => Math.round(performance.now() - started);
    let buffer = '';
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';
            for (const line of lines) {
                if (!line.startsWith('data:')) continue;
                const data = line.slice(5).trim();
                if (!data || data === '[DONE]') continue;
                let parsed: any;
                try { parsed = JSON.parse(data); } catch { continue; }
                if (parsed.usage) rec.usage = parsed.usage;
                const delta = parsed.choices?.[0]?.delta;
                if (rec.firstReasoningMs === undefined && (delta?.reasoning_content || delta?.reasoning)) rec.firstReasoningMs = since();
                if (rec.firstContentMs === undefined && delta?.content) rec.firstContentMs = since();
                const tcName = delta?.tool_calls?.[0]?.function?.name;
                if (tcName) rec.toolCall = tcName;
                if (parsed.choices?.[0]?.finish_reason) rec.finishReason = parsed.choices[0].finish_reason;
            }
        }
    } catch { /* the app aborted or the connection dropped; keep what we saw */ }
    rec.endMs = since();
}

function gitHead(): string | null {
    try {
        const head = execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim();
        const dirty = execSync('git status --porcelain -- src server', { encoding: 'utf8' }).trim();
        return dirty ? `${head}+dirty` : head;
    } catch { return null; }
}

function mockStream(): Response {
    const text = 'MOCK GM REPLY. The kettle cools as the scene continues.';
    const usage = { prompt_tokens: 1000, completion_tokens: 50, prompt_cache_hit_tokens: 800, prompt_cache_miss_tokens: 200, completion_tokens_details: { reasoning_tokens: 20 } };
    const body = [
        { choices: [{ delta: { reasoning_content: 'mock thinking' } }] },
        { choices: [{ delta: { content: text } }] },
        { choices: [], usage },
    ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mockToolStream(): Response {
    const call = { index: 0, id: 'call_mock_1', type: 'function', function: { name: 'query_campaign_lore', arguments: '{"query":"Therese Soll"}' } };
    const body = [
        { choices: [{ delta: { reasoning_content: 'I should check my notes.' } }] },
        { choices: [{ delta: { tool_calls: [call] }, finish_reason: 'tool_calls' }] },
    ].map(c => `data: ${JSON.stringify(c)}\n\n`).join('') + 'data: [DONE]\n\n';
    return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

function mockJson(): Response {
    return new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '{}' } }], usage: { prompt_tokens: 500, completion_tokens: 30 } }), {
        status: 200, headers: { 'content-type': 'application/json' },
    });
}
