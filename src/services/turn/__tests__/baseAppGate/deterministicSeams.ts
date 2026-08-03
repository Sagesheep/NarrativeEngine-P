// Phase 0.5 — Deterministic seams for the base-app gate.
//
// All non-determinism that enters the turn pipeline is controlled here. The
// gate's rule (Phase 0.5 §2) is fixed time, IDs, dice, provider stream,
// API/network replies, and queue scheduling. Nothing in this file adds a
// production-only test branch or bypasses normal orchestration — it injects
// at existing seams (Date.now, Math.random, fetch, setTimeout, the background
// queue, the LLM request queue's stagger timer).
//
// The seams are installed once per canonical-turn run and removed afterward.
// They are NOT global vi.mocks: the gate runs the REAL runTurn, the REAL
// buildPayload, the REAL runPostTurnPipeline, the REAL pendingCommit, and the
// REAL post-turn tracks. Only the I/O boundaries are pinned.

type Restore = () => void;

const FIXED_NOW = 1_700_000_000_000;
const NOW_TICK_MS = 1; // each Date.now() call advances by 1 ms so ordered timestamps are stable + monotonic

export function installDeterministicClock(): Restore {
    const realDateNow = Date.now;
    const realDate = globalThis.Date;
    let ticks = 0;
    Date.now = function now(): number {
        return FIXED_NOW + (ticks++ * NOW_TICK_MS);
    };
    // Stamp a fixed Date constructor so `new Date()` is also deterministic.
    // Preserve static methods (UTC, now, parse, parse) by reusing the real
    // class with an overridden constructor.
    const FixedDate = function (this: Date, ...args: unknown[]) {
        if (args.length === 0) {
            return new realDate(FIXED_NOW + (ticks++ * NOW_TICK_MS));
        }
        // @ts-expect-error — spread into the real constructor; we don't gate the gate on exotic signatures
        return new realDate(...args);
    } as unknown as DateConstructor;
    FixedDate.now = Date.now;
    FixedDate.UTC = realDate.UTC;
    FixedDate.parse = realDate.parse;
    globalThis.Date = FixedDate;
    return () => {
        Date.now = realDateNow;
        globalThis.Date = realDate;
    };
}

// Deterministic Math.random — a seeded LCG. The gate does not care WHICH
// values come back (dice, hex rolls, reaction menu, agency, repression) — it
// cares that the SAME values come back every run. A fixed sequence is the
// point, not a normalization.
const LCG_A = 1664525;
const LCG_C = 1013904223;
const LCG_M = 2 ** 31;

export function installDeterministicMathRandom(seed = 12345): Restore {
    const realRandom = Math.random;
    let state = seed >>> 0;
    Math.random = function random(): number {
        state = (LCG_A * state + LCG_C) % LCG_M;
        return state / LCG_M;
    };
    return () => { Math.random = realRandom; };
}

// Deterministic setTimeout — fires callbacks on the next microtask (queueMicrotask)
// so `await queue.acquireSlot()` and other timer-gated awaits resolve deterministically
// without anyone calling a drain function. The delay argument is ignored: the gate
// runs in zero wall-clock time, so 500 ms staggers and 800 ms tool-call backoffs all
// fire as soon as the current synchronous code yields.
//
// We also expose `drainTimers` for the few setTimeouts that are scheduled AFTER the
// orchestrator's await returns (e.g. the post-turn pipeline's backgroundQueue.push
// closures use setTimeout indirectly via async/await microtasks, not real timers —
// but defensive draining catches anything that does schedule a real timer).
type Timer = { cb: () => void; seq: number };
let pendingTimers: Timer[] = [];
let timerSeq = 0;
let microtaskScheduled = false;

function flushPending(): void {
    microtaskScheduled = false;
    while (pendingTimers.length > 0) {
        const batch = pendingTimers.slice().sort((a, b) => a.seq - b.seq);
        pendingTimers = [];
        for (const t of batch) {
            try { t.cb(); } catch (e) { console.warn('[deterministic setTimeout] timer threw:', e); }
        }
    }
}

