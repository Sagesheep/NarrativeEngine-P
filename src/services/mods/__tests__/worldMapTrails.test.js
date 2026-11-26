import { describe, it, expect } from 'vitest';
import { findRoute } from '../../../../public/bundled-mods/worldmap/pathfinder.js';
import { readTrails, recordTrailProgress, serializeTrails, trailMultiplier } from '../../../../public/bundled-mods/worldmap/trails.js';

const plain = { getCell: () => ({ biome: 'plains' }) };
const trip = { id: 'one', mode: 'foot', cells: Array.from({ length: 10 }, (_, x) => ({ x, y: 0 })) };
describe('physical trails', () => {
    it('wears only travelled segments, survives reload, and caps repeated wear', () => {
        let trails = readTrails(null);
        recordTrailProgress(trails, trip, 3);
        expect(trails.edges.size).toBe(3);
        trails = readTrails(JSON.parse(JSON.stringify(serializeTrails(trails))));
        expect(recordTrailProgress(trails, trip, 3)).toBe(false);
        expect(trailMultiplier(trails, trip.cells[0], trip.cells[1])).toBeCloseTo(0.9);
        for (let i = 0; i < 8; i++) recordTrailProgress(trails, { ...trip, id: `repeat-${i}` }, 3);
        expect(trailMultiplier(trails, trip.cells[0], trip.cells[1])).toBeCloseTo(0.7);
        expect(trailMultiplier(trails, trip.cells[3], trip.cells[4])).toBe(1);
        expect(recordTrailProgress(trails, { ...trip, mode: 'flying' }, 9)).toBe(false);
    });
    it('makes a longer established trail faster while shortest retains actual time costs', () => {
        const trails = readTrails(null);
        const detour = { ...trip, cells: [{ x: 0, y: 0 }, ...Array.from({ length: 10 }, (_, x) => ({ x, y: 1 })), { x: 9, y: 0 }] };
        for (let i = 0; i < 3; i++) recordTrailProgress(trails, { ...detour, id: `${i}` }, 11);
        const fastest = findRoute(plain, trip.cells[0], trip.cells[9], 'foot', { trails });
        const shortest = findRoute(plain, trip.cells[0], trip.cells[9], 'foot', { trails, preference: 'shortest' });
        expect(fastest.cost).toBeLessThan(shortest.cost);
        expect(shortest.cells.every(c => c.y === 0)).toBe(true);
        expect(shortest.cost).toBe(9);
        expect(fastest.cells.at(-1).cost).toBeCloseTo(fastest.cost);
    });
    it('never makes impassable terrain passable', () => {
        const trails = readTrails(null);
        recordTrailProgress(trails, trip, 9);
        expect(findRoute({ getCell: () => ({ biome: 'ocean' }) }, trip.cells[0], trip.cells[9], 'foot', { trails }).blocked).toBe(true);
    });
});
