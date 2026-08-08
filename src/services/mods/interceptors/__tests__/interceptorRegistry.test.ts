/**
 * Phase 5.2 — the pre-prompt interceptor registry.
 *
 * The registry-level half of the phase: registration, ordering, validation,
 * fault containment, the deadline, and host-owned teardown. The payload-level
 * half (a fixture interceptor's block and suppression visible in a real built
 * payload, plus cache stability) is
 * `src/services/mods/__tests__/phase52Interceptor.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    clearAllModInterceptors,
    disableModInterceptors,
    enableModInterceptors,
    hasPromptInterceptors,
    isModInterceptorsRevoked,
    listPromptInterceptors,
    registerModInterceptor,
    runPromptInterceptors,
} from '../interceptorRegistry';
import { interceptorFaultStore } from '../interceptorFaults';
import type { PromptInterceptor, PromptInterceptorInput } from '../interceptorTypes';
import { DEFAULT_MOD_CONTRIBUTION_BUDGET } from '../../../payload/contributions/registry';
import { PROTECTED_SUPPRESSION_IDS } from '../../modTypes';

const INPUT: PromptInterceptorInput = Object.freeze({
    turnId: 'turn_1',
    campaignId: 'campaign-1',
    tier: 'pro',
    playerInput: 'I open the door.',
    hasDirectorBrief: false,
    hasWatchdogNudge: false,
    hasAbsoluteCommand: false,
});

const register = (id: string, fn: PromptInterceptor, loadIndex = 0): void => {
    registerModInterceptor({ id, name: `Mod ${id}`, loadIndex, file: `${id}/manifest.json` }, fn);
};

beforeEach(() => {
    clearAllModInterceptors();
});

describe('registration and run order', () => {
    it('reports no interceptors before any registration, so the turn path never awaits', () => {
        expect(hasPromptInterceptors()).toBe(false);
    });

    it('registers one interceptor per mod and reports it', () => {
        register('alpha', () => undefined);
        expect(hasPromptInterceptors()).toBe(true);
        expect(listPromptInterceptors()).toEqual(['alpha']);
    });

    it('a re-registration replaces the previous function rather than adding a second', async () => {
        register('alpha', () => ({ contributions: [{ id: 'first', text: 'FIRST' }] }));
        register('alpha', () => ({ contributions: [{ id: 'second', text: 'SECOND' }] }));
        expect(listPromptInterceptors()).toEqual(['alpha']);
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs.map((s) => s.id)).toEqual(['mod.alpha.second']);
    });

    it('runs in resolved load order, not registration order', () => {
        register('later', () => undefined, 200);
        register('earlier', () => undefined, 100);
        expect(listPromptInterceptors()).toEqual(['earlier', 'later']);
    });

    it('breaks a load-order tie on mod id ascending', () => {
        register('zeta', () => undefined, 100);
        register('alpha', () => undefined, 100);
        expect(listPromptInterceptors()).toEqual(['alpha', 'zeta']);
    });

    it('collects results in load order even when the later mod resolves first', async () => {
        // The determinism constraint (5.2 §3): concurrency is an execution
        // detail and must never reach the output. `slow` has the lower load
        // index and resolves LAST; its spec must still come first.
        register('slow', async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { contributions: [{ id: 'block', text: 'SLOW' }] };
        }, 100);
        register('fast', () => ({ contributions: [{ id: 'block', text: 'FAST' }] }), 200);

        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs.map((s) => s.id)).toEqual(['mod.slow.block', 'mod.fast.block']);
    });

    it('two identical runs produce identical output', async () => {
        register('a', (input) => ({ contributions: [{ id: 'x', text: `A:${input.turnId}` }] }), 100);
        register('b', (input) => ({ contributions: [{ id: 'y', text: `B:${input.playerInput}` }], suppress: ['gm.reminder'] }), 200);

        const first = await runPromptInterceptors(INPUT);
        const second = await runPromptInterceptors(INPUT);
        expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    });
});

describe('the input handed to an interceptor', () => {
    it('is frozen — a mod cannot mutate the host view of its own turn', async () => {
        let seen: PromptInterceptorInput | undefined;
        register('alpha', (input) => { seen = input; });
        await runPromptInterceptors(INPUT);
        expect(seen).toBeDefined();
        expect(Object.isFrozen(seen)).toBe(true);
    });

    it('carries the turn identity and the three built-in flags', async () => {
        let seen: PromptInterceptorInput | undefined;
        register('alpha', (input) => { seen = input; });
        await runPromptInterceptors({ ...INPUT, hasDirectorBrief: true, hasAbsoluteCommand: true });
        expect(seen).toMatchObject({
            turnId: 'turn_1',
            campaignId: 'campaign-1',
            tier: 'pro',
            playerInput: 'I open the door.',
            hasDirectorBrief: true,
            hasWatchdogNudge: false,
            hasAbsoluteCommand: true,
        });
    });
});

describe('the produced specs', () => {
    it('namespaces every id, targets the final-user slot, and marks the source as mod', async () => {
        register('alpha', () => ({ contributions: [{ id: 'ledger', text: 'LEDGER', order: 450 }] }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs[0]).toMatchObject({
            id: 'mod.alpha.ledger',
            slot: 'final-user',
            source: 'mod',
            order: 450,
            text: 'LEDGER',
        });
    });

    it('stamps the default budget when the mod declared none', async () => {
        register('alpha', () => ({ contributions: [{ id: 'ledger', text: 'LEDGER' }] }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs[0].budget).toBe(DEFAULT_MOD_CONTRIBUTION_BUDGET);
    });

    it('keeps a declared budget', async () => {
        register('alpha', () => ({ contributions: [{ id: 'ledger', text: 'LEDGER', budget: 40 }] }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs[0].budget).toBe(40);
    });

    it('defaults a missing order to 0, matching the declarative path', async () => {
        register('alpha', () => ({ contributions: [{ id: 'ledger', text: 'LEDGER' }] }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs[0].order).toBe(0);
    });

    it('returns undefined for the quiet path so the caller passes no option at all', async () => {
        register('alpha', () => undefined);
        register('beta', () => null);
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
    });

    it('returns undefined when nothing is registered', async () => {
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
    });
});

describe('the protected ids are not negotiable', () => {
    beforeEach(() => interceptorFaultStore.clear());

    it.each(PROTECTED_SUPPRESSION_IDS)('rejects a suppression of "%s" with a reason', async (protectedId) => {
        register('alpha', () => ({ suppress: [protectedId] }));
        const result = await runPromptInterceptors(INPUT);

        expect(result).toBeUndefined();
        const records = interceptorFaultStore.getRecords();
        expect(records).toHaveLength(1);
        expect(records[0]).toMatchObject({ modId: 'alpha', kind: 'protected', id: protectedId });
        expect(records[0].reason).toContain(protectedId);
        expect(records[0].reason).toContain('structural');
    });

    it('honours the rest of the interception when one suppression is rejected', async () => {
        register('alpha', () => ({
            contributions: [{ id: 'ledger', text: 'LEDGER' }],
            suppress: ['user.message', 'gm.reminder'],
        }));
        const result = await runPromptInterceptors(INPUT);

        expect(result?.specs.map((s) => s.id)).toEqual(['mod.alpha.ledger']);
        expect(result?.suppress).toEqual([{ id: 'gm.reminder', by: 'mod.alpha' }]);
        expect(interceptorFaultStore.getRecords()[0].kind).toBe('protected');
    });

    it('attributes an accepted suppression to the mod that asked for it', async () => {
        register('alpha', () => ({ suppress: ['watchdog.nudge'] }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.suppress).toEqual([{ id: 'watchdog.nudge', by: 'mod.alpha' }]);
    });
});

describe('a failing interceptor does not fail the turn', () => {
    beforeEach(() => interceptorFaultStore.clear());

    it('contains a synchronous throw as a fault and keeps the other mod running', async () => {
        register('broken', () => { throw new Error('kaboom'); }, 100);
        register('healthy', () => ({ contributions: [{ id: 'ok', text: 'OK' }] }), 200);

        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs.map((s) => s.id)).toEqual(['mod.healthy.ok']);

        const record = interceptorFaultStore.getRecords().find((r) => r.modId === 'broken');
        expect(record?.kind).toBe('threw');
        expect(record?.reason).toContain('kaboom');
        expect(record?.reason).toContain('un-intercepted payload');
    });

    it('contains a rejected promise the same way', async () => {
        register('broken', () => Promise.reject(new Error('async kaboom')));
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
        expect(interceptorFaultStore.getRecords()[0]).toMatchObject({ modId: 'broken', kind: 'threw' });
    });

    it('contains an interceptor that never settles, under the hard deadline', async () => {
        register('hangs', () => new Promise(() => { /* never resolves */ }), 100);
        register('healthy', () => ({ contributions: [{ id: 'ok', text: 'OK' }] }), 200);

        const result = await runPromptInterceptors(INPUT, { deadlineMs: 20 });
        expect(result?.specs.map((s) => s.id)).toEqual(['mod.healthy.ok']);

        const record = interceptorFaultStore.getRecords().find((r) => r.modId === 'hangs');
        expect(record?.kind).toBe('timeout');
        expect(record?.reason).toContain('20 ms');
    });

    it('bounds the stage by the slowest interceptor, not by their sum', async () => {
        // Five hanging mods, one 40 ms deadline. Sequential execution would
        // cost 200 ms; concurrent execution costs one deadline. Asserted with
        // slack so a loaded CI box does not flake.
        for (let i = 0; i < 5; i++) register(`hang-${i}`, () => new Promise(() => {}), i);
        const started = Date.now();
        await runPromptInterceptors(INPUT, { deadlineMs: 40 });
        expect(Date.now() - started).toBeLessThan(150);
        expect(interceptorFaultStore.getRecords()).toHaveLength(5);
    });

    it('does not latch — a faulting mod is called again on the next turn', async () => {
        const fn = vi.fn(() => { throw new Error('always'); });
        register('broken', fn);
        await runPromptInterceptors(INPUT);
        await runPromptInterceptors(INPUT);
        await runPromptInterceptors(INPUT);
        expect(fn).toHaveBeenCalledTimes(3);
        // One row per mod, latest wins — a mod throwing every turn must not
        // grow the Extensions fault list.
        expect(interceptorFaultStore.getRecords()).toHaveLength(1);
    });
});

