import { describe, expect, it } from 'vitest';
import { legsFor, TRAVEL_MODES, gridsPerDayFor, travelModeLabel } from '../travelModes';
import type { DistanceBand } from '../distance';
import { DISTANCE_BANDS } from '../distance';

describe('TRAVEL_MODES', () => {
    it('exports the four modes in order', () => {
        expect(TRAVEL_MODES.map(m => m.id)).toEqual(['foot', 'cart', 'horseback', 'flying']);
    });

    it('gridsPerDay values match the work-order table', () => {
        expect(gridsPerDayFor('foot')).toBe(3);
        expect(gridsPerDayFor('cart')).toBe(5);
        expect(gridsPerDayFor('horseback')).toBe(8);
        expect(gridsPerDayFor('flying')).toBe(20);
    });

    it('labels are capitalized for the composer sentence', () => {
        expect(travelModeLabel('foot')).toBe('On foot');
        expect(travelModeLabel('cart')).toBe('Cart');
        expect(travelModeLabel('horseback')).toBe('Horseback');
        expect(travelModeLabel('flying')).toBe('Flying');
    });
});

describe('legsFor', () => {
    // Fixed reference table — every band × every mode.
    // Computed from the formula: effective = round((min+max)/2) for finite bands,
    // round(min*1.25) for farthest; legs = max(1, ceil(effective / gridsPerDay)).
    // (JS Math.round rounds .5 up, so round(4.5)=5, round(45.5)=46, round(90.5)=91.)
    const expected: Record<DistanceBand, Record<string, number>> = {
        adjacent:  { foot: 1, cart: 1, horseback: 1, flying: 1 },
        nearby:    { foot: 1, cart: 1, horseback: 1, flying: 1 },
        local:     { foot: 2, cart: 1, horseback: 1, flying: 1 },
        regional:  { foot: 4, cart: 3, horseback: 2, flying: 1 },
        far:       { foot: 8, cart: 5, horseback: 3, flying: 2 },
        distant:   { foot: 16, cart: 10, horseback: 6, flying: 3 },
        remote:    { foot: 31, cart: 19, horseback: 12, flying: 5 },
        farthest:  { foot: 51, cart: 31, horseback: 19, flying: 8 },
    };

    it.each(
        DISTANCE_BANDS.flatMap(band =>
            TRAVEL_MODES.map(mode => [band.id, mode.id, expected[band.id][mode.id]] as const),
        ),
    )('%s × %s produces the expected leg count', (band, mode, legs) => {
        expect(legsFor(band as DistanceBand, mode as never)).toBe(legs);
    });

    it('farthest never produces Infinity or NaN', () => {
        for (const mode of TRAVEL_MODES) {
            const legs = legsFor('farthest', mode.id);
            expect(Number.isFinite(legs)).toBe(true);
            expect(Number.isNaN(legs)).toBe(false);
        }
    });

    it('the floor is always at least 1', () => {
        for (const band of DISTANCE_BANDS) {
            for (const mode of TRAVEL_MODES) {
                expect(legsFor(band.id, mode.id)).toBeGreaterThanOrEqual(1);
            }
        }
    });

    it('adjacent yields 1 (defensive — adjacent departures never enter the travel state)', () => {
        for (const mode of TRAVEL_MODES) {
            expect(legsFor('adjacent', mode.id)).toBe(1);
        }
    });

    it('is deterministic — same inputs always produce the same legs', () => {
        for (const band of DISTANCE_BANDS) {
            for (const mode of TRAVEL_MODES) {
                const a = legsFor(band.id, mode.id);
                const b = legsFor(band.id, mode.id);
                expect(a).toBe(b);
            }
        }
    });
});