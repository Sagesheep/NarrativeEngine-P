import { beforeEach, describe, expect, it } from 'vitest';
import {
    createSandboxFaultPolicy,
    createSandboxFaultStore,
    formatSandboxFaultReason,
} from '../sandboxFaults';
import { SANDBOX_FAULT_STRIKES } from '../sandboxTypes';

describe('sandbox fault taxonomy and store', () => {
    it('formats the decided reason shapes with the mod name and meaningful limit', () => {
        expect(formatSandboxFaultReason({
            modName: 'Arc',
            kind: 'deadline',
            message: '[sandbox] deadline exceeded (5000 ms)',
            deadlineMs: 5000,
        })).toBe('Arc: deadline exceeded (5000 ms); disabled for remainder of turn');
        expect(formatSandboxFaultReason({
            modName: 'Arc',
            kind: 'journal-rejected',
            message: '[sandbox] journal rejected: undeclared write "addMessage"',
        })).toBe("Arc: undeclared write 'addMessage'; no changes applied; disabled for remainder of turn");
        expect(formatSandboxFaultReason({
            modName: 'Arc',
            kind: 'flood',
            message: '[sandbox] inbound message cap exceeded (1000)',
        })).toBe('Arc: flood (1000 inbound messages); disabled for remainder of turn');
    });

    it('upserts one user-facing fault record per file and notifies subscribers', () => {
        const store = createSandboxFaultStore();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => { notifications += 1; });

        store.add({ modId: 'arc', file: 'arc.mod.json', kind: 'threw', strikes: 1, latched: false, reason: 'Arc: threw (bad)' });
        store.add({ modId: 'arc', file: 'arc.mod.json', kind: 'deadline', strikes: 2, latched: false, reason: 'Arc: deadline exceeded (5000 ms)' });

        expect(store.getFaults()).toEqual([{ file: 'arc.mod.json', reason: 'Arc: deadline exceeded (5000 ms)' }]);
        expect(store.getRecords()[0]).toMatchObject({ kind: 'deadline', strikes: 2 });
        expect(notifications).toBe(2);
        unsubscribe();
    });
});

describe('sandbox fault policy', () => {
    let store: ReturnType<typeof createSandboxFaultStore>;
    let policy: ReturnType<typeof createSandboxFaultPolicy>;
    const turnOne = {};
    const turnTwo = {};

    beforeEach(() => {
        store = createSandboxFaultStore();
        policy = createSandboxFaultPolicy(store);
    });

    it('disables a mod for the current turn and resets that set for a new turn', () => {
        expect(policy.canRun('arc', turnOne)).toBe(true);
        policy.recordFault({ modId: 'arc', modName: 'Arc', file: 'arc.mod.json', kind: 'threw', message: 'boom', turnKey: turnOne });
        expect(policy.canRun('arc', turnOne)).toBe(false);
        expect(policy.canRun('arc', turnTwo)).toBe(true);
    });

    it('latches after the named number of consecutive faulted runs', () => {
        for (let index = 0; index < SANDBOX_FAULT_STRIKES; index += 1) {
            const turn = {};
            policy.recordFault({ modId: 'arc', modName: 'Arc', file: 'arc.mod.json', kind: 'worker-error', message: 'gone', turnKey: turn });
        }

        expect(policy.getStrikes('arc')).toBe(SANDBOX_FAULT_STRIKES);
        expect(policy.isLatched('arc')).toBe(true);
        expect(policy.canRun('arc', {})).toBe(false);
        expect(store.getRecords()[0]).toMatchObject({ latched: true, strikes: SANDBOX_FAULT_STRIKES });
    });

    it('clears consecutive strikes after a clean run', () => {
        const first = {};
        const second = {};
        policy.recordFault({ modId: 'arc', modName: 'Arc', file: 'arc.mod.json', kind: 'threw', message: 'boom', turnKey: first });
        expect(policy.getStrikes('arc')).toBe(1);
        policy.recordSuccess('arc', second);
        expect(policy.getStrikes('arc')).toBe(0);
        expect(policy.isLatched('arc')).toBe(false);
    });
});