describe('a malformed return is dropped, not trusted', () => {
    beforeEach(() => interceptorFaultStore.clear());

    it('rejects a contribution id containing a dot (it would make the namespaced id ambiguous)', async () => {
        register('alpha', () => ({ contributions: [{ id: 'a.b', text: 'X' }] }));
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
        expect(interceptorFaultStore.getRecords()[0]).toMatchObject({ kind: 'invalid', id: 'a.b' });
    });

    it('rejects a non-string text', async () => {
        register('alpha', () => ({ contributions: [{ id: 'ok', text: 42 as unknown as string }] }));
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
        expect(interceptorFaultStore.getRecords()[0].reason).toContain('text must be a string');
    });

    it('keeps the first of a duplicated id and names the duplicate', async () => {
        register('alpha', () => ({
            contributions: [{ id: 'dup', text: 'FIRST' }, { id: 'dup', text: 'SECOND' }],
        }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs.map((s) => s.text)).toEqual(['FIRST']);
        expect(interceptorFaultStore.getRecords()[0].reason).toContain('returned twice');
    });

    it('rejects a non-object return', async () => {
        register('alpha', () => 'a prompt string' as unknown as undefined);
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
        expect(interceptorFaultStore.getRecords()[0].reason).toContain('returned string');
    });

    it('ignores an empty-text contribution the way the arbiter would', async () => {
        // Not a fault: `''` is the defined "inactive this turn" value. It
        // reaches the arbiter and is dropped there, which also means it
        // suppresses nothing.
        register('alpha', () => ({ contributions: [{ id: 'quiet', text: '' }] }));
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs[0].text).toBe('');
        expect(interceptorFaultStore.getRecords()).toHaveLength(0);
    });
});

