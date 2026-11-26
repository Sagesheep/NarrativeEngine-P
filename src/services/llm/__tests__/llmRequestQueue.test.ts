import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { LLMRequestQueue } from '../llmRequestQueue';

/**
 * The per-endpoint concurrency semaphore every LLM call passes through.
 *
 * `AI_CODEBASE_MAP.md` lists it in the blast-radius matrix under "network
 * deadlocks" and "rate-limit recovery misfires", and it had no test file at
 * all. These pin the behaviour that matters: slots are granted in priority
 * order, never above the cap, the cap falls on a rate limit and climbs back
 * during quiet, and an unbounded queue does not add latency of its own.
 */

beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

/** Resolve pending timers and microtasks until nothing more is waiting. */
async function settle(): Promise<void> {
    await vi.advanceTimersByTimeAsync(0);
}

/**
 * Take a slot, advancing fake timers so the queue's internal drain timer can
 * fire. Awaiting `acquireSlot()` directly would deadlock: the promise only
 * settles once a timer runs, and nothing advances the clock while we wait.
 */
async function take(q: LLMRequestQueue, priority?: 'high' | 'normal' | 'low'): Promise<void> {
    const p = priority ? q.acquireSlot(priority) : q.acquireSlot();
    await vi.advanceTimersByTimeAsync(1000);
    await p;
}

describe('LLMRequestQueue — slot granting', () => {
    it('grants the first slot without waiting', async () => {
        const q = new LLMRequestQueue();
        let granted = false;
        q.acquireSlot().then(() => { granted = true; });
        await settle();
        expect(granted).toBe(true);
    });

    it('grants concurrent slots to an unbounded queue without staggering them', async () => {
        // The context gather fires several utility calls at once and they all
        // share one endpoint queue. Serialising them here is pure dead wait:
        // there is no rate limit in effect, so nothing is being protected.
        const q = new LLMRequestQueue();
        const granted: number[] = [];
        for (let i = 0; i < 6; i++) q.acquireSlot().then(() => granted.push(i));

        // Each grant still costs a tick, but not a 500 ms one. Staggered, six
        // slots would take 2.5 s and only the first would be granted here.
        await vi.advanceTimersByTimeAsync(50);
        expect(granted).toEqual([0, 1, 2, 3, 4, 5]);
    });

    it('never exceeds an explicit concurrency cap', async () => {
        const q = new LLMRequestQueue(500, 1);
        const granted: number[] = [];
        for (let i = 0; i < 3; i++) q.acquireSlot().then(() => granted.push(i));

        await vi.advanceTimersByTimeAsync(5000);
        expect(granted).toEqual([0]);

        q.releaseSlot();
        await vi.advanceTimersByTimeAsync(5000);
        expect(granted).toEqual([0, 1]);
    });

    it('releases a slot back to a waiter', async () => {
        const q = new LLMRequestQueue(500, 1);
        let second = false;
        await take(q);
        q.acquireSlot().then(() => { second = true; });

        await vi.advanceTimersByTimeAsync(2000);
        expect(second).toBe(false);

        q.releaseSlot();
        await vi.advanceTimersByTimeAsync(2000);
        expect(second).toBe(true);
    });
});

describe('LLMRequestQueue — priority', () => {
    it('serves higher priority first', async () => {
        const q = new LLMRequestQueue(500, 1);
        const order: string[] = [];
        await take(q, 'normal');            // occupies the only slot

        q.acquireSlot('low').then(() => order.push('low'));
        q.acquireSlot('normal').then(() => order.push('normal'));
        q.acquireSlot('high').then(() => order.push('high'));

        for (let i = 0; i < 3; i++) {
            q.releaseSlot();
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(order).toEqual(['high', 'normal', 'low']);
    });

    it('is FIFO within one priority tier', async () => {
        const q = new LLMRequestQueue(500, 1);
        const order: string[] = [];
        await take(q, 'normal');

        q.acquireSlot('normal').then(() => order.push('first'));
        q.acquireSlot('normal').then(() => order.push('second'));

        for (let i = 0; i < 2; i++) {
            q.releaseSlot();
            await vi.advanceTimersByTimeAsync(1000);
        }
        expect(order).toEqual(['first', 'second']);
    });
});

describe('LLMRequestQueue — rate limiting and recovery', () => {
    it('caps concurrency below the number in flight on a rate limit', async () => {
        const q = new LLMRequestQueue();
        await take(q);
        await take(q);
        await take(q);            // 3 in flight

        q.onRateLimitHit();               // cap becomes 2

        let fourth = false;
        q.acquireSlot().then(() => { fourth = true; });
        await vi.advanceTimersByTimeAsync(2000);
        expect(fourth).toBe(false);       // 3 in flight is already over the cap

        q.releaseSlot();
        q.releaseSlot();                  // down to 1 in flight
        await vi.advanceTimersByTimeAsync(2000);
        expect(fourth).toBe(true);
    });

    it('never caps below one', async () => {
        const q = new LLMRequestQueue();
        await take(q);
        q.onRateLimitHit();               // inflight - 1 would be 0

        q.releaseSlot();
        let next = false;
        q.acquireSlot().then(() => { next = true; });
        await vi.advanceTimersByTimeAsync(2000);
        expect(next).toBe(true);
    });

    it('recovers a slot after a quiet period', async () => {
        const q = new LLMRequestQueue();
        await take(q);
        await take(q);
        q.onRateLimitHit();               // cap 1
        q.releaseSlot();
        q.releaseSlot();                  // 0 in flight, cap 1

        await take(q);            // fills the cap
        let blocked = false;
        q.acquireSlot().then(() => { blocked = true; });
        await vi.advanceTimersByTimeAsync(5000);
        expect(blocked).toBe(false);

        // 60s of quiet lifts the cap by one.
        await vi.advanceTimersByTimeAsync(60_000);
        expect(blocked).toBe(true);
    });

    it('a local queue stays at one and schedules no recovery', async () => {
        const q = new LLMRequestQueue(500, 1);
        await take(q);
        q.onRateLimitHit();

        let second = false;
        q.acquireSlot().then(() => { second = true; });
        await vi.advanceTimersByTimeAsync(120_000);
        expect(second).toBe(false);       // still held; only a release frees it

        q.releaseSlot();
        await vi.advanceTimersByTimeAsync(1000);
        expect(second).toBe(true);
    });
});
