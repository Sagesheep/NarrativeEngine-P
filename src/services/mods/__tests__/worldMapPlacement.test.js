import { describe, expect, it } from 'vitest';
import { BIOME_TARGETS, buildPlacementContext, pendingPlacement, resolvePlacements, terrainTransects } from '../../../../public/bundled-mods/worldmap/placement.js';
import { biomeAt, buildWarpField, classifyBiome, ChunkStore } from '../../../../public/bundled-mods/worldmap/field.js';
import { DISTANCE_BANDS } from '../../../../public/bundled-mods/worldmap/solver.js';
const origin = { x: 10, y: 10 };
const camp = { id: 'camp', name: 'Camp', coordinates: origin };
const castle = { id: 'castle', name: 'Frostmourne Castle', placement: { referencePlaceId: 'camp', preferredBiomes: ['snow'], distanceBand: 'remote', direction: 'se' } };
const options = extra => ({ worldSize: 100, player: origin, bands: DISTANCE_BANDS, store: { getCell: () => ({ biome: 'savanna' }) }, ...extra });
const fullMap = size => new Set(Array.from({ length: size * size }, (_, i) => `${i % size},${Math.floor(i / size)}`));

describe('point of interest geography', () => {
    it('prefers suitable known terrain at the requested distance and direction', () => {
        const explored = new Set(['60,60', '5,5', '40,70']);
        const store = { getCell: (x, y) => ({ biome: x === 60 && y === 60 ? 'snow' : 'savanna' }) };
        const result = resolvePlacements([camp, castle], options({ explored, store }));
        expect(result[1].coordinates).toEqual({ x: 60, y: 60 });
        expect(result[1].terrainBiome).toBeUndefined();
        expect(explored).toEqual(new Set(['60,60', '5,5', '40,70']));
        expect(result[0]).toBe(camp);
    });
    it('generates an ice region with a stable core and gradual falloff without exploration', () => {
        const explored = new Set(['10,10']);
        const result = resolvePlacements([camp, castle], options({ explored }));
        const placed = result[1];
        expect(placed.terrainBiome).toBe('snow');
        expect(Math.hypot(placed.coordinates.x - 10, placed.coordinates.y - 10)).toBeGreaterThanOrEqual(61);
        expect(placed.coordinates.x).toBeGreaterThan(10); expect(placed.coordinates.y).toBeGreaterThan(10);
        const controls = buildWarpField(terrainTransects(result));
        const store = new ChunkStore('ice-region', 0.65, controls, new Map([['10\u241f10', 'savanna']]));
        const { x, y } = placed.coordinates;
        for (const [dx, dy] of [[0,0],[3,0],[-3,0],[0,3],[0,-3]]) expect(store.getCell(x + dx, y + dy).biome).toBe('snow');
        const core = biomeAt(x, y, 'ice-region', 0.65, controls);
        const transition = biomeAt(x + 5, y, 'ice-region', 0.65, controls);
        const untouched = biomeAt(x + 8, y, 'ice-region', 0.65, controls);
        expect(transition.temp).not.toBe(core.temp);
        expect(untouched).toEqual(biomeAt(x + 8, y, 'ice-region', 0.65));
        expect(store.getCell(10, 10).biome).toBe('savanna');
        expect(explored).toEqual(new Set(['10,10']));
        const loaded = JSON.parse(JSON.stringify(result));
        expect(resolvePlacements(loaded, options({ player: { x: 90, y: 5 } }))).toBe(loaded);
        expect(terrainTransects(loaded)).toEqual(terrainTransects(result));
    });
    it('uses compatible existing terrain on a fully explored map, reporting relaxed distance', () => {
        const explored = fullMap(32);
        const store = { getCell: (x, y) => ({ biome: x === 20 && y === 20 ? 'snow' : 'savanna' }) };
        const result = resolvePlacements([camp, castle], options({ worldSize: 32, explored, store }));
        expect(result[1].coordinates).toEqual({ x: 20, y: 20 });
        expect(result[1].terrainBiome).toBeUndefined();
        expect(result[1].placementIssue).toContain('fully explored');
        expect(explored.size).toBe(1024);
    });
    it('reports a conflict rather than making an ice castle in fully explored savanna', () => {
        const explored = fullMap(32);
        const result = resolvePlacements([camp, castle], options({ worldSize: 32, explored }));
        expect(result[1].coordinates).toBeUndefined();
        expect(result[1].terrainBiome).toBeUndefined();
        expect(result[1].placementIssue).toContain('No compatible site');
        expect(terrainTransects(result)).toEqual([]);
    });
    it('honors a valid explicit candidate and avoids explored cells throughout the region', () => {
        const request = { ...castle, placement: { ...castle.placement, coordinates: { x: 70, y: 70 } } };
        expect(resolvePlacements([camp, request], options())[1].coordinates).toEqual({ x: 70, y: 70 });
        const explored = new Set(['72,70']);
        const placed = resolvePlacements([camp, request], options({ explored }))[1];
        expect(Math.hypot(placed.coordinates.x - 72, placed.coordinates.y - 70)).toBeGreaterThan(8);
        const controls = buildWarpField(terrainTransects([placed]));
        expect(biomeAt(72, 70, 'protected', 0.65, controls)).toEqual(biomeAt(72, 70, 'protected', 0.65));
    });
    it('does not overwrite another point of interest or move saved coordinates', () => {
        const saved = { ...castle, coordinates: { x: 70, y: 70 }, terrainBiome: 'snow' };
        const other = { ...castle, id: 'other', placement: { ...castle.placement, coordinates: saved.coordinates } };
        const result = resolvePlacements([camp, saved, other], options());
        expect(result[1]).toBe(saved);
        expect(Math.hypot(result[2].coordinates.x - 70, result[2].coordinates.y - 70)).toBeGreaterThan(16);
    });
    it('waits for enrichment and recovers after an interrupted request expires', () => {
        const pending = { ...castle, placementPendingUntil: Date.now() + 1000 };
        expect(pendingPlacement(pending)).toBe(true);
        const ledger = [camp, pending];
        expect(resolvePlacements(ledger, options())).toBe(ledger);
        const expired = { ...pending, placementPendingUntil: Date.now() - 1 };
        expect(resolvePlacements([camp, expired], options())[1].coordinates).toBeDefined();
    });
    it('does not infer terrain from evocative names without geographic evidence', () => {
        const result = resolvePlacements([camp, { id: 'castle', name: 'Frostmourne Castle', placement: { preferredBiomes: [] } }], options());
        expect(result[1].terrainBiome).toBeUndefined();
        expect(result[1].coordinates).toBeDefined();
    });
    it('all biome targets classify to their declared biome', () => {
        for (const [biome, target] of Object.entries(BIOME_TARGETS)) expect(classifyBiome(target), biome).toBe(biome);
    });
    it('reports directional exploration extents without treating holes as explored', () => {
        const explored = new Set(['10,2', '10,20', '1,10', '25,10']);
        const context = buildPlacementContext({ party: origin, locationId: 'camp', anchors: [{ locationId: 'camp', ...origin }], explored,
            generated: new Set(['50,50']), chunkStore: { getCell: () => ({ biome: 'savanna' }) } }, 100);
        expect(context.player).toEqual({ x: 10, y: 10, placeId: 'camp', biome: 'savanna' });
        expect(context.exploredBounds).toEqual({ north: 2, south: 20, west: 1, east: 25 });
        expect(context.exploredReach).toEqual({ north: 8, south: 10, west: 9, east: 15 });
        expect(context.fullyExplored).toBe(false); expect(context.exploredCells).toBe(4);
        expect(context.boundsAreNotCoverage).toBe(true);
        expect(context.terrainSamples[0].cells).toContainEqual({ x: 50, y: 50, explored: false });
    });
});
it('can place a nearby destination on compatible natural terrain without reshaping explored neighbours', () => {
    const request = { id: 'inn', name: 'Wayside Inn', placement: { referencePlaceId: 'camp', distanceBand: 'local', preferredBiomes: ['savanna'], direction: 'e' } };
    const result = resolvePlacements([camp, request], options({ explored: new Set(['10,10']) }));
    expect(result[1].coordinates).toEqual({ x: 15, y: 10 });
    expect(result[1].terrainBiome).toBeUndefined();
});
it('tolerates malformed persisted hints without allowing prototype properties as directions', () => {
    const request = { ...castle, placement: { preferredBiomes: 'snow', direction: '__proto__', coordinates: { x: -10, y: 2000 }, distanceBand: 'local' } };
    const result = resolvePlacements([camp, request], options());
    expect(result[1].coordinates).toBeDefined();
    expect(result[1].coordinates.x).toBeGreaterThanOrEqual(0);
});

it('treats a biome preference as optional on a fully explored map', () => {
    const lodge = { id: 'lodge', placement: { preferredBiomes: ['forest'], biomePolicy: 'preferred' } };
    const result = resolvePlacements([camp, lodge], options({ worldSize: 32, explored: fullMap(32) }));
    expect(result[1].coordinates).toBeDefined();
    expect(result[1].terrainBiome).toBeUndefined();
    expect(terrainTransects(result)).toEqual([]);
});
it('ranks existing preferred terrain ahead of other suitable land', () => {
    const lodge = { id: 'lodge', placement: { preferredBiomes: ['forest'], biomePolicy: 'preferred', coordinates: { x: 20, y: 20 } } };
    const result = resolvePlacements([camp, lodge], options({ explored: new Set(['20,20', '30,30']),
        store: { getCell: (x, y) => ({ biome: x === 30 && y === 30 ? 'forest' : 'savanna' }) } }));
    expect(result[1].coordinates).toEqual({ x: 30, y: 30 });
});
it('honors explicit surrounding terrain for an exceptional building instead of its name', () => {
    const entry = { id: 'ice', name: 'Frozen Castle', description: 'Magical ice walls stand in a desert.',
        placement: { preferredBiomes: ['desert'], biomePolicy: 'exception', coordinates: { x: 60, y: 60 }, biomeRadius: 5 } };
    const result = resolvePlacements([camp, entry], options());
    expect(result[1].terrainBiome).toBe('desert');
    expect(result[1].terrainRadius).toBe(5);
    const reloaded = JSON.parse(JSON.stringify(result));
    const controls = terrainTransects(reloaded);
    expect(controls[0].noiseResumeDistance).toBe(5);
    expect(resolvePlacements(reloaded, options())).toBe(reloaded);
});
it('keeps the entire requested region away from explored ground', () => {
    const entry = { ...castle, placement: { ...castle.placement, biomeRadius: 20, coordinates: { x: 70, y: 70 } } };
    const result = resolvePlacements([camp, entry], options({ explored: new Set(['72,70']) }));
    expect(result[1].terrainRadius).toBe(20);
    expect(Math.hypot(result[1].coordinates.x - 72, result[1].coordinates.y - 70)).toBeGreaterThan(20);
});
it('uses stable varied bearings when no direction is supplied', () => {
    const quadrants = new Set();
    for (let i = 0; i < 40; i++) {
        const entry = { id: 'destination-' + i, placement: { preferredBiomes: [] } };
        const opts = options({ player: { x: 50, y: 50 } });
        const first = resolvePlacements([entry], opts)[0].coordinates;
        expect(resolvePlacements([entry], opts)[0].coordinates).toEqual(first);
        quadrants.add((first.x >= 50 ? 'e' : 'w') + (first.y >= 50 ? 's' : 'n'));
    }
    expect(quadrants.size).toBeGreaterThan(1);
});
