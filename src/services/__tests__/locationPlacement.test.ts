import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { LocationEntry } from '../../types';
const { getState, llm } = vi.hoisted(() => ({ getState: vi.fn(), llm: vi.fn() }));
vi.mock('../../store/useAppStore', () => ({ useAppStore: { getState } }));
vi.mock('../../utils/llmCall', () => ({ llmCall: llm }));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn() } }));
import { queueLocationEnrichment, sanitizeEnrichPatch } from '../locationEnrich';
import { requestPlacementContext, sanitizePlacement } from '../location/placement';
import { modEventBus } from '../mods/events';
const owner = { modId: 'worldmap', modName: 'World Map', file: 'worldmap/manifest.json' };
const place = (id: string): LocationEntry => ({ id, name: id, aliases: '', features: [], connections: [], description: '', broadLocation: '', source: 'manual', firstSeenScene: '', lastSeenScene: '' });
let ledger: LocationEntry[];
let update: ReturnType<typeof vi.fn>;
beforeEach(() => {
    modEventBus.reset(); llm.mockReset();
    ledger = [{ ...place('camp'), coordinates: { x: 100, y: 200 } }, { ...place('castle'), placementPendingUntil: Date.now() + 300000 }];
    update = vi.fn((id: string, patch: Partial<LocationEntry>) => { ledger = ledger.map(entry => entry.id === id ? { ...entry, ...patch } : entry); });
    getState.mockImplementation(() => ({ activeCampaignId: 'c', locationLedger: ledger, messages: [{ role: 'assistant', content: 'Frostmourne Castle lies far to the north in perpetual ice.' }],
        settings: { aiTier: 'pro' }, updateLocation: update, getActiveSummarizerEndpoint: () => ({ id: 'provider' }) }));
});
afterEach(() => modEventBus.reset());
it('supplies player coordinates, biome and exploration extent to AI before finalizing placement', async () => {
    const context = { player: { x: 100, y: 200, biome: 'savanna' }, exploredBounds: { north: 190, south: 210, west: 90, east: 110 }, boundsAreNotCoverage: true };
    modEventBus.on('mod.worldmap.placementContext', payload => modEventBus.emitFromMod(owner, 'placementContextResult',
        { requestId: payload.requestId, campaignId: payload.campaignId, contextJson: JSON.stringify(context) }));
    llm.mockResolvedValue(JSON.stringify({ placement: { referencePlaceId: 'camp', distanceBand: 'far', direction: 'n', preferredBiomes: ['snow'] },
        connections: [{ place: 'camp', band: 'far' }] }));
    queueLocationEnrichment('castle');
    await vi.waitFor(() => expect(ledger[1].placementPendingUntil).toBeUndefined());
    expect(llm.mock.calls[0][1]).toContain(JSON.stringify(context));
    expect(llm.mock.calls[0][1]).toContain('north = decreasing y');
    expect(llm.mock.calls[0][1]).toContain('never request terrain replacement');
    expect(ledger[1].placement).toMatchObject({ referencePlaceId: 'camp', distanceBand: 'far', direction: 'n', preferredBiomes: ['snow'] });
    expect(ledger[1].coordinates).toBeUndefined();
    expect(ledger[1].connections).toEqual([{ toId: 'camp', band: 'far' }]);
    expect(ledger[0].connections).toEqual([{ toId: 'castle', band: 'far' }]);
});
it('bounds and validates model placement fields, keeping explicit coordinates separate from saved coordinates', () => {
    const result = sanitizePlacement({ referencePlaceId: 'missing', distanceBand: 'far', direction: 'N', preferredBiomes: ['ice', 'snow', 'snow'],
        coordinates: { x: 800, y: 900 }, reason: 'x'.repeat(300) }, ledger[1], ledger);
    expect(result).toMatchObject({ referencePlaceId: undefined, distanceBand: 'far', direction: 'n', preferredBiomes: ['snow'], coordinates: { x: 800, y: 900 } });
    expect(result?.reason?.length).toBe(240);
    expect(sanitizePlacement({ coordinates: { x: -1, y: 1000 }, preferredBiomes: ['garbage'] }, ledger[1], ledger)).toBeUndefined();
    expect(sanitizePlacement({ coordinates: { x: 1.5, y: 2 } }, ledger[1], ledger)).toBeUndefined();
    expect(sanitizeEnrichPatch({ placement: { preferredBiomes: ['snow'] } }, ledger[0], ledger).placement).toBeUndefined();
});
it('does not overwrite coordinates assigned while the AI was in flight', async () => {
    let reply!: (value: string) => void;
    llm.mockImplementation(() => new Promise<string>(resolve => { reply = resolve; }));
    queueLocationEnrichment('castle');
    await vi.waitFor(() => expect(llm).toHaveBeenCalled());
    update('castle', { coordinates: { x: 40, y: 50 } });
    reply(JSON.stringify({ placement: { preferredBiomes: ['snow'], coordinates: { x: 800, y: 900 } } }));
    await vi.waitFor(() => expect(ledger[1].placementPendingUntil).toBeUndefined());
    expect(ledger[1].coordinates).toEqual({ x: 40, y: 50 });
    expect(ledger[1].placement).toBeUndefined();
});
it('releases an unplaced shell on model failure and supports a base app without the map mod', async () => {
    expect(await requestPlacementContext('c')).toBeNull();
    llm.mockResolvedValue('invalid response');
    queueLocationEnrichment('castle');
    await vi.waitFor(() => expect(ledger[1].placementPendingUntil).toBeUndefined());
    expect(ledger[1].coordinates).toBeUndefined();
});
it('times out a missing context reply and removes its listener', async () => {
    vi.useFakeTimers();
    try {
        modEventBus.on('mod.worldmap.placementContext', () => {});
        const result = requestPlacementContext('c');
        await vi.advanceTimersByTimeAsync(3001);
        expect(await result).toBeNull();
        expect(modEventBus.getListenerCount('mod.worldmap.placementContextResult')).toBe(0);
    } finally { vi.useRealTimers(); }
});

it('validates biome intent and bounds the region without changing legacy requirements', () => {
    expect(sanitizePlacement({ preferredBiomes: ['forest'], biomePolicy: 'preferred', biomeRadius: 100 }, ledger[1], ledger))
        .toMatchObject({ biomePolicy: 'preferred', biomeRadius: 24 });
    expect(sanitizePlacement({ preferredBiomes: ['desert'], biomePolicy: 'exception', biomeRadius: -2 }, ledger[1], ledger))
        .toMatchObject({ biomePolicy: 'exception', biomeRadius: 3 });
    expect(sanitizePlacement({ preferredBiomes: ['snow'], biomePolicy: 'invalid' }, ledger[1], ledger))
        .toMatchObject({ biomePolicy: 'required' });
});
