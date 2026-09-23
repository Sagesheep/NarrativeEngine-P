import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withCampaignLock } from '../lib/writeLock.js';

// The two properties this file exists to protect. Both were live bugs: a
// rejected lock promise raised unhandledRejection (killing the process even
// when the route caught the error), and it short-circuited every operation
// queued behind the failure.

let errorSpy;

beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    errorSpy.mockRestore();
});

describe('withCampaignLock', () => {
    it('serializes operations for the same campaign', async () => {
        const order = [];
        await Promise.all([
            withCampaignLock('c1', async () => {
                order.push('a:start');
                await new Promise((r) => setTimeout(r, 20));
                order.push('a:end');
            }),
            withCampaignLock('c1', async () => {
                order.push('b:start');
                order.push('b:end');
            }),
        ]);
        expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
    });

    it('runs operations for different campaigns concurrently', async () => {
        let bStartedBeforeAEnded = false;
        let aEnded = false;
        await Promise.all([
            withCampaignLock('c1', async () => {
                await new Promise((r) => setTimeout(r, 20));
                aEnded = true;
            }),
            withCampaignLock('c2', async () => {
                bStartedBeforeAEnded = !aEnded;
            }),
        ]);
        expect(bStartedBeforeAEnded).toBe(true);
    });

    it('returns the operation result to the caller', async () => {
        await expect(withCampaignLock('c1', () => 42)).resolves.toBe(42);
    });

    it('rejects to the caller when the operation throws', async () => {
        await expect(
            withCampaignLock('c1', () => { throw new Error('disk full'); }),
        ).rejects.toThrow('disk full');
    });

    it('still runs operations queued behind a failed one', async () => {
        const ran = [];
        const results = await Promise.allSettled([
            withCampaignLock('c1', async () => { ran.push('op1'); throw new Error('disk full'); }),
            withCampaignLock('c1', async () => { ran.push('op2'); }),
            withCampaignLock('c1', async () => { ran.push('op3'); }),
        ]);

        // The failure is confined to its own operation.
        expect(ran).toEqual(['op1', 'op2', 'op3']);
        expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    });

    it('does not leave an unhandled rejection when an operation fails', async () => {
        const unhandled = [];
        const onUnhandled = (err) => unhandled.push(err);
        process.on('unhandledRejection', onUnhandled);
        try {
            // The caller handles the rejection, which is all that should be
            // required. Nothing inside the lock may create a second, orphaned
            // rejected promise.
            await withCampaignLock('c1', async () => { throw new Error('disk full'); })
                .catch(() => {});
            await new Promise((r) => setTimeout(r, 50));
        } finally {
            process.off('unhandledRejection', onUnhandled);
        }
        expect(unhandled).toEqual([]);
    });

    it('logs the failure once', async () => {
        await withCampaignLock('c1', async () => { throw new Error('disk full'); }).catch(() => {});
        expect(errorSpy).toHaveBeenCalledTimes(1);
        expect(String(errorSpy.mock.calls[0][0])).toContain('c1');
    });

    it('cleans up its lock entry once the chain settles', async () => {
        await withCampaignLock('c-cleanup', () => 'done');
        await new Promise((r) => setTimeout(r, 10));
        // A later call must start from a resolved chain, not a retained one.
        await expect(withCampaignLock('c-cleanup', () => 'again')).resolves.toBe('again');
    });
});
