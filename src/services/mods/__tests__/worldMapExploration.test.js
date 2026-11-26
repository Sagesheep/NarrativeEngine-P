import { it, expect } from 'vitest';
import { readGeneratedCells, cellVisibility, observedTerrainStore, revealCells, visibleCells, readExploration, serializeExploration, explorationPoint } from '../../../../public/bundled-mods/worldmap/exploration.js';
import { canPlaceSite, minimumSiteDistance } from '../../../../public/bundled-mods/worldmap/discoveries.js';
it('reveals a travelled corridor, not the untravelled remainder, and survives reload', () => {
    const explored = new Set();
    const route = Array.from({ length: 20 }, (_, x) => ({ x: x + 10, y: 20 }));
    expect(revealCells(explored, route.slice(0, 6))).toBe(true);
    expect(explored.has('13,20')).toBe(true);
    expect(explored.has('29,20')).toBe(false);
    expect(explored.has('12,25')).toBe(false);
    const loaded = readExploration(JSON.parse(JSON.stringify(serializeExploration(explored))));
    expect(loaded).toEqual(explored); expect(revealCells(loaded, route.slice(0, 6))).toBe(false);
    expect(visibleCells(route[5]).has('10,20')).toBe(false);
    expect(loaded.has('10,20')).toBe(true);
});
it('bounds visible cells and rejects malformed persistence or destinations', () => {
    expect(visibleCells({ x: 0, y: 0 }).has('-1,0')).toBe(false);
    expect(readExploration({ cells: ['bad', '-1,0', '1,2', '1,2,3', '1.2,3'] })).toEqual(new Set(['1,2']));
    expect(explorationPoint('seed', -1, 0)).toBeNull();
    expect(explorationPoint('seed', 4, 5)).toEqual(explorationPoint('seed', 4, 5));
    expect(explorationPoint('seed', 4, 5).type).toBe('wilderness');
});
it('keeps capitals apart while allowing smaller settlements nearer a capital', () => {
    const capital = { id: 'capital', type: 'settlement', settlementKind: 'capital', x: 100, y: 100 };
    expect(minimumSiteDistance(capital, { ...capital, id: 'other' })).toBe(40);
    expect(canPlaceSite({ ...capital, id: 'other', x: 139 }, [capital])).toBe(false);
    expect(canPlaceSite({ ...capital, id: 'other', x: 140 }, [capital])).toBe(true);
    expect(canPlaceSite({ ...capital, id: 'village', settlementKind: 'village', x: 108 }, [capital])).toBe(true);
    expect(canPlaceSite({ ...capital, id: 'village', settlementKind: 'village', x: 107 }, [capital])).toBe(false);
    expect(canPlaceSite({ ...capital, id: 'new' }, [{ ...capital, type: 'wilderness' }])).toBe(true);
});

it('keeps visibility independent from persisted generation and migrates old explored cells', () => {
    const generated = new Set(['1,1', '2,1']);
    const visible = new Set(['2,1', '3,1']);
    expect(cellVisibility('1,1', generated, visible)).toBe('known');
    expect(cellVisibility('2,1', generated, visible)).toBe('visible');
    expect(cellVisibility('3,1', generated, visible)).toBe('ungenerated');
    const saved = serializeExploration(new Set(['1,1', '2,1', '9,9']), generated);
    expect(saved.version).toBe(2);
    expect(readGeneratedCells(saved)).toEqual(generated);
    expect(readGeneratedCells(saved).has('9,9')).toBe(false);
    expect(readGeneratedCells({ cells: ['1,1'] })).toEqual(new Set(['1,1']));
});
it('never samples an unknown cell for painting, including neighbour lookups', () => {
    const reads = [];
    const store = observedTerrainStore({ getCell: (x, y) => { reads.push(`${x},${y}`); return { biome: 'forest' }; } }, new Set(['4,5']));
    expect(store.getCell(4, 5)).toEqual({ biome: 'forest' });
    expect(store.getCell(4, 6)).toBeNull();
    expect(store.getCell(90, 90)).toBeNull();
    expect(reads).toEqual(['4,5']);
});