describe('host-owned teardown', () => {
    beforeEach(() => interceptorFaultStore.clear());

    it('disable removes the interceptor and revokes the lease', async () => {
        register('alpha', () => ({ contributions: [{ id: 'x', text: 'X' }] }));
        expect(disableModInterceptors('alpha')).toBe(true);
        expect(hasPromptInterceptors()).toBe(false);
        expect(isModInterceptorsRevoked('alpha')).toBe(true);
        expect(await runPromptInterceptors(INPUT)).toBeUndefined();
    });

    it('discards the result of an interceptor whose mod is disabled mid-turn', async () => {
        register('alpha', async () => {
            await new Promise((resolve) => setTimeout(resolve, 20));
            return { contributions: [{ id: 'x', text: 'X' }] };
        });
        const running = runPromptInterceptors(INPUT);
        disableModInterceptors('alpha');
        expect(await running).toBeUndefined();
        // `disableModInterceptors` clears the mod's prior faults, so the only
        // record present is the revocation itself.
        expect(interceptorFaultStore.getRecords()[0]).toMatchObject({ modId: 'alpha', kind: 'revoked' });
    });

    it('enable clears the revoked lease so a re-registration takes', async () => {
        register('alpha', () => ({ contributions: [{ id: 'x', text: 'X' }] }));
        disableModInterceptors('alpha');
        enableModInterceptors('alpha');
        register('alpha', () => ({ contributions: [{ id: 'x', text: 'X' }] }));
        expect(isModInterceptorsRevoked('alpha')).toBe(false);
        const result = await runPromptInterceptors(INPUT);
        expect(result?.specs.map((s) => s.id)).toEqual(['mod.alpha.x']);
    });

    it('does not accumulate across enable/disable churn', async () => {
        for (let i = 0; i < 10; i++) {
            register('alpha', () => ({ contributions: [{ id: 'x', text: 'X' }] }));
            expect(listPromptInterceptors()).toEqual(['alpha']);
            disableModInterceptors('alpha');
            expect(listPromptInterceptors()).toEqual([]);
        }
    });

    it('clearAll drops everything, including the fault records', () => {
        register('alpha', () => undefined);
        interceptorFaultStore.add({ modId: 'alpha', file: 'f', kind: 'threw', reason: 'r' });
        clearAllModInterceptors();
        expect(hasPromptInterceptors()).toBe(false);
        expect(interceptorFaultStore.getRecords()).toHaveLength(0);
    });
});
