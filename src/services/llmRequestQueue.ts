// ─── LLMRequestQueue ──────────────────────────────────────────────────────────
// Priority-ordered adaptive concurrency semaphore for LLM HTTP calls.
//
// Behaviour:
//   • Starts unbounded (maxConcurrent = Infinity) — all callers fire as fast
//     as the stagger allows; no artificial cap until the API tells us to stop.
//   • Stagger (default 500 ms) — enforces a minimum gap between consecutive
//     slot grants so bursts of simultaneous enqueues don't all hit the API
//     in the same millisecond.
//   • On 429 the caller invokes onRateLimitHit(), which lowers maxConcurrent
//     to (inflight − 1).  Subsequent acquireSlot() calls block until a slot
//     is freed by a completing call — completion-driven, not timer-driven.
//   • Priority — when multiple callers are waiting, highest priority is served
//     first (high > normal > low).  FIFO within the same priority tier.
//
// Usage:
//   await llmQueue.acquireSlot('high');
//   try { ... } finally { llmQueue.releaseSlot(); }

export type LLMCallPriority = 'high' | 'normal' | 'low';

const PRIORITY_ORDER: Record<LLMCallPriority, number> = { high: 2, normal: 1, low: 0 };

type Waiter = { priority: LLMCallPriority; wake: () => void };

export class LLMRequestQueue {
    private inflight = 0;
    private maxConcurrent = Infinity;
    private queue: Waiter[] = [];
    private lastFireTime = 0;
    private readonly staggerMs: number;
    private scheduled = false;

    constructor(staggerMs = 500) {
        this.staggerMs = staggerMs;
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
     * Notify the queue that a 429 was received while `inflight` slots were
     * occupied.  Reduces maxConcurrent to inflight − 1 so future callers
     * wait for completions instead of firing immediately.
     */
    onRateLimitHit(): void {
        const cap = Math.max(1, this.inflight - 1);
        if (cap < this.maxConcurrent) {
            this.maxConcurrent = cap;
            console.warn(
                `[LLMQueue] 429 rate limit — concurrency cap set to ${this.maxConcurrent}`
            );
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    private scheduleDrain(): void {
        // Only one pending setTimeout at a time
        if (this.scheduled) return;
        if (this.queue.length === 0 || this.inflight >= this.maxConcurrent) return;

        const sinceLastFire = Date.now() - this.lastFireTime;
        const delay = Math.max(0, this.staggerMs - sinceLastFire);

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

// ── Singleton ─────────────────────────────────────────────────────────────────
// All non-streaming LLM calls share this one queue so they coordinate across
// service boundaries (contextRecommender, inventoryParser, etc.).

export const llmQueue = new LLMRequestQueue();
