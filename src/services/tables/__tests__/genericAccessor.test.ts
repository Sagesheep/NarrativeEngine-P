import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTableRegistry } from '@narrative/engine';
import type { TableDescriptor } from '@narrative/engine';
import { genericGet, genericSave, createDebouncedSave, runOnRemove } from '../genericAccessor';
import { collectHydrators } from '../hydrateTables';

const present = <T>(value: T) => ({ present: true as const, value });

const arrayDescriptor = (over: Partial<TableDescriptor>): TableDescriptor => ({
    name: 'fixture',
    fileSuffix: '.fixture.json',
    recordShape: 'array',
    serverRoutes: present({ get: true, put: true }),
    storeAccessor: present({ read: true, write: true }),
    ...over,
});

describe('genericGet', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns [] for an array descriptor on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => [] })));
        const descriptor = arrayDescriptor({ name: 'arr' });
        const result = await genericGet(descriptor as never, 'c1');
        expect(result).toEqual([]);
    });

    it('returns null for a single-object descriptor on non-ok response', async () => {
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => null })));
        const descriptor: TableDescriptor = {
            name: 'cfg', fileSuffix: '.cfg.json', recordShape: 'single-object',
            serverRoutes: present({ get: true, put: true }),
            storeAccessor: present({ read: true, write: true }),
        };
        const result = await genericGet(descriptor as never, 'c1');
        expect(result).toBeNull();
    });

    it('reads the body and fires onAfterRead when declared', async () => {
        const onAfterRead = vi.fn((_id, record) => (record as Array<{ id: string; homed?: boolean }>).map((x) => ({ ...x, homed: true })));
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => [{ id: 'a' }] })));
        const descriptor = arrayDescriptor({ name: 'npc', hooks: { onAfterRead: onAfterRead as never } });
        const result = await genericGet(descriptor as never, 'c1');
        expect(onAfterRead).toHaveBeenCalledWith('c1', [{ id: 'a' }]);
        expect(result).toEqual([{ id: 'a', homed: true }]);
    });

    it('hits the right URL', async () => {
        const fetchMock = vi.fn(async () => ({ ok: true, json: async () => [] }));
        vi.stubGlobal('fetch', fetchMock);
        const descriptor = arrayDescriptor({ name: 'lore-thing' });
        await genericGet(descriptor as never, 'camp-42');
        expect(fetchMock).toHaveBeenCalledWith('/api/campaigns/camp-42/lore-thing');
    });
});

describe('genericSave', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('PUTs the body to the right URL', async () => {
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        const descriptor = arrayDescriptor({ name: 'ledger' });
        await genericSave(descriptor as never, 'c1', [{ id: 'a' }]);
        expect(fetchMock).toHaveBeenCalledWith('/api/campaigns/c1/ledger', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify([{ id: 'a' }]),
        });
    });

    it('runs onBeforeWrite before the PUT and sends the transformed body', async () => {
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        const onBeforeWrite = vi.fn((_id, body) => (body as Array<{ id: string }>).map((x) => ({ ...x, stripped: true })));
        const descriptor = arrayDescriptor({ name: 'state-like', hooks: { onBeforeWrite: onBeforeWrite as never } });
        await genericSave(descriptor as never, 'c1', [{ id: 'a' }]);
        expect(onBeforeWrite).toHaveBeenCalledWith('c1', [{ id: 'a' }]);
        const call = fetchMock.mock.calls[0];
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual([{ id: 'a', stripped: true }]);
    });
});

describe('createDebouncedSave', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('debounces and reads fresh state at fire time (no stale closures)', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        let state = { activeCampaignId: 'c1' as string | null, field: [{ id: 'a' }] };
        const descriptor = arrayDescriptor({ name: 'debounced' });
        const save = createDebouncedSave(descriptor as never, () => state, 1000);

        save([{ id: 'a' }]);
        state = { activeCampaignId: 'c1', field: [{ id: 'b' }] };
        save([{ id: 'b' }]);

        expect(fetchMock).not.toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
        const call = fetchMock.mock.calls[0];
        expect(JSON.parse((call[1] as RequestInit).body as string)).toEqual([{ id: 'b' }]);
    });

    it('skips when activeCampaignId is null', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        const descriptor = arrayDescriptor({ name: 'nullcamp' });
        const save = createDebouncedSave(descriptor as never, () => ({ activeCampaignId: null, field: [] }), 1000);
        save([]);
        await vi.advanceTimersByTimeAsync(1000);
        expect(fetchMock).not.toHaveBeenCalled();
    });
});

describe('runOnRemove', () => {
    it('fires onRemove with campaignId and id when declared', () => {
        const onRemove = vi.fn();
        const descriptor = arrayDescriptor({ name: 'loc', hooks: { onRemove } });
        runOnRemove(descriptor, 'c1', 'loc-9');
        expect(onRemove).toHaveBeenCalledWith('c1', 'loc-9');
    });

    it('is a no-op when onRemove is not declared', () => {
        const descriptor = arrayDescriptor({ name: 'plain' });
        expect(() => runOnRemove(descriptor, 'c1', 'x')).not.toThrow();
    });

    it('is a no-op when campaignId is null', () => {
        const onRemove = vi.fn();
        const descriptor = arrayDescriptor({ name: 'loc', hooks: { onRemove } });
        runOnRemove(descriptor, null, 'x');
        expect(onRemove).not.toHaveBeenCalled();
    });
});

describe('collectHydrators', () => {
    it('returns empty for an empty registry', () => {
        const reg = createTableRegistry();
        expect(collectHydrators(reg)).toEqual([]);
    });

    it('collects only descriptors that declare a hydrator, in registration order', () => {
        const reg = createTableRegistry();
        const loadA = async () => 'a';
        const loadB = async () => 'b';
        reg.register({ name: 'a', fileSuffix: '.a.json', recordShape: 'array', hydrator: present(loadA) });
        reg.register({ name: 'b', fileSuffix: '.b.json', recordShape: 'array' });
        reg.register({ name: 'c', fileSuffix: '.c.json', recordShape: 'array', hydrator: present(loadB) });

        const entries = collectHydrators(reg);
        expect(entries.map((e) => e.name)).toEqual(['a', 'c']);
        expect(entries[0].load).toBe(loadA);
        expect(entries[1].load).toBe(loadB);
    });
});