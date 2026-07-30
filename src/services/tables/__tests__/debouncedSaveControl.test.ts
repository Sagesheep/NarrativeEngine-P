import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TableDescriptor } from '@narrative/engine';
import { createDebouncedSave } from '../genericAccessor';

const descriptor: TableDescriptor = {
    name: 'fixture',
    fileSuffix: '.fixture.json',
    recordShape: 'array',
    serverRoutes: { present: true, value: { get: true, put: true } },
    storeAccessor: { present: true, value: { read: true, write: true } },
};

afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});

describe('createDebouncedSave controls', () => {
    it('flushes the current state and cancels a pending delayed write', async () => {
        vi.useFakeTimers();
        const fetchMock = vi.fn(async () => ({}));
        vi.stubGlobal('fetch', fetchMock);
        let state = { activeCampaignId: 'camp-1' as string | null, field: [{ id: 'first' }] };
        const save = createDebouncedSave(descriptor as never, () => state, 1_000);

        save([{ id: 'first' }]);
        state = { activeCampaignId: 'camp-1', field: [{ id: 'latest' }] };
        await save.flush();
        await vi.advanceTimersByTimeAsync(1_000);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)).toEqual([{ id: 'latest' }]);

        save([{ id: 'discarded' }]);
        save.cancel();
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
