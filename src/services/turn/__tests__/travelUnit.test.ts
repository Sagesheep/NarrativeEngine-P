import { describe, expect, it } from 'vitest';
import type { GameContext, LocationEntry, TravelState } from '../../../types';
import { advance, depart, departMultiHop, legClock } from '../travelState';
import { buildCheckpointMessage, travelButtonTitle } from '../travelPress';
import { buildTravelFacts } from '../travelFacts';
import { buildMovementContract } from '../storyMovement';
import { buildLocationBlock, buildTravelBlock } from '../../payload/volatile';
import { formatDayRange, formatDayRangeForMode } from '../../location/distance';

/**
 * The World Map's Days / Hours switch. One leg is one press and one
 * checkpoint either way; the unit decides how far the clock moves and which
 * word the model reads.
 */

function place(id: string, name: string, connections: LocationEntry['connections'] = []): LocationEntry {
    return {
        id, name, aliases: '', broadLocation: 'Region', features: [], connections, description: '',
        firstSeenScene: '1', lastSeenScene: '1', source: 'manual',
    };
}

function travel(overrides: Partial<TravelState> = {}): TravelState {
    return { fromId: 'loc_a', toId: 'loc_b', transitId: 'loc_t', mode: 'foot', leg: 1, totalLegs: 4, agency: 'free', ...overrides };
}

const ctx = (overrides: Partial<GameContext> = {}) => ({ ...({} as GameContext), currentPlaceId: null, ...overrides });

describe('legClock', () => {
    it('moves a day-scale leg to the next day', () => {
        expect(legClock(undefined, 5, 200)).toEqual({ worldDay: 6, travelMinutesToday: 0 });
        expect(legClock('days', undefined, undefined)).toEqual({ worldDay: 1, travelMinutesToday: 0 });
    });

    it('spends an hour per hour-scale leg and rolls into the next day after a travel day', () => {
        expect(legClock('hours', 5, 0)).toEqual({ worldDay: 5, travelMinutesToday: 60 });
        expect(legClock('hours', 5, 420)).toEqual({ worldDay: 6, travelMinutesToday: 0 });
        expect(legClock('hours', undefined, undefined)).toEqual({ worldDay: 1, travelMinutesToday: 60 });
    });
});

describe('hour-scale journeys', () => {
    const ledger = [place('loc_a', 'Ashfen'), place('loc_b', 'Bree')];

    it('fixes the unit on the journey and walks the clock an hour per press', () => {
        const started = depart({ fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'foot', ledger, currentWorldDay: 3, currentTravelMinutes: 0, unit: 'hours' });
        expect(started.travel).toMatchObject({ leg: 1, totalLegs: 4, unit: 'hours' });
        expect(started.contextPatch).toMatchObject({ worldDay: 3, travelMinutesToday: 60 });

        let state = started.travel!;
        let clock = { worldDay: 3, minutes: 60 };
        for (const expected of [120, 180]) {
            const next = advance(state, clock.worldDay, clock.minutes);
            expect(next.contextPatch).toMatchObject({ worldDay: 3, travelMinutesToday: expected });
            state = next.travel!;
            clock = { worldDay: next.contextPatch.worldDay!, minutes: next.contextPatch.travelMinutesToday! };
        }
        const arrived = advance(state, clock.worldDay, clock.minutes);
        expect(arrived.travel).toBeNull();
        expect(arrived.contextPatch).toMatchObject({ currentPlaceId: 'loc_b', worldDay: 3, travelMinutesToday: 240 });
    });

    it('rolls a long hour-scale journey into the next day', () => {
        const result = advance(travel({ unit: 'hours', leg: 2, totalLegs: 10 }), 3, 420);
        expect(result.contextPatch).toMatchObject({ worldDay: 4, travelMinutesToday: 0 });
    });

    it('carries the unit through a multi-hop departure', () => {
        const three = [...ledger, place('loc_c', 'Carn')];
        const result = departMultiHop({
            fromId: 'loc_a', toId: 'loc_c', mode: 'foot', ledger: three, currentWorldDay: 3, unit: 'hours',
            hops: [{ fromId: 'loc_a', toId: 'loc_b', transitId: '', legs: 2 }, { fromId: 'loc_b', toId: 'loc_c', transitId: '', legs: 3 }],
        });
        expect(result.travel).toMatchObject({ totalLegs: 5, unit: 'hours' });
        expect(result.contextPatch).toMatchObject({ worldDay: 3, travelMinutesToday: 60 });
    });

    it('keeps day-scale journeys unchanged', () => {
        const result = depart({ fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'foot', ledger, currentWorldDay: 3 });
        expect('unit' in result.travel!).toBe(false);
        expect(result.contextPatch).toMatchObject({ worldDay: 4, travelMinutesToday: 0 });
    });

    it('keeps a tunnel in days, since its legs come from its minutes', () => {
        const tunnelLedger = [
            place('loc_a', 'Ashfen', [{ toId: 'loc_b', passage: 'tunnel', durationMinutes: 960 }]),
            place('loc_b', 'Bree', [{ toId: 'loc_a', passage: 'tunnel', durationMinutes: 960 }]),
        ];
        const result = depart({ fromId: 'loc_a', toId: 'loc_b', band: 'regional', mode: 'foot', ledger: tunnelLedger, currentWorldDay: 3, unit: 'hours' });
        expect(result.travel?.unit).toBeUndefined();
        expect(result.contextPatch.worldDay).toBe(4);
    });
});

