import { describe, expect, it } from 'vitest';
import {
    toPathfinderMode,
    modeIgnoresTerrain,
    costToLegs,
    octileDistance,
    bandFromGrids,
    PATHFINDER_MODES,
    BASE_GRIDS_PER_DAY,
} from '../travelModeMap';

describe('toPathfinderMode', () => {
    it('maps foot → foot', () => {
        expect(toPathfinderMode('foot')).toBe('foot');
    });
    it('maps cart → cart', () => {
        expect(toPathfinderMode('cart')).toBe('cart');
    });
    it('maps horseback → mount', () => {
        expect(toPathfinderMode('horseback')).toBe('mount');
    });
    it('maps flying → null (no terrain routing)', () => {
        expect(toPathfinderMode('flying')).toBeNull();
    });
});

describe('modeIgnoresTerrain', () => {
    it('only flying ignores terrain', () => {
        expect(modeIgnoresTerrain('flying')).toBe(true);
        expect(modeIgnoresTerrain('foot')).toBe(false);
        expect(modeIgnoresTerrain('cart')).toBe(false);
        expect(modeIgnoresTerrain('horseback')).toBe(false);
    });
});

describe('costToLegs', () => {
    it('returns at least 1 leg for any positive cost', () => {
        expect(costToLegs(0.1, 'foot')).toBeGreaterThanOrEqual(1);
        expect(costToLegs(0.1, 'cart')).toBeGreaterThanOrEqual(1);
    });
    it('derives days from the WO 3 speed model, not the pathfinder speed', () => {
        // 30 cost units at foot multiplier 1.0 → 30 raw grids / 3 grids/day = 10 days.
        expect(costToLegs(30, 'foot', 1.0)).toBe(10);
        // 30 cost units at cart multiplier 0.6 → 50 raw grids / 5 grids/day = 10 days.
        expect(costToLegs(30, 'cart', 0.6)).toBe(10);
    });
    it('flying uses gridsPerDay 20', () => {
        expect(costToLegs(40, 'flying', 1.0)).toBe(2);
    });
});

describe('octileDistance', () => {
    it('is the Chebyshev + diagonal distance', () => {
        expect(octileDistance(0, 0, 3, 0)).toBe(3);
        expect(octileDistance(0, 0, 3, 3)).toBeCloseTo(3 * Math.SQRT2, 6);
        expect(octileDistance(0, 0, 3, 4)).toBeCloseTo(1 + 3 * Math.SQRT2, 6);
    });
});

describe('bandFromGrids', () => {
    it('maps a grid count to the tightest containing band', () => {
        expect(bandFromGrids(1)).toBe('nearby');
        expect(bandFromGrids(5)).toBe('local');
        expect(bandFromGrids(10)).toBe('regional');
        expect(bandFromGrids(25)).toBe('far');
        expect(bandFromGrids(200)).toBe('farthest');
    });
});

describe('PATHFINDER_MODES', () => {
    it('mirrors the pathfinder.js mode table', () => {
        expect(PATHFINDER_MODES.foot.impassable.has('ocean')).toBe(true);
        expect(PATHFINDER_MODES.cart.impassable.has('mountain')).toBe(true);
        expect(PATHFINDER_MODES.cart.impassable.has('marsh')).toBe(true);
        expect(PATHFINDER_MODES.mount.impassable.has('glacier')).toBe(true);
        expect(PATHFINDER_MODES.boat.impassable.has('ocean')).toBe(false);
    });
});

describe('BASE_GRIDS_PER_DAY', () => {
    it('is 3, matching distance.ts and pathfinder.js', () => {
        expect(BASE_GRIDS_PER_DAY).toBe(3);
    });
});