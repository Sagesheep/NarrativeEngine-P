import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServiceRoleRegistry } from '../roleRegistry';
import { roleFaultStore } from '../roleFaults';
import type { RoleProvider, ServiceRole } from '../roleTypes';

type OpaqueInput = { readonly value: number };
type OpaqueAnswer = { readonly result: number };

const makeRole = (defaultAnswer = 0): ServiceRole<OpaqueInput, OpaqueAnswer> => ({
    id: 'opaque.alpha',
    name: 'Opaque alpha',
    description: 'Test role with no production feature vocabulary.',
    deadlineMs: 50,
    validate(answer): OpaqueAnswer | undefined {
        if (!answer || typeof answer !== 'object') return undefined;
        const result = (answer as { result?: unknown }).result;
        return typeof result === 'number' ? { result } : undefined;
    },
    defaultProvider: {
        providerId: 'role.opaque.alpha.default',
        source: 'builtin',
        loadIndex: Number.POSITIVE_INFINITY,
        ask: () => ({ result: defaultAnswer }),
    },
});

const provider = (
    modId: string,
    loadIndex: number,
    ask: RoleProvider<never, never>['ask'],
): RoleProvider<never, never> => ({
    providerId: 'mod.' + modId,
    source: 'mod',
    modId,
    loadIndex,
    ask,
});

