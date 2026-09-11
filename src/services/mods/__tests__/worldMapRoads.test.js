import { it, expect } from 'vitest';
import { planRoad, readRoads, serializeRoads, travelSurfaces, roadCandidates, roadConnectedLedger } from '../../../../public/bundled-mods/worldmap/roads.js';
import { findRoute } from '../../../../public/bundled-mods/worldmap/pathfinder.js';
const plains = { getCell: () => ({ biome: 'plains' }) };
it('routes through each manual waypoint and preserves contiguous geometry through reload', () => {
    const points = [{ x: 10, y: 10 }, { x: 13, y: 14 }, { x: 17, y: 10 }];
    const draft = planRoad(plains, points, 'path');
    expect(draft.blocked).toBeUndefined(); expect(draft.cells).toContainEqual(points[1]);
    expect(draft.cells[0]).toEqual(points[0]); expect(draft.cells.at(-1)).toEqual(points[2]);
    const saved = readRoads(JSON.parse(JSON.stringify(serializeRoads([{ ...draft, id: 'manual', name: 'Ridge path' }]))));
    expect(saved[0].cells).toEqual(draft.cells); expect(saved[0].name).toBe('Ridge path');
});
it('rejects water endpoints, duplicated waypoints and excessive segments without snapping', () => {
    expect(planRoad({ getCell: () => ({ biome: 'ocean' }) }, [{ x: 1, y: 1 }, { x: 4, y: 1 }], 'road').blocked).toBe(true);
    expect(planRoad(plains, [{ x: 1, y: 1 }, { x: 1, y: 1 }]).blocked).toBe(true);
    expect(planRoad(plains, [{ x: 1, y: 1 }, { x: 200, y: 1 }]).blocked).toBe(true);
    expect(readRoads({ routes: [{ id: 'bad', kind: 'road', cells: [{ x: 1, y: 1 }, { x: 9, y: 9 }] }] })).toEqual([]);
});
it('reduces travel cost without stacking discounts, and removal restores the old cost', () => {
    const a = { x: 10, y: 10 }, b = { x: 20, y: 10 };
    const draft = planRoad(plains, [a, b], 'road');
    const roads = [{ ...draft, id: 'road' }];
    const base = findRoute(plains, a, b, 'foot');
    const surfaces = travelSurfaces(null, roads);
    const travelled = findRoute(plains, a, b, 'foot', { trails: surfaces });
    expect(travelled.cost).toBeCloseTo(base.cost * 0.7);
    expect(findRoute(plains, a, b, 'foot', { trails: travelSurfaces(surfaces, roads) }).cost).toBeCloseTo(travelled.cost);
    expect(findRoute(plains, a, b, 'foot', { trails: travelSurfaces(null, []) }).cost).toBeCloseTo(base.cost);
});
it('generates bounded unique connections and excludes already saved roads and wilderness targets', () => {
    const anchors = [{ locationId: 'a', x: 10, y: 10 }, { locationId: 'b', x: 20, y: 10 }, { locationId: 'point', x: 11, y: 10 }];
    const ledger = [{ id: 'a', connections: [{ toId: 'b' }] }, { id: 'b', connections: [{ toId: 'a' }] }];
    expect(roadCandidates(anchors, ledger, [{ id: 'point', type: 'wilderness' }], [])).toHaveLength(1);
    expect(roadCandidates(anchors, ledger, [], [{ fromId: 'a', toId: 'b' }])).toHaveLength(0);
    const combined = roadConnectedLedger([{ id: 'a', connections: [] }, { id: 'b', connections: [] }], [{ fromId: 'a', toId: 'b' }]);
    expect(combined[0].connections).toEqual([{ toId: 'b' }]);
});
