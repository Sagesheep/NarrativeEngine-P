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
