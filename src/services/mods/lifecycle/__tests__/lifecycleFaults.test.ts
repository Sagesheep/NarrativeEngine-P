/**
 * Phase 1.4 — lifecycle fault store and reason formatter tests.
 *
 * Mirrors `sandboxFaults.test.ts`: pins the user-facing reason shapes so the
 * Extensions UI contract does not drift, and verifies the store's
 * one-record-per-mod upsert and subscriber notification.
 */
import { describe, expect, it } from 'vitest';
import {
    createLifecycleFaultStore,
    formatLifecycleFaultReason,
    LIFECYCLE_DEADLINE_MS,
} from '../lifecycleFaults';

describe('lifecycle fault reason formatter', () => {
    it('formats a threw fault with the mod name and hook', () => {
        expect(formatLifecycleFaultReason({
            modName: 'Arc',
            kind: 'threw',
            hook: 'activate',
            message: 'cannot read props of undefined',
        })).toBe('Arc: hook "activate" threw (cannot read props of undefined)');
    });

    it('formats a deadline fault with the configured millisecond budget', () => {
        expect(formatLifecycleFaultReason({
            modName: 'Arc',
            kind: 'deadline',
            hook: 'activate',
            message: '[lifecycle] deadline exceeded (5000 ms)',
        })).toBe(`Arc: hook "activate" deadline exceeded (${LIFECYCLE_DEADLINE_MS} ms)`);
    });

    it('formats a missing-export fault', () => {
        expect(formatLifecycleFaultReason({
            modName: 'Arc',
            kind: 'missing-export',
            hook: 'activate',
            message: 'export "onActivate" not found',
        })).toBe('Arc: hook "activate" named a missing export (export "onActivate" not found)');
    });

    it('formats a load fault without a hook prefix (load is not a hook run)', () => {
        expect(formatLifecycleFaultReason({
            modName: 'Arc',
            kind: 'load',
            hook: 'load',
            message: 'syntax error at line 4',
        })).toBe('Arc: load (syntax error at line 4)');
    });

    it('formats a disabled-dep fault naming the disabled dependency', () => {
        expect(formatLifecycleFaultReason({
            modName: 'Skill Tree',
            kind: 'disabled-dep',
            hook: 'activate',
            message: 'dependency "arc" is disabled',
        })).toBe('Skill Tree: hook "activate" skipped — dependency "arc" is disabled');
    });

    it('strips the [lifecycle] prefix from messages before rendering', () => {
        expect(formatLifecycleFaultReason({
            modName: 'Arc',
            kind: 'threw',
            hook: 'install',
            message: '[lifecycle] boom',
        })).toBe('Arc: hook "install" threw (boom)');
    });
});

describe('lifecycle fault store', () => {
    it('upserts one user-facing fault record per mod id and notifies subscribers', () => {
        const store = createLifecycleFaultStore();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => { notifications += 1; });

        store.add({
            modId: 'arc',
            file: 'arc/manifest.json',
            kind: 'threw',
            hook: 'activate',
            strikes: 1,
            latched: false,
            reason: 'Arc: hook "activate" threw (boom)',
        });
        store.add({
            modId: 'arc',
            file: 'arc/manifest.json',
            kind: 'deadline',
            hook: 'activate',
            strikes: 2,
            latched: false,
            reason: 'Arc: hook "activate" deadline exceeded (5000 ms)',
        });

        expect(store.getFaults()).toEqual([
            { file: 'arc/manifest.json', reason: 'Arc: hook "activate" deadline exceeded (5000 ms)' },
        ]);
        expect(store.getRecords()[0]).toMatchObject({ kind: 'deadline', strikes: 2 });
        expect(notifications).toBe(2);
        unsubscribe();
    });

    it('clear removes all records and notifies', () => {
        const store = createLifecycleFaultStore();
        let notifications = 0;
        store.subscribe(() => { notifications += 1; });

        store.add({
            modId: 'arc',
            file: 'arc/manifest.json',
            kind: 'threw',
            hook: 'activate',
            strikes: 1,
            latched: false,
            reason: 'x',
        });
        store.clear();

        expect(store.getFaults()).toHaveLength(0);
        expect(store.getRecords()).toHaveLength(0);
        expect(notifications).toBe(2);
    });
});