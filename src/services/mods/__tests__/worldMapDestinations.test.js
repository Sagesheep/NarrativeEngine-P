import { expect, it, vi } from 'vitest';
import { solveAndPersist, mapSnapshot, computeRoutePreview } from '../../../../public/bundled-mods/worldmap/index.js';
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

it('previews an unconnected destination overland without changing geography, visibility or position', async () => {
    const ctx = context('overland-preview', [
        { ...place('camp', 'Camp', { x: 500, y: 500 }), terrainBiome: 'plains' },
        { ...place('gate', 'Gate', { x: 504, y: 500 }), terrainBiome: 'plains' },
    ]);
    await solveAndPersist(ctx);
    const before = JSON.stringify(ctx.data.location);
    ctx.table.write.mockClear();
    ctx.write.setLocationLedger.mockClear();
    const preview = computeRoutePreview(ctx, ctx.data.campaignId, 504, 500, 'foot');
    expect(preview.blocked).toBeUndefined();
    expect(preview.cells[0]).toMatchObject({ x: 500, y: 500 });
    expect(preview.cells.at(-1)).toMatchObject({ x: 504, y: 500 });
    expect(preview.hops).toEqual([expect.objectContaining({ fromId: 'camp', toId: 'gate', legs: preview.days })]);
    expect(preview.days).toBeGreaterThan(0);
    expect(JSON.stringify(ctx.data.location)).toBe(before);
    expect(ctx.table.write).not.toHaveBeenCalled();
    expect(ctx.write.setLocationLedger).not.toHaveBeenCalled();
    expect(mapSnapshot(ctx).explored.size).toBe(0);
    expect(mapSnapshot(ctx).generated.size).toBe(0);
});
it('retains recorded intermediate stops instead of making a direct shortcut', async () => {
    const ledger = [place('camp', 'Camp', { x: 500, y: 500 }), place('middle', 'Middle', { x: 503, y: 500 }), place('gate', 'Gate', { x: 506, y: 500 })];
    ledger[0].connections = [{ toId: 'middle' }];
    ledger[1].connections = [{ toId: 'gate' }];
    const ctx = context('overland-recorded', ledger);
    await solveAndPersist(ctx);
    const preview = computeRoutePreview(ctx, ctx.data.campaignId, 506, 500, 'flying');
    expect(preview.blocked).toBeUndefined();
    expect(preview.hops.map(h => [h.fromId, h.toId])).toEqual([['camp', 'middle'], ['middle', 'gate']]);
});
it('does not let an unconnected overland route snap a cart destination off impassable terrain', async () => {
    const ctx = context('overland-blocked', [
        { ...place('camp', 'Camp', { x: 500, y: 500 }), terrainBiome: 'plains' },
        { ...place('gate', 'Mountain gate', { x: 506, y: 500 }), terrainBiome: 'mountain' },
    ]);
    await solveAndPersist(ctx);
    expect(computeRoutePreview(ctx, ctx.data.campaignId, 506, 500, 'cart').blocked).toBeTruthy();
    const flying = computeRoutePreview(ctx, ctx.data.campaignId, 506, 500, 'flying');
    expect(flying.blocked).toBeUndefined();
    expect(flying.cells.at(-1)).toMatchObject({ x: 506, y: 500 });
});

