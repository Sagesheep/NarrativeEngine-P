// ─── LLMRequestQueue ──────────────────────────────────────────────────────────
// Priority-ordered adaptive concurrency semaphore for LLM HTTP calls.
//
// Behaviour:
//   • Starts unbounded (maxConcurrent = Infinity) — all callers fire as fast
//     as the stagger allows; no artificial cap until the API tells us to stop.
//   • Stagger (default 500 ms) — enforces a minimum gap between consecutive
//     slot grants so bursts of simultaneous enqueues don't all hit the API
//     in the same millisecond.
//   • On 429/503/529 the caller invokes onRateLimitHit(), which lowers maxConcurrent
//     to (inflight − 1).  Subsequent acquireSlot() calls block until a slot
//     is freed by a completing call — completion-driven, not timer-driven.
//   • Recovery — after RECOVERY_WINDOW_MS of quiet (no new rate-limit hits),
//     maxConcurrent increments by 1.  For originally-unbounded queues, once it
//     climbs back to INFINITY_RECOVERY_CAP the cap is fully lifted.
//   • Priority — when multiple callers are waiting, highest priority is served
//     first (high > normal > low).  FIFO within the same priority tier.
//
// Usage:
//   await llmQueue.acquireSlot('high');
//   try { ... } finally { llmQueue.releaseSlot(); }

export type LLMCallPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<LLMCallPriority, number> = { high: 2, normal: 1, low: 0 };

// How long (ms) without a rate-limit hit before recovering +1 concurrency slot.
const RECOVERY_WINDOW_MS = 60_000;
// When an originally-unbounded queue recovers to this level, lift the cap fully.
const INFINITY_RECOVERY_CAP = 10;

type Waiter = { priority: LLMCallPriority; wake: () => void };

export class LLMRequestQueue {
    private inflight = 0;
    private maxConcurrent: number;
    private readonly initialMaxConcurrent: number;
    private queue: Waiter[] = [];
    private lastFireTime = 0;
    private readonly staggerMs: number;
    private scheduled = false;
    private recoveryTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(staggerMs = 500, maxConcurrentOverride?: number) {
        this.staggerMs = staggerMs;
        this.maxConcurrent = maxConcurrentOverride ?? Infinity;
        this.initialMaxConcurrent = this.maxConcurrent;
    }

    // ── Public API ────────────────────────────────────────────────────────────

    /**
     * Wait until a slot is available, then occupy it.
     * The returned Promise resolves when it is safe to fire the HTTP call.
     */
    acquireSlot(priority: LLMCallPriority = 'normal'): Promise<void> {
        return new Promise<void>(resolve => {
            const waiter: Waiter = {
                priority,
                wake: () => { this.inflight++; resolve(); },
            };
            // Insert in priority order; FIFO within the same tier
            const idx = this.queue.findIndex(
                w => PRIORITY_ORDER[w.priority] < PRIORITY_ORDER[priority]
            );
            if (idx === -1) this.queue.push(waiter);
            else this.queue.splice(idx, 0, waiter);

            this.scheduleDrain();
        });
    }

    /**
     * Free the occupied slot.  Always call this — in a finally block —
     * after the HTTP call completes (success, error, or abort).
     */
    releaseSlot(): void {
        this.inflight = Math.max(0, this.inflight - 1);
        this.scheduleDrain();
    }

