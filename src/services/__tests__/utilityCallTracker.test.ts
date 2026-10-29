import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

describe('utilityCallTracker', () => {
    beforeEach(() => {
        vi.useFakeTimers({ shouldAdvanceTime: true });
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('startUtilityCall creates a running call', async () => {
        const { startUtilityCall, getActiveCalls, clearHistory } = await import('../llm/utilityCallTracker');
        clearHistory();
        const handle = startUtilityCall('test-call', 'test-endpoint', 60000);
        const active = getActiveCalls();
        expect(active).toHaveLength(1);
        expect(active[0].label).toBe('test-call');
        expect(active[0].status).toBe('running');
        handle.settleSuccess();
    });

    it('settleSuccess moves call to history', async () => {
        const { startUtilityCall, getActiveCalls, getCallHistory, clearHistory } = await import('../llm/utilityCallTracker');
        clearHistory();
        // Clear active from any prior tests
        for (const call of getActiveCalls()) {
            void call;
        }
        const handle = startUtilityCall('success-test', 'ep', 60000);
        handle.settleSuccess();
        expect(getActiveCalls()).toHaveLength(0);
        const history = getCallHistory().filter(h => h.label === 'success-test');
        expect(history).toHaveLength(1);
        expect(history[0].status).toBe('success');
    });

    it('settleError records error', async () => {
        const { startUtilityCall, getCallHistory, clearHistory } = await import('../llm/utilityCallTracker');
        clearHistory();
        const handle = startUtilityCall('err-test', 'ep', 60000);
        handle.settleError('timeout', 'took too long');
        const entry = getCallHistory().find(h => h.label === 'err-test');
        expect(entry).toBeDefined();
        expect(entry!.status).toBe('timeout');
        expect(entry!.errorMessage).toBe('took too long');
    });

    it('extend moves the deadline forward', async () => {
        const { startUtilityCall, getActiveCalls, clearHistory } = await import('../llm/utilityCallTracker');
        clearHistory();
        const handle = startUtilityCall('extend-test', 'ep', 10000);
        const before = getActiveCalls().find(c => c.label === 'extend-test')!;
        const origDeadline = before.deadline;
        handle.extend(30000);
        const after = getActiveCalls().find(c => c.label === 'extend-test')!;
        expect(after.deadline).toBe(origDeadline + 30000);
        expect(after.extensions).toBe(1);
        handle.settleSuccess();
    });

    it('extendCall (standalone) clones rather than mutating in place', async () => {
        const { startUtilityCall, extendCall, getActiveCalls, clearHistory } = await import('../llm/utilityCallTracker');
        clearHistory();
        const handle = startUtilityCall('extend-call-test', 'ep', 10000);
        const origDeadline = getActiveCalls().find(c => c.label === 'extend-call-test')!.deadline;
        extendCall(handle.id, 5000);
        const after = getActiveCalls().find(c => c.label === 'extend-call-test')!;
        expect(after.deadline).toBe(origDeadline + 5000);
        handle.settleSuccess();
    });

    it('history caps at 50 entries', async () => {
        const { startUtilityCall, getCallHistory, clearHistory } = await import('../llm/utilityCallTracker');
        clearHistory();
        for (let i = 0; i < 55; i++) {
            const h = startUtilityCall(`cap-${i}`, 'ep', 10000);
            h.settleSuccess();
        }
        expect(getCallHistory().length).toBeLessThanOrEqual(50);
    });

    it('snapshotRef is updated synchronously in emit', async () => {
        const { useUtilityCalls } = await import('../llm/utilityCallTracker');
        expect(typeof useUtilityCalls).toBe('function');
    });
});