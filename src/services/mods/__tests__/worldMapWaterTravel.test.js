import { expect, it } from 'vitest';
import { waterRoute } from '../../../../public/bundled-mods/worldmap/waterTravel.js';
import { recordTrailProgress, readTrails } from '../../../../public/bundled-mods/worldmap/trails.js';
it('embarks and disembarks at the coast without changing terrain', () => {
    const store = { getCell: (x, y) => ({ biome: y === 500 && x > 500 && x < 505 ? 'ocean' : 'plains' }) };
    const result = waterRoute(store, { x: 500, y: 500 }, { x: 505, y: 500 });
    expect(result.blocked).toBeUndefined();
    expect(result.cells).toHaveLength(6);
    expect(store.getCell(500,500).biome).toBe('plains');
    expect(waterRoute(store, { x: 490, y: 500 }, { x: 505, y: 500 }).blocked).toBe(true);
});
it('cannot sail across an ice or land barrier', () => {
    const store = { getCell: (x, y) => ({ biome: x === 502 ? 'snow' : y === 500 && x >= 500 && x <= 505 ? 'ocean' : 'plains' }) };
    expect(waterRoute(store, { x: 500, y: 500 }, { x: 505, y: 500 }).blocked).toBe(true);
});
it('underground and boat journeys do not create surface trails', () => {
    for (const extra of [{ mode: 'boat' }, { mode: 'foot', surfaceTravel: false }]) {
        const trails = readTrails(null);
        expect(recordTrailProgress(trails, { id: 'trip', cells: [{ x: 500, y: 500 }, { x: 501, y: 500 }], ...extra }, 1)).toBe(false);
        expect(trails.edges.size).toBe(0);
    }
});
