import { describe, expect, it, vi, beforeEach } from 'vitest';
import { anchorSceneLocation } from '../locationHeader';
import type { LocationEntry } from '../../types';
const getState = vi.hoisted(() => vi.fn());
vi.mock('../../store/useAppStore', () => ({ useAppStore: { getState } }));
import { locationHeaderTrack } from '../turn/tracks/sequential/locationHeaderTrack';
import type { SequentialTrackContext } from '../turn/tracks/types';
const header = (value: string) => `📍 [Location] ${value} | 👥 [Present] none`;
describe('committed chat to Places anchoring', () => {
    beforeEach(() => vi.clearAllMocks());
    it('anchors an unnamed slum as a settlement feature and reuses it', () => {
        const first = anchorSceneLocation(header('Slum district'), [], null);
        expect(first.created).toMatchObject({ name: 'Unknown settlement', features: ['Slum district'] });
        const second = anchorSceneLocation(header('Slum district'), [first.created!], first.created!.id);
        expect(second.created).toBeUndefined();
        expect(second.outcome.kind).toBe('feature-only');
        expect(first.created!.coordinates).toBeUndefined(); // Map owns coordinate assignment.
    });
    it('does not create places from memories, intentions, or an unanchored room', () => {
        for (const text of ['I remember the party in a city. I plan to go home.', header('Kitchen'), header('Unknown')]) {
            expect(anchorSceneLocation(text, [], null).created).toBeUndefined();
        }
    });
    it('creates a newly reached city rather than attaching its slum to the old city', () => {
        const first = anchorSceneLocation(header('First City — Market'), [], null).created!;
        const next = anchorSceneLocation(header('Second City — Slum district'), [first], first.id);
        expect(next.created).toMatchObject({ name: 'Second City', features: ['Slum district'] });
        expect(next.outcome).toMatchObject({ placeId: next.created!.id });
    });
    it('publishes the place before the pointer and is idempotent on repeated commits', async () => {
        const ledger: LocationEntry[] = [];
        const context: { currentPlaceId: string | null } = { currentPlaceId: null };
        const addLocation = vi.fn((entry: LocationEntry) => ledger.push(entry));
        const updateContext = vi.fn((patch: { currentPlaceId: string }) => {
            expect(ledger.some(entry => entry.id === patch.currentPlaceId)).toBe(true);
            Object.assign(context, patch);
        });
        getState.mockImplementation(() => ({ activeCampaignId: 'c', locationLedger: ledger, context,
            addLocation, updateLocation: vi.fn(), addLocationSuggestions: vi.fn() }));
        const ctx = { activeCampaignId: 'c', lastAssistantContent: header('Unknown settlement — Slum district'), callbacks: { updateContext } } as unknown as SequentialTrackContext;
        await locationHeaderTrack.run(ctx);
        await locationHeaderTrack.run(ctx);
        expect(addLocation).toHaveBeenCalledTimes(1);
        expect(updateContext).toHaveBeenCalledWith({ currentPlaceId: ledger[0].id, currentFeature: 'Slum district' });
        await locationHeaderTrack.run({ ...ctx, activeCampaignId: 'other' });
        expect(updateContext).toHaveBeenCalledTimes(2);
    });
});
