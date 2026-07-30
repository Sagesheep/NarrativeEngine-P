/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAppStore } from '../useAppStore';
import { hydrateCampaign } from '../campaignHydrator';
import { cancelPendingSaves } from '../slices/campaignSlice';

vi.mock('../campaignStore', () => ({
    loadCampaignState: vi.fn().mockResolvedValue({
        context: { currentPlaceId: 'current', currentFeature: 'hall' },
        messages: [],
        condenser: { condensedUpToIndex: -1 },
        pinnedExcerpts: [],
    }),
    getLoreChunks: vi.fn().mockResolvedValue([]),
    getNPCLedger: vi.fn().mockResolvedValue([]),
    getEnemyCompendium: vi.fn().mockResolvedValue([]),
    getEnemyInstances: vi.fn().mockResolvedValue([]),
    getEnemyEncounters: vi.fn().mockResolvedValue([]),
    getEnemyResolutions: vi.fn().mockResolvedValue([]),
    getEnemyCombatConfig: vi.fn().mockResolvedValue(null),
    loadArchiveIndex: vi.fn().mockResolvedValue([]),
    loadTimeline: vi.fn().mockResolvedValue([]),
    loadChapters: vi.fn().mockResolvedValue([]),
    loadEntities: vi.fn().mockResolvedValue([]),
    loadDivergenceRegister: vi.fn().mockResolvedValue({ entries: [], lastUpdatedSceneId: '', lastUpdatedAt: 0, version: 2 }),
    saveDivergenceRegister: vi.fn(),
    saveChapters: vi.fn(),
    saveNPCLedger: vi.fn(),
    saveCampaignState: vi.fn(),
}));

const locations = [
    { id: 'current', name: 'Current Place', aliases: '', description: '' },
    { id: 'elsewhere', name: 'Elsewhere', aliases: '', description: '' },
] as any[];

describe('location ledger lifecycle', () => {
    const fetchMock = vi.fn();

    beforeEach(() => {
        vi.useFakeTimers();
        fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
            if (url === '/api/campaigns/location-campaign/locations' && !init) {
                return { ok: true, json: async () => locations };
            }
            return { ok: true, json: async () => ({ ok: true }) };
        });
        vi.stubGlobal('fetch', fetchMock);
    });

    afterEach(() => {
        cancelPendingSaves();
        vi.useRealTimers();
        vi.unstubAllGlobals();
        vi.clearAllMocks();
    });

    it('hydrates, mutates, backs up, clears context, migrates, and persists locations', async () => {
        await hydrateCampaign('location-campaign');
        const store = useAppStore.getState();

        expect(store.locationLedger).toEqual(locations);
        store.addLocation({ id: 'new', name: 'New Place', aliases: '', description: '' } as any);
        store.updateLocation('new', { name: 'Renamed Place' });
        store.removeLocation('current');
        store.removeLocation('elsewhere');

        expect(useAppStore.getState().locationLedger).toEqual([
            { id: 'new', name: 'Renamed Place', aliases: '', description: '' },
        ]);
        expect(useAppStore.getState().context).toMatchObject({
            currentPlaceId: null,
            currentFeature: null,
        });

        await vi.advanceTimersByTimeAsync(1000);

        const backupCalls = fetchMock.mock.calls.filter(([url, init]) =>
            url === '/api/campaigns/location-campaign/backup' && init?.method === 'POST'
        );
        expect(backupCalls).toHaveLength(2);
        expect(backupCalls.every(([, init]) => init?.body === JSON.stringify({
            trigger: 'pre-delete-location', isAuto: true,
        }))).toBe(true);

        const locationSave = fetchMock.mock.calls.find(([url, init]) =>
            url === '/api/campaigns/location-campaign/locations' && init?.method === 'PUT'
        );
        expect(JSON.parse(locationSave?.[1]?.body as string)).toEqual([
            { id: 'new', name: 'Renamed Place', aliases: '', description: '' },
        ]);

        const stateSave = fetchMock.mock.calls.find(([url, init]) =>
            url === '/api/campaigns/location-campaign/state' && init?.method === 'PUT'
        );
        expect(JSON.parse(stateSave?.[1]?.body as string).context).toMatchObject({
            currentPlaceId: null,
            currentFeature: null,
        });
    });
});