    /**
     * Notify the queue that a 429/529 was received while `inflight` slots were
     * occupied.  Reduces maxConcurrent to inflight − 1 so future callers
     * wait for completions instead of firing immediately.  Resets the recovery
     * clock so the quiet-period countdown restarts from now.
     */
    onRateLimitHit(): void {
        const cap = Math.max(1, this.inflight - 1);
        if (cap < this.maxConcurrent) {
            this.maxConcurrent = cap;
            console.warn(
                `[LLMQueue] Rate limit — concurrency cap reduced to ${this.maxConcurrent}`
            );
        }
        this.scheduleRecovery();
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private scheduleRecovery(): void {
        // Local queues start at 1 and can't go lower — no recovery needed.
        if (this.initialMaxConcurrent <= 1) return;
        // Already at the initial cap.
        if (this.maxConcurrent >= this.initialMaxConcurrent) return;

        if (this.recoveryTimer !== null) clearTimeout(this.recoveryTimer);

        this.recoveryTimer = setTimeout(() => {
            this.recoveryTimer = null;

            // For originally-unbounded queues: once we reach INFINITY_RECOVERY_CAP,
            // lift the cap fully rather than incrementing forever.
            if (this.initialMaxConcurrent === Infinity && this.maxConcurrent >= INFINITY_RECOVERY_CAP) {
                this.maxConcurrent = Infinity;
                console.log(`[LLMQueue] Concurrency cap fully restored (unbounded)`);
                this.scheduleDrain();
                return;
            }

            this.maxConcurrent += 1;
            console.log(`[LLMQueue] Concurrency cap recovered to ${this.maxConcurrent}`);
            this.scheduleDrain();

            // Keep recovering if still below the initial cap.
            if (this.maxConcurrent < this.initialMaxConcurrent) this.scheduleRecovery();
        }, RECOVERY_WINDOW_MS);
    }

    private scheduleDrain(): void {
        // Only one pending setTimeout at a time
        if (this.scheduled) return;
        if (this.queue.length === 0 || this.inflight >= this.maxConcurrent) return;

        // Stagger only while a rate limit is actually in force.
        //
        // The gap exists so a burst of enqueues does not hit a provider in the
        // same millisecond. But it was applied unconditionally, including on a
        // queue with no cap at all — so the context gather, which fires five or
        // six utility calls at once through one endpoint queue, had them
        // granted 500 ms apart. Measured at ~2.5 s of dead wait per turn,
        // protecting against nothing: no provider had asked us to slow down.
        //
        // Once `onRateLimitHit` lowers the cap, the provider HAS asked, and the
        // stagger applies until recovery restores the initial cap.
        const throttled = this.maxConcurrent !== this.initialMaxConcurrent;
        const sinceLastFire = Date.now() - this.lastFireTime;
        const delay = throttled ? Math.max(0, this.staggerMs - sinceLastFire) : 0;

        this.scheduled = true;
        setTimeout(() => {
            this.scheduled = false;
            // Re-check conditions after the wait (they may have changed)
            if (this.queue.length > 0 && this.inflight < this.maxConcurrent) {
                const waiter = this.queue.shift()!;
                this.lastFireTime = Date.now();
                waiter.wake(); // also increments inflight
                this.scheduleDrain(); // set up the next firing
            }
        }, delay);
    }
}

// ── Per-endpoint queue registry ───────────────────────────────────────────────
// Each unique endpoint base URL gets its own queue, so roles sharing the same
// endpoint coordinate adaptive throttling together (e.g. two roles on the same
// KoboldCPP instance share one queue rather than racing independently).
//
// Local endpoints (localhost / RFC-1918) start at maxConcurrent=1 since local
// LLM servers are typically single-threaded.  Cloud endpoints start unbounded
// and rely on adaptive 429/529 reduction + recovery.

function normalizeEndpointKey(raw: string): string {
    const s = raw.trim();
    if (!s) return '__fallback__';
    try {
        const u = new URL(s.includes('://') ? s : 'http://' + s);
        return `${u.protocol}//${u.host}`.toLowerCase();
    } catch {
        return s.toLowerCase();
    }
}

function isLocalEndpoint(raw: string): boolean {
    try {
        const u = new URL(raw.includes('://') ? raw : 'http://' + raw);
        const h = u.hostname;
        return (
            h === 'localhost' ||
            h === '127.0.0.1' ||
            h === '::1' ||
            /^127\./.test(h) ||
            /^10\./.test(h) ||
            /^192\.168\./.test(h) ||
            /^172\.(1[6-9]|2\d|3[01])\./.test(h)
        );
    } catch {
        return false;
    }
}

const _endpointQueues = new Map<string, LLMRequestQueue>();

export function getQueueForEndpoint(endpoint: string): LLMRequestQueue {
    const key = normalizeEndpointKey(endpoint);
    if (!_endpointQueues.has(key)) {
        const local = isLocalEndpoint(endpoint);
        const q = local ? new LLMRequestQueue(500, 1) : new LLMRequestQueue(500);
        console.log(`[LLMQueue] New queue for "${key}" — ${local ? 'local (maxConcurrent=1)' : 'cloud (unbounded)'}`);
        _endpointQueues.set(key, q);
    }
    return _endpointQueues.get(key)!;
}

// ── Legacy singleton (kept for backward compatibility) ────────────────────────
export const llmQueue = getQueueForEndpoint('__legacy__');
