import { expect, it } from 'vitest';
import { routeKnowledge, estimateLabel } from '../../../../public/bundled-mods/worldmap/routeKnowledge.js';
const cells = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }];
it('estimates uncharted ground travel and keeps the actual duration inside the range', () => {
    const explored = new Set(['1,1']);
    const estimate = routeKnowledge(cells, 4, 'foot', explored);
    expect(estimate.uncertain).toBe(true);
    expect(estimate.minDays).toBeLessThan(4);
    expect(estimate.maxDays).toBeGreaterThan(4);
    expect(estimateLabel(estimate)).toContain('route uncertain');
    expect([...explored]).toEqual(['1,1']);
});
it('uses firm durations for explored paths, authored roads, and direct flight', () => {
    const explored = new Set(cells.map(cell => cell.x + ',' + cell.y));
    for (const estimate of [routeKnowledge(cells, 4, 'foot', explored), routeKnowledge(cells, 4, 'foot', new Set(), [{ cells }]), routeKnowledge(cells, 4, 'flying')]) {
        expect(estimate).toEqual({ uncertain: false, minDays: 4, maxDays: 4 });
    }
});
it('does not treat a partially known road as a complete known route', () => {
    expect(routeKnowledge(cells, 1, 'foot', new Set(), [{ cells: cells.slice(0, 2) }])).toMatchObject({ uncertain: true, minDays: 1 });
});