function scheduleFlush(): void {
    if (microtaskScheduled) return;
    microtaskScheduled = true;
    queueMicrotask(flushPending);
}

export function installDeterministicTimers(): Restore {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    pendingTimers = [];
    timerSeq = 0;
    microtaskScheduled = false;
    // @ts-expect-error — minimal signature; the orchestrator only passes a callback + delay
    globalThis.setTimeout = function (cb: () => void): ReturnType<typeof setTimeout> {
        const seq = timerSeq++;
        pendingTimers.push({ cb, seq });
        scheduleFlush();
        return seq as unknown as ReturnType<typeof setTimeout>;
    };
    // @ts-expect-error — minimal: clearing a pending timer removes it from the queue
    globalThis.clearTimeout = function (handle?: number): void {
        if (typeof handle === 'number') {
            pendingTimers = pendingTimers.filter(t => t.seq !== handle);
        }
    };
    return () => {
        globalThis.setTimeout = realSetTimeout;
        globalThis.clearTimeout = realClearTimeout;
        pendingTimers = [];
    };
}

/** Fire any remaining timers synchronously. Re-entrant: a timer that schedules
 *  another timer enqueues it and it is drained on the next call. */
export function drainTimers(): void {
    while (pendingTimers.length > 0) {
        const batch = pendingTimers.slice().sort((a, b) => a.seq - b.seq);
        pendingTimers = [];
        for (const t of batch) {
            try { t.cb(); } catch (e) { console.warn('[deterministic setTimeout] drain timer threw:', e); }
        }
    }
}

export function pendingTimerCount(): number {
    return pendingTimers.length;
}

// ── Mock fetch ──────────────────────────────────────────────────────────
// Every network reply the turn + post-turn pipeline can issue is captured
// here. The gate never reaches the network. Routes are matched by URL prefix
// so the apiClient and llmFetch seams both flow through one place.

export type FetchRoute = {
    match: (url: string, init?: RequestInit) => boolean;
    respond: (url: string, init?: RequestInit) => Promise<Response>;
};

export type FetchLog = {
    url: string;
    method: string;
    body: unknown;
};

export function installMockFetch(routes: FetchRoute[], log: FetchLog[]): Restore {
    const realFetch = globalThis.fetch;
    // @ts-expect-error — minimal Response shape; gate routes return full objects
    globalThis.fetch = async function (url: string, init?: RequestInit): Promise<Response> {
        const urlStr = String(url);
        const method = (init?.method ?? 'GET').toUpperCase();
        let body: unknown = undefined;
        if (init?.body) {
            try { body = JSON.parse(String(init.body)); } catch { body = String(init.body); }
        }
        log.push({ url: urlStr, method, body });
        for (const r of routes) {
            if (r.match(urlStr, init)) return r.respond(urlStr, init);
        }
        // Unmatched fetch — return a 404 so a missing seam surfaces as a
        // traceable failure rather than a hang.
        // @ts-expect-error — synthetic Response
        return { ok: false, status: 404, json: async () => ({ error: `unmatched fetch: ${urlStr}` }), text: async () => `unmatched fetch: ${urlStr}` } as Response;
    };
    return () => { globalThis.fetch = realFetch; };
}

// ── uid override ────────────────────────────────────────────────────────
// The orchestrator and post-turn tracks stamp messages, swipe variants, and
// tool messages with uid(). The real uid is `Date.now().toString(36) +
// Math.random()...`, so the deterministic clock + Math.random seams already
// pin it — but only if the import resolves to the live `uid`. The seam below
// makes the value a fixed counter so the trace is byte-stable across Node
// versions, locales, and Math.random implementations.

export function installDeterministicUid(uidModule: { uid: () => string }): Restore {
    const real = uidModule.uid;
    let n = 0;
    uidModule.uid = function (): string {
        n += 1;
        return `uid-${String(n).padStart(4, '0')}`;
    };
    return () => { uidModule.uid = real; };
}