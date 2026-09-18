import { expect, it, vi } from 'vitest';
import { solveAndPersist, mapSnapshot } from '../../../../public/bundled-mods/worldmap/index.js';
import { biomeAt, buildWarpField } from '../../../../public/bundled-mods/worldmap/field.js';
import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';
const seed = 'destination-regression';
const place = (id, name, coordinates) => ({ id, name, aliases: '', connections: [], features: ['Gate'], description: 'Existing lore', coordinates });
function oceanCell() {
    for (let y = 800; y < 950; y++) for (let x = 800; x < 950; x++) if (biomeAt(x, y, seed, 0.65).biome === 'ocean') return { x, y };
    throw Error('Expected an ocean fixture');
}
function context(id, ledger) {
    const tables = new Map([['settings', { worldSeed: seed, climateGradient: 0.65 }], ['visited', []]]);
    const ctx = { data: { campaignId: id, loreChunks: [], location: { currentPlaceId: 'camp', worldDay: 4, ledger } },
        table: { read: vi.fn(async name => tables.get(name)), write: vi.fn(async (name, value) => tables.set(name, value)) },
        write: { setLocationLedger: vi.fn(async entries => { ctx.data.location.ledger = entries; }) } };
    ctx.refresh = async () => ctx;
    return ctx;
}
it('saves independent destinations outside explored terrain and reuses them on reload', async () => {
    const ctx = context('destination-first', [place('camp', 'Camp', { x: 100, y: 100 })]);
    await solveAndPersist(ctx);
    ctx.data.location.ledger.push(place('gate', "Baldur's Gate"));
    await solveAndPersist(ctx);
    const saved = JSON.parse(JSON.stringify(ctx.data.location.ledger));
    expect(saved[1].coordinates).toBeDefined();
    expect(saved[1].coordinates).not.toEqual(saved[0].coordinates);
    expect(saved[0]).toMatchObject({ coordinates: { x: 100, y: 100 }, features: ['Gate'], description: 'Existing lore' });
    const reload = context('destination-reloaded', [...saved, place('third', 'Another place')]);
    await solveAndPersist(reload);
    expect(reload.data.location.ledger.slice(0, 2)).toEqual(saved);
    expect(reload.data.location.currentPlaceId).toBe('camp');
    expect(mapSnapshot(reload).explored.size).toBe(0);
    expect(mapSnapshot(reload).visible.has(`${saved[1].coordinates.x},${saved[1].coordinates.y}`)).toBe(false);
    expect(reload.table.write.mock.calls.some(([name]) => name === 'exploration')).toBe(false);
});
it('a saved ocean destination gets compatible terrain immediately and on every re-solve', async () => {
    const cell = oceanCell();
    const ctx = context('destination-ocean', [place('camp', 'Camp', { x: 100, y: 100 }), place('gate', "Baldur's Gate", cell)]);
    expect(biomeAt(cell.x, cell.y, seed, 0.65).biome).toBe('ocean');
    for (let i = 0; i < 3; i++) {
        await solveAndPersist(ctx);
        const snapshot = mapSnapshot(ctx);
        expect(snapshot.chunkStore.getCell(cell.x, cell.y).biome).not.toBe('ocean');
        expect(snapshot.explored.has(`${cell.x},${cell.y}`)).toBe(false);
        expect(snapshot.visible.has(`${cell.x},${cell.y}`)).toBe(false);
        expect(ctx.data.location.ledger[1].coordinates).toEqual(cell);
    }
});
it('terrain requirements survive authored ocean conflicts but preserve already explored campaign terrain', () => {
    const cell = oceanCell();
    const result = solveWorldMap({ worldSeed: seed, locations: [place('gate', "Baldur's Gate", cell)],
        loreChunks: [{ id: 'l', header: "LOCATION -- Baldur's Gate", category: 'location', content: '**Terrain:** ocean' }] });
    const controls = buildWarpField(result.transects);
    expect(biomeAt(cell.x, cell.y, seed, 0.65, controls).biome).not.toBe('ocean');
    const hardened = new Map([[`${cell.x}\u241f${cell.y}`, 'ocean']]);
    expect(biomeAt(cell.x, cell.y, seed, 0.65, controls, hardened).biome).toBe('ocean');
});
it('waits for AI placement before assigning coordinates, then persists the generated biome across reload', async () => {
    const ctx = context('placement-async', [place('camp', 'Camp', { x: 100, y: 100 }),
        { ...place('castle', 'Frostmourne Castle'), placementPendingUntil: Date.now() + 300000 }]);
    await solveAndPersist(ctx);
    expect(ctx.data.location.ledger[1].coordinates).toBeUndefined();
    expect(mapSnapshot(ctx).anchors.some(anchor => anchor.locationId === 'castle')).toBe(false);
    ctx.data.location.ledger[1] = { ...ctx.data.location.ledger[1], placementPendingUntil: undefined,
        placement: { referencePlaceId: 'camp', distanceBand: 'remote', direction: 'e', preferredBiomes: ['snow'] } };
    await solveAndPersist(ctx);
    const placed = ctx.data.location.ledger[1];
    expect(placed.coordinates.x - 100).toBeGreaterThanOrEqual(61);
    expect(placed.coordinates.x - 100).toBeLessThanOrEqual(120);
    expect(placed.terrainBiome).toBe('snow');
    expect(mapSnapshot(ctx).chunkStore.getCell(placed.coordinates.x, placed.coordinates.y).biome).toBe('snow');
    const reload = context('placement-async-reloaded', JSON.parse(JSON.stringify(ctx.data.location.ledger)));
    await solveAndPersist(reload);
    const snapshot = mapSnapshot(reload);
    expect(snapshot.chunkStore.getCell(placed.coordinates.x + 3, placed.coordinates.y).biome).toBe('snow');
    expect(reload.data.location.ledger[1].coordinates).toEqual(placed.coordinates);
    expect(snapshot.explored.size).toBe(0);
    expect(reload.data.location.currentPlaceId).toBe('camp');
});