describe('createServiceRoleRegistry', () => {
    beforeEach(() => roleFaultStore.clear());

    it('arbitrates opaque role IDs by resolved load index, then provider key', async () => {
        const registry = createServiceRoleRegistry();
        registry.register(makeRole());
        registry.provide('opaque.alpha', provider('zeta', 2, () => ({ result: 2 })));
        registry.provide('opaque.alpha', provider('alpha', 2, () => ({ result: 1 })));

        expect(registry.activeProviderFor('opaque.alpha')?.modId).toBe('alpha');
        await expect(registry.ask<OpaqueInput, OpaqueAnswer>('opaque.alpha', { value: 1 }))
            .resolves.toEqual({ result: 1 });
        expect(roleFaultStore.getRecords()).toEqual(expect.arrayContaining([
            expect.objectContaining({ modId: 'zeta', kind: 'conflict', roleId: 'opaque.alpha', winner: 'alpha' }),
        ]));
    });

    it('does not fall back per ask, then latches a claimant after three faults', async () => {
        const registry = createServiceRoleRegistry();
        registry.register(makeRole(9));
        const badAsk = vi.fn(() => {
            throw new Error('bad provider');
        });
        registry.provide('opaque.alpha', provider('bad', 0, badAsk));

        await expect(registry.ask('opaque.alpha', { value: 1 })).resolves.toBeUndefined();
        expect(badAsk).toHaveBeenCalledTimes(1);
        await expect(registry.ask('opaque.alpha', { value: 1 })).resolves.toBeUndefined();
        await expect(registry.ask('opaque.alpha', { value: 1 })).resolves.toBeUndefined();
        await expect(registry.ask('opaque.alpha', { value: 1 })).resolves.toEqual({ result: 9 });
        expect(badAsk).toHaveBeenCalledTimes(3);
        expect(roleFaultStore.getRecords()).toEqual(expect.arrayContaining([
            expect.objectContaining({ modId: 'bad', kind: 'threw', strikes: 3, latched: true }),
        ]));
    });

    /**
     * `ROLES.md` §1.2 — the name-blindness pin, and it has to be a DOUBLE run.
     *
     * An opaque-ids-only run proves the registry tolerates opaque ids. The
     * actual claim is stronger: behaviour is *identical* whether the ids are
     * production names or gibberish, because the registry may never branch on
     * which role it is holding. So run one corpus twice — once with the real
     * `memory.recall` vocabulary, once with every id replaced — and compare the
     * traces after substituting the names back.
     *
     * This is `runner.test.ts`'s discipline, which `tracks/runner.ts:8-17` calls
     * "enforced, not merely asked for". 7.1.1 shipped the opaque half only;
     * `ROLES.md` §13 records the gap this closes.
     */
    it('behaves identically with real ids and with opaque ids', async () => {
        type Names = { role: string; core: string; winner: string; loser: string };
        const REAL: Names = {
            role: 'memory.recall',
            core: 'role.memory.recall.core',
            winner: 'vector-memory',
            loser: 'summary-memory',
        };
        const OPAQUE: Names = { role: 'q7.x2', core: 'k9.q7.x2.z', winner: 'aaa', loser: 'bbb' };

        async function runCorpus(n: Names): Promise<string[]> {
            roleFaultStore.clear();
            const trace: string[] = [];
            const registry = createServiceRoleRegistry();
            registry.register({
                ...makeRole(9),
                id: n.role,
                defaultProvider: {
                    providerId: n.core,
                    source: 'builtin',
                    loadIndex: Number.POSITIVE_INFINITY,
                    ask: () => ({ result: 9 }),
                },
            });

            // Conflict: the higher load index registers first and must lose.
            registry.provide(n.role, provider(n.loser, 5, () => ({ result: 5 })));
            registry.provide(n.role, provider(n.winner, 1, () => {
                throw new Error('provider failed');
            }));
            trace.push(`active=${registry.activeProviderFor(n.role)?.providerId}`);

            // No per-ask fallback, then the latch on the third strike. Note the
            // fourth ask resolves to the LOSER, not to core: the latch demotes
            // one provider and the registry walks the ordered list, it does not
            // jump to the default.
            for (let i = 0; i < 4; i++) {
                trace.push(`ask${i}=${JSON.stringify(await registry.ask(n.role, { value: i }))}`);
            }
            // Snapshot the faults HERE. Later revokes replace a mod's record,
            // so an end-of-corpus snapshot would silently lose the strike
            // history this corpus exists to compare.
            trace.push(`faultsAfterAsks=${roleFaultStore.getRecords().map((r) => `${r.modId}:${r.kind}:${r.latched ?? false}`).join('|')}`);

            // An answer the validator rejects is a breach, not an answer.
            registry.revoke(n.winner);
            registry.revoke(n.loser);
            registry.provide(n.role, provider(n.winner, 1, () => ({ nope: true }) as never));
            trace.push(`invalid=${JSON.stringify(await registry.ask(n.role, { value: 9 }))}`);

            registry.revoke(n.winner);
            trace.push(`final=${JSON.stringify(await registry.ask(n.role, { value: 10 }))}`);
            trace.push(`faultsFinal=${roleFaultStore.getRecords().map((r) => `${r.modId}:${r.kind}`).join('|')}`);
            return trace;
        }

        const realTrace = await runCorpus(REAL);
        const opaqueTrace = await runCorpus(OPAQUE);

        const substituted = realTrace.map((line) => line
            .split(REAL.core).join(OPAQUE.core)
            .split(REAL.role).join(OPAQUE.role)
            .split(REAL.winner).join(OPAQUE.winner)
            .split(REAL.loser).join(OPAQUE.loser));

        expect(substituted).toEqual(opaqueTrace);
        // Guard the guard: a corpus that exercised nothing would pass trivially.
        // Assert the run actually reached a conflict, a strike and the latch.
        const realText = realTrace.join('\n');
        expect(realText).toContain(':conflict');
        expect(realText).toContain(':threw:');
        expect(realText).toContain(':threw:true');
    });

    it('applies enablement and revokes stale providers without throwing', async () => {
        const enabled = new Map<string, boolean>();
        const registry = createServiceRoleRegistry({
            isEnabled: (providerId) => enabled.get(providerId) !== false,
        });
        registry.register(makeRole());
        registry.provide('opaque.alpha', provider('one', 0, () => ({ result: 1 })));
        enabled.set('mod.one', false);
        await expect(registry.ask('opaque.alpha', { value: 1 })).resolves.toEqual({ result: 0 });

        enabled.set('mod.one', true);
        registry.enable('one');
        registry.provide('opaque.alpha', provider('one', 0, () => ({ result: 1 })));
        registry.revoke('one');
        await expect(registry.ask('opaque.alpha', { value: 1 })).resolves.toEqual({ result: 0 });
        expect(roleFaultStore.getRecords()).not.toEqual(expect.arrayContaining([
            expect.objectContaining({ kind: 'threw' }),
        ]));
    });
});