describe('travel wording', () => {
    const ledger = [place('loc_a', 'Ashfen', [{ toId: 'loc_b', band: 'regional' }]), place('loc_b', 'Bree')];

    it('heads the [TRAVEL] block with the hour', () => {
        const block = buildTravelBlock(ctx({ travel: travel({ unit: 'hours', leg: 2, totalLegs: 5 }) }), ledger);
        expect(block.split('\n')[1]).toBe('Hour 2 of 5 — Ashfen → Bree by foot.');
        expect(buildTravelBlock(ctx({ travel: travel({ leg: 2, totalLegs: 5 }) }), ledger).split('\n')[1]).toBe('Day 2 of 5 — Ashfen → Bree by foot.');
    });

    it('labels Nearby ranges in the campaign unit', () => {
        expect(buildLocationBlock(ctx({ currentPlaceId: 'loc_a', travelUnit: 'hours' }), ledger)).toContain('Nearby: Bree (regional, 3–5h)');
        expect(buildLocationBlock(ctx({ currentPlaceId: 'loc_a' }), ledger)).toContain('Nearby: Bree (regional, 3–5d)');
    });

    it('gives the director an hour floor instead of an arrival day', () => {
        const far = [place('ashfen', 'Ashfen Crossing', [{ toId: 'ravenhold', band: 'far' }]), place('ravenhold', 'Ravenhold')];
        expect(buildTravelFacts(ctx({ currentPlaceId: 'ashfen', worldDay: 12, travelUnit: 'hours' }), far)).toEqual([
            'Ashfen Crossing → Ravenhold is far (16–30 grids), roughly 6–10 hours on foot. Arrival takes at least 6 hours of travel.',
        ]);
    });

    it('formats band ranges in hours', () => {
        expect(formatDayRange('nearby', 'hours')).toBe('about 1 hour');
        expect(formatDayRange('far', 'hours')).toBe('6–10 hours');
        expect(formatDayRange('farthest', 'hours')).toBe('41+ hours');
        expect(formatDayRangeForMode('far', 8, 'hours')).toBe('2–4 hours');
        expect(formatDayRange('far')).toBe('6–10 days');
    });

    it('names hourly stops on the button and checkpoint line', () => {
        const hourly = travel({ unit: 'hours' });
        expect(travelButtonTitle(hourly)).toBe('Travel on to stop 2 of 3 — one press, one hour');
        expect(buildCheckpointMessage(hourly, 3, ledger).content).toBe('Day 3 · stop 1 of 3 — road to Bree');
        expect(travelButtonTitle(travel())).toBe('Travel on to camp 2 of 3 — one press, one day');
    });

    it('tells the movement contract what one continue spends', () => {
        expect(buildMovementContract(ctx({ travelUnit: 'hours' }), ledger)).toContain('continue = player spends one travel hour');
        expect(buildMovementContract(ctx({ travel: travel({ unit: 'hours' }) }), ledger)).toContain('invent elapsed hours');
        expect(buildMovementContract(ctx(), ledger)).toContain('continue = player spends one travel day');
    });
});
