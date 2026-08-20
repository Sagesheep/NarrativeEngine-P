import { describe, expect, it } from 'vitest';
import { buildCheckpoints } from '../../../../public/bundled-mods/worldmap/index.js';

/**
 * Checkpoints are where each day of a journey ends — the camps the party
 * makes on the road. "6 days" is a number; a line of numbered dots along the
 * route is a journey the player can look at.
 *
 * The load-bearing property is that they fall on real terrain COST, not on
 * evenly-spaced cells. A day through mountains has to visibly cover less
 * ground than a day on open road, or the map is lying about the thing the
 * terrain costing exists to model.
 */

/** A hop whose cells advance by `step` cost each, `count` cells long. */
function hop(count, step, legs, startX = 0) {
    const cells = [];
    for (let i = 0; i < count; i += 1) {
        cells.push({ x: startX + i, y: 0, cost: i * step });
    }
    return { cells, legs, cost: (count - 1) * step };
}

describe('world map checkpoints', () => {
    it('marks the end of every day except the last — arrival is not a camp', () => {
        // 3 grids/day on foot, multiplier 1 → a day is 3 cost. 10 cells of
        // cost 1 each = 9 total cost = 3 legs.
        const checkpoints = buildCheckpoints([hop(10, 1, 3)], 3, 1);
        expect(checkpoints.map(c => c.day)).toEqual([1, 2]);
        expect(checkpoints.every(c => c.kind === 'camp')).toBe(true);
    });

    it('places the camps by terrain cost, not by cell count', () => {
        // Same cell count, but every step costs 3 — so a "day" of 3 cost is
        // ONE cell of expensive ground, and the camps bunch up near the start
        // rather than spreading evenly along the line.
        const cheap = buildCheckpoints([hop(10, 1, 3)], 3, 1);
        const costly = buildCheckpoints([hop(10, 3, 9)], 3, 1);
        expect(cheap.map(c => c.x)).toEqual([3, 6]);
        expect(costly.map(c => c.x)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    });

    it('counts days continuously across hops and marks each arrival as a place', () => {
        const checkpoints = buildCheckpoints([hop(7, 1, 2), hop(7, 1, 2, 6)], 3, 1);
        // Hop 1: camp on day 1, then arriving at the intermediate place ends
        // day 2. Hop 2: camp on day 3, and the final arrival is not a camp.
        expect(checkpoints.map(c => [c.day, c.kind])).toEqual([
            [1, 'camp'],
            [2, 'place'],
            [3, 'camp'],
        ]);
    });

    it('a single-day journey has no checkpoints at all', () => {
        expect(buildCheckpoints([hop(3, 1, 1)], 3, 1)).toEqual([]);
    });

    it('a faster mode covers more ground per day, so it camps less often', () => {
        // A cart's pathfinder multiplier is 0.6, so its day is worth less
        // cost — but WO 3 gives it more grids per day. Passing the mode's
        // own numbers must move the camps, not just relabel them.
        const onFoot = buildCheckpoints([hop(25, 1, 8)], 3, 1);
        const mounted = buildCheckpoints([hop(25, 1, 4)], 6, 1);
        expect(onFoot.length).toBeGreaterThan(mounted.length);
        expect(mounted.map(c => c.x)).toEqual([6, 12, 18]);
    });

    it('tolerates a hop whose cells carry no cost rather than inventing camps', () => {
        // A producer that has not been updated must degrade to "no marks",
        // never to marks in the wrong place.
        const cells = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }];
        expect(buildCheckpoints([{ cells, legs: 3, cost: 2 }], 3, 1)).toEqual([]);
    });
});