it('keeps secret and rumoured true coordinates out of map anchors and blocks direct travel', async () => {
    const ctx = context('knowledge-map', [place('camp', 'Camp', { x: 500, y: 500 }),
        { ...place('rumour', 'Lost Castle', { x: 551, y: 541 }), knowledge: 'rumoured' },
        { ...place('secret', 'Hidden Vault', { x: 600, y: 600 }), knowledge: 'secret' }]);
    await solveAndPersist(ctx);
    const snapshot = mapSnapshot(ctx);
    expect(snapshot.anchors.map(anchor => anchor.locationId)).toEqual(['camp']);
    expect(snapshot.rumours).toHaveLength(1);
    expect(snapshot.rumours[0]).toMatchObject({ name: 'Lost Castle', radius: 24 });
    expect(snapshot.rumours[0]).not.toMatchObject({ x: 551, y: 541 });
    for (const id of ['rumour', 'secret']) {
        const target = ctx.data.location.ledger.find(place => place.id === id);
        expect(computeRoutePreview(ctx, ctx.data.campaignId, target.coordinates.x, target.coordinates.y, 'flying', 'fastest', false, id))
            .toMatchObject({ blocked: true, reason: 'unknown-position' });
    }
    const exploratory = computeRoutePreview(ctx, ctx.data.campaignId, 551, 541, 'flying');
    expect(exploratory.toAnchor.locationId).not.toBe('rumour');
    expect(exploratory.toAnchor.name).not.toBe('Lost Castle');
    expect(ctx.data.location.ledger[1].coordinates).toEqual({ x: 551, y: 541 });
    expect(snapshot.explored.size).toBe(0);
});
it('learning directions reveals the existing location and actual arrival marks it visited', async () => {
    const ctx = context('knowledge-upgrade', [place('camp', 'Camp', { x: 500, y: 500 }),
        { ...place('rumour', 'Lost Castle', { x: 551, y: 541 }), knowledge: 'rumoured' }]);
    await solveAndPersist(ctx);
    ctx.data.location.ledger[1].knowledge = 'known';
    await solveAndPersist(ctx);
    expect(mapSnapshot(ctx).anchors.find(anchor => anchor.locationId === 'rumour')).toMatchObject({ x: 551, y: 541 });
    expect(mapSnapshot(ctx).rumours).toEqual([]);
    expect(computeRoutePreview(ctx, ctx.data.campaignId, 551, 541, 'flying').blocked).toBeUndefined();
    expect(ctx.data.location.ledger[1].knowledge).toBe('known');
    ctx.data.location.currentPlaceId = 'rumour';
    await solveAndPersist(ctx);
    expect(ctx.data.location.ledger[1].knowledge).toBe('visited');
    expect(ctx.data.location.ledger[1].coordinates).toEqual({ x: 551, y: 541 });
    const reload = context('knowledge-reload', JSON.parse(JSON.stringify(ctx.data.location.ledger)));
    await solveAndPersist(reload);
    expect(reload.data.location.ledger[1].knowledge).toBe('visited');
});

it.each([['portal', 0], ['tunnel', 120], ['tunnel', 960]])('previews authored %s without surface routing', async (passage, durationMinutes) => {
    const a = place('camp', 'Entrance', { x: 100, y: 100 });
    a.connections = [{ toId: 'exit', passage, durationMinutes }];
    const ctx = context('passage-' + passage + durationMinutes, [a, place('exit', 'Exit', { x: 900, y: 900 })]);
    await solveAndPersist(ctx);
    const before = JSON.stringify(ctx.data.location);
    const preview = computeRoutePreview(ctx, ctx.data.campaignId, 900, 900, 'foot');
    expect(preview.blocked).toBeUndefined();
    expect(preview.surfaceTravel).toBe(false);
    expect(preview.days).toBe(Math.max(1, Math.ceil(durationMinutes / 480)));
    expect(preview.cells).toHaveLength(2);
    expect(JSON.stringify(ctx.data.location)).toBe(before);
    expect(mapSnapshot(ctx).explored.size).toBe(0);
});
it('keeps nearby map travel below one day', async () => {
    const ctx = context('short-flight', [place('camp', 'Camp', { x: 500, y: 500 }), place('next', 'Next', { x: 501, y: 500 })]);
    await solveAndPersist(ctx);
    const preview = computeRoutePreview(ctx, ctx.data.campaignId, 501, 500, 'flying');
    expect(preview.durationMinutes).toBe(24);
    expect(preview.hops[0].durationMinutes).toBe(24);
});
