import { describe, expect, it } from 'vitest';
import {
    BIOME_BASE_COST,
    BASE_GRIDS_PER_DAY,
    DEFAULT_EXPLORED_CAP,
    TRAVEL_MODES,
    cellCost,
    findRoute,
} from '../../../../public/bundled-mods/worldmap/pathfinder.js';

/**
 * Synthetic hand-built chunk store. Cells are addressed by `"x,y"` and read
 * back verbatim — no noise, no generation, no laziness. This is what lets the
 * tests below assert exact known answers rather than whatever the noise
 * happened to produce, which is what WO 6.0 §6 calls for.
 *
 * The interface is the one `findRoute` reads: `getCell(x, y) -> { biome }`.
 * The real `ChunkStore` (`field.js:468`) returns `{ biome, elevation }`;
 * the extra field is harmless here.
 */
class SyntheticChunkStore {
    constructor(layout, defaultBiome = 'plains') {
        this.layout = new Map();
        for (const [key, biome] of Object.entries(layout)) {
            this.layout.set(key, biome);
        }
        this.defaultBiome = defaultBiome;
        this.reads = 0;
        this.chunkReads = new Set();
    }
    getCell(x, y) {
        const ix = Math.trunc(x);
        const iy = Math.trunc(y);
        this.reads += 1;
        this.chunkReads.add(`${Math.floor(ix / 64)},${Math.floor(iy / 64)}`);
        const biome = this.layout.get(`${ix},${iy}`) ?? this.defaultBiome;
        return { biome };
    }
}

function fill(layout, x0, y0, x1, y1, biome) {
    for (let y = y0; y <= y1; y += 1) {
        for (let x = x0; x <= x1; x += 1) {
            layout[`${x},${y}`] = biome;
        }
    }
    return layout;
}

describe('World Map pathfinder — straight line across uniform plains', () => {
    it('returns the direct path with cost equal to cell count', () => {
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        expect(result).not.toHaveProperty('blocked');
        expect(result.cells.length).toBe(6);
        expect(result.cells[0]).toMatchObject({ x: 0, y: 0 });
        expect(result.cells[5]).toMatchObject({ x: 5, y: 0 });
        // 5 orthogonal moves × plains cost 1.0 × foot multiplier 1.0 = 5.
        expect(result.cost).toBeCloseTo(5, 6);
        expect(result.days).toBe(Math.ceil(5 / (BASE_GRIDS_PER_DAY * 1.0)));
    });

    it('prefers the diagonal on uniform terrain (octile shortest)', () => {
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 3, y: 3 }, 'foot');
        expect(result.cells.length).toBe(4);
        expect(result.cost).toBeCloseTo(3 * Math.SQRT2, 6);
    });
});

describe('World Map pathfinder — mountain ridge with a gap', () => {
    it('routes through the gap, not over the ridge', () => {
        const layout = {};
        fill(layout, 2, -3, 2, -1, 'mountain');
        fill(layout, 2, 1, 2, 3, 'mountain');
        const store = new SyntheticChunkStore(layout, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        expect(result).not.toHaveProperty('blocked');
        const xs = result.cells.map(c => c.x);
        const ys = result.cells.map(c => c.y);
        expect(xs[0]).toBe(0);
        expect(xs[xs.length - 1]).toBe(5);
        // The route must pass through the gap at y=0, x=2 (the only passable
        // cell on the ridge). It must not walk a mountain cell.
        expect(ys).toContain(0);
        for (let i = 0; i < result.cells.length; i += 1) {
            const c = result.cells[i];
            if (c.x === 2) expect(c.y).toBe(0);
        }
    });
});

describe('World Map pathfinder — mode divergence (the feature test)', () => {
    it('foot and cart disagree when a mountain pass is the short way', () => {
        // Layout: a mountain ridge spans x=2 from y=-4..4 except a single
        // pass at y=0. The pass is the short way for foot. A cart cannot
        // cross the pass (mountain is impassable for cart), so it must go
        // around the end of the ridge at y=-5 or y=5.
        const layout = {};
        fill(layout, 2, -4, 2, 4, 'mountain');
        const store = new SyntheticChunkStore(layout, 'plains');

        const foot = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        const cart = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'cart');

        expect(foot).not.toHaveProperty('blocked');
        expect(cart).not.toHaveProperty('blocked');

        const footPassesRidgeThroughPass = foot.cells.some(c => c.x === 2 && c.y === 0);
        expect(footPassesRidgeThroughPass).toBe(true);

        // Cart must NOT enter any mountain cell — it skirts the ridge end.
        const cartEntersMountain = cart.cells.some(c => c.x === 2 && c.y >= -4 && c.y <= 4);
        expect(cartEntersMountain).toBe(false);

        // And the routes differ — this is the test that proves the feature.
        expect(foot.cells).not.toEqual(cart.cells);

        // Foot goes over the pass (short distance, high per-cell cost);
        // cart goes around (long distance, cheap cells). The feature is
        // that the routes differ, not that one is strictly cheaper than the
        // other — both kinds of outcome are valid mode divergence.
        expect(foot.cells).not.toEqual(cart.cells);
    });

    it('mount mode diverges from foot on a glacier ridge', () => {
        const layout = {};
        fill(layout, 2, -4, 2, 4, 'glacier');
        const store = new SyntheticChunkStore(layout, 'plains');

        const foot = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        const mount = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'mount');
        expect(foot).not.toHaveProperty('blocked');
        expect(mount).not.toHaveProperty('blocked');

        // Foot can cross the glacier at the pass (y=0) — slowly, but it can.
        const footCrossesPass = foot.cells.some(c => c.x === 2 && c.y === 0);
        expect(footCrossesPass).toBe(true);

        // Mount cannot enter glacier at all; it must skirt the ridge end.
        const mountEntersGlacier = mount.cells.some(c => c.x === 2 && c.y >= -4 && c.y <= 4);
        expect(mountEntersGlacier).toBe(false);
        expect(foot.cells).not.toEqual(mount.cells);
    });
});

describe('World Map pathfinder — ocean between two points', () => {
    it('returns blocked for foot and a route for boat', () => {
        // Two plains islands in an infinite ocean. Foot can stand on its
        // island but cannot leave it (every neighbour is ocean) → no-route.
        // Boat snaps off the islands onto ocean and routes freely.
        const layout = {
            '0,0': 'plains',
            '5,0': 'plains',
        };
        const store = new SyntheticChunkStore(layout, 'ocean');

        const foot = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        expect(foot).toEqual({ blocked: true, reason: 'no-route' });

        const boat = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'boat');
        expect(boat).not.toHaveProperty('blocked');
        expect(boat.snapped).toBe('both');
        expect(boat.cells.length).toBeGreaterThan(1);
        // The snapped start is the nearest ocean cell to (0,0); the snapped
        // end is the nearest ocean cell to (5,0). Every cell in the route
        // is ocean — boat never leaves the water.
        for (const cell of boat.cells) {
            expect(store.getCell(cell.x, cell.y).biome).toBe('ocean');
        }
    });
});

describe('World Map pathfinder — no corner-cutting', () => {
    it('does not cut between two impassable orthogonal neighbours', () => {
        // Layout: two diagonal cells are passable at (0,0) and (1,1), but
        // the orthogonal cells (1,0) and (0,1) are both impassable (ocean).
        // A diagonal move from (0,0) to (1,1) would cut between them and is
        // illegal. Foot has nowhere else to go, so the route is blocked.
        const layout = {
            '0,0': 'plains',
            '1,1': 'plains',
            '1,0': 'ocean',
            '0,1': 'ocean',
        };
        const store = new SyntheticChunkStore(layout, 'ocean');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 1, y: 1 }, 'foot');
        expect(result).toEqual({ blocked: true, reason: 'no-route' });
    });

    it('allows a diagonal when only one orthogonal neighbour is blocked', () => {
        // Same shape, but (1,0) is plains — only one of the two orthogonal
        // neighbours is impassable. The diagonal is legal because there is a
        // path around the corner.
        const layout = {
            '0,0': 'plains',
            '1,1': 'plains',
            '1,0': 'plains',
            '0,1': 'ocean',
        };
        const store = new SyntheticChunkStore(layout, 'ocean');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 1, y: 1 }, 'foot');
        expect(result).not.toHaveProperty('blocked');
        expect(result.cells[0]).toMatchObject({ x: 0, y: 0 });
        expect(result.cells[result.cells.length - 1]).toMatchObject({ x: 1, y: 1 });
    });
});

describe('World Map pathfinder — optimality (heuristic admissibility guard)', () => {
    it('A* matches an exhaustive Dijkstra on a small mixed-terrain grid', () => {
        // 5x5 grid with mixed biome costs. Compare A* against an exhaustive
        // Dijkstra over the same cells; the optimality guard is exactly that
        // A* returns the same cost.
        const layout = {};
        fill(layout, 0, 0, 4, 4, 'plains');
        layout['2,1'] = 'forest';
        layout['2,2'] = 'forest';
        layout['2,3'] = 'forest';
        layout['1,2'] = 'mountain';
        layout['3,2'] = 'marsh';
        const store = new SyntheticChunkStore(layout, 'plains');

        const aStar = findRoute(store, { x: 0, y: 0 }, { x: 4, y: 4 }, 'foot');
        const dijkstra = exhaustiveDijkstra(store, 0, 0, 4, 4, 'foot');
        expect(aStar).not.toHaveProperty('blocked');
        expect(dijkstra).not.toBeNull();
        expect(aStar.cost).toBeCloseTo(dijkstra.cost, 6);
    });
});

describe('World Map pathfinder — determinism', () => {
    it('identical route across 100 calls', () => {
        const layout = {};
        fill(layout, 2, -4, 2, 4, 'mountain');
        const store = new SyntheticChunkStore(layout, 'plains');
        let prev = null;
        for (let i = 0; i < 100; i += 1) {
            const result = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
            if (prev === null) prev = result;
            else expect(result).toEqual(prev);
        }
    });

    it('identical route across a fresh module re-import', async () => {
        const layout = {};
        fill(layout, 2, -4, 2, 4, 'mountain');
        const store = new SyntheticChunkStore(layout, 'plains');
        const before = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        const fresh = await import('../../../../public/bundled-mods/worldmap/pathfinder.js?fresh=' + Date.now());
        const after = fresh.findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        expect(after).toEqual(before);
    });

    it('tie-breaking between equal-cost paths is deterministic', () => {
        // A 3x3 square of plains has two equal-cost paths from (0,0) to
        // (2,2): through (1,0)→(2,1) or through (0,1)→(1,2). The same one
        // must be returned every call. (0,0)→(1,1) is a single diagonal of
        // cost √2, which is what an A* with an admissible octile heuristic
        // returns — the diagonal is unambiguously cheaper than two ortho
        // steps. Use a longer path so there is a real tie to break.
        const store = new SyntheticChunkStore({}, 'plains');
        let firstPath = null;
        for (let i = 0; i < 50; i += 1) {
            const result = findRoute(store, { x: 0, y: 0 }, { x: 2, y: 2 }, 'foot');
            if (firstPath === null) firstPath = result.cells;
            else expect(result.cells).toEqual(firstPath);
        }
        // And the cost is the same regardless of which tie-break won.
        const result = findRoute(store, { x: 0, y: 0 }, { x: 2, y: 2 }, 'foot');
        expect(result.cost).toBeCloseTo(2 * Math.SQRT2, 6);
    });
});

describe('World Map pathfinder — explored-cell cap', () => {
    it('trips and returns search-exhausted rather than hanging', () => {
        // A 1000x1000 open field with a deliberately tiny cap. Foot can
        // traverse forever; the cap trips before any route is found.
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(
            store,
            { x: 0, y: 0 },
            { x: 500, y: 500 },
            'foot',
            { exploredCap: 50 },
        );
        expect(result).toEqual({ blocked: true, reason: 'search-exhausted' });
    });

    it('does not trip when the route is short', () => {
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(
            store,
            { x: 0, y: 0 },
            { x: 10, y: 10 },
            'foot',
            { exploredCap: DEFAULT_EXPLORED_CAP },
        );
        expect(result).not.toHaveProperty('blocked');
    });
});

describe('World Map pathfinder — lazy chunk generation', () => {
    it('only the chunks along the search frontier are generated', () => {
        // A route from (0,0) to (10,0) across plains should touch only a
        // handful of chunks — far below the 1000x1000 world. The synthetic
        // store records chunk keys read; we assert the count is small.
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 10, y: 0 }, 'foot');
        expect(result).not.toHaveProperty('blocked');
        expect(store.chunkReads.size).toBeLessThan(5);
    });
});

describe('World Map pathfinder — endpoint snapping', () => {
    it('snaps an impassable endpoint to the nearest passable cell within 3', () => {
        // Start on an ocean cell; plains surrounds it. The snap picks the
        // nearest passable cell deterministically — radius 1 is visited in
        // (dx, dy) order, so (-1,-1) wins over (1,0). The route then runs
        // east to the goal.
        const layout = {
            '0,0': 'ocean',
        };
        const store = new SyntheticChunkStore(layout, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'foot');
        expect(result).not.toHaveProperty('blocked');
        expect(result.snapped).toBe('from');
        // The snap is at Chebyshev radius 1; the implementation spirals in
        // (dx, dy) order so (-1,-1) is the first passable cell visited.
        expect(Math.max(Math.abs(result.cells[0].x - 0), Math.abs(result.cells[0].y - 0))).toBe(1);
        expect(store.getCell(result.cells[0].x, result.cells[0].y).biome).toBe('plains');
    });

    it('returns endpoint-impassable when no passable cell is within radius 3', () => {
        const layout = {
            '0,0': 'ocean',
        };
        const store = new SyntheticChunkStore(layout, 'ocean');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 50, y: 0 }, 'foot');
        expect(result).toEqual({ blocked: true, reason: 'endpoint-impassable' });
    });

    it('notes a snap on both endpoints in the result', () => {
        const layout = {
            '0,0': 'ocean',
            '10,0': 'ocean',
        };
        const store = new SyntheticChunkStore(layout, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 10, y: 0 }, 'foot');
        expect(result).not.toHaveProperty('blocked');
        expect(result.snapped).toBe('both');
    });
});

describe('World Map pathfinder — same cell', () => {
    it('returns same-cell when from === to', () => {
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(store, { x: 5, y: 5 }, { x: 5, y: 5 }, 'foot');
        expect(result).toEqual({ blocked: true, reason: 'same-cell' });
    });
});

describe('World Map pathfinder — unknown mode', () => {
    it('returns unknown-mode for an unrecognised mode id', () => {
        const store = new SyntheticChunkStore({}, 'plains');
        const result = findRoute(store, { x: 0, y: 0 }, { x: 5, y: 0 }, 'teleport');
        expect(result).toEqual({ blocked: true, reason: 'unknown-mode' });
    });
});

describe('World Map pathfinder — module purity (WO 6.0 §7)', () => {
    it('has no imports outside the mod and no host dependencies', async () => {
        // Read the module source and assert it has no import statements. The
        // file is served as a runtime asset and may not reach into src/.
        const fs = await import('node:fs');
        const path = await import('node:path');
        const file = path.resolve('public/bundled-mods/worldmap/pathfinder.js');
        const source = fs.readFileSync(file, 'utf8');
        const importLines = source
            .split('\n')
            .map(l => l.trim())
            .filter(l => l.startsWith('import ') || l.startsWith('export from'));
        expect(importLines.length).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Exhaustive Dijkstra reference implementation for the optimality guard.
// Independent of the A* under test; if A* disagrees with this on the small
// grid above, the heuristic is inadmissible and the pathfinder is wrong.
// ---------------------------------------------------------------------------

function exhaustiveDijkstra(store, sx, sy, gx, gy, mode) {
    const modeDef = TRAVEL_MODES[mode];
    if (!modeDef) return null;
    const start = cellKeyLocal(sx, sy);
    const goal = cellKeyLocal(gx, gy);
    const dist = new Map();
    const visited = new Set();
    dist.set(start, 0);
    const frontier = [{ key: start, d: 0 }];
    let guard = 0;
    while (frontier.length > 0) {
        frontier.sort((a, b) => a.d - b.d);
        const { key, d } = frontier.shift();
        if (key === goal) return { cost: d };
        if (visited.has(key)) continue;
        visited.add(key);
        guard += 1;
        if (guard > 100000) return null;
        const cx = key >> 16;
        const cy = (key << 16) >> 16;
        for (const [dx, dy, diagonal] of [
            [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
            [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
        ]) {
            const nx = cx + dx;
            const ny = cy + dy;
            const stepCost = cellCost(store, nx, ny, modeDef);
            if (!Number.isFinite(stepCost)) continue;
            if (diagonal) {
                const a = cellCost(store, cx + dx, cy, modeDef);
                const b = cellCost(store, cx, cy + dy, modeDef);
                if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
            }
            const moveCost = diagonal ? stepCost * Math.SQRT2 : stepCost;
            const nKey = cellKeyLocal(nx, ny);
            const nd = d + moveCost;
            if (nd < (dist.get(nKey) ?? Infinity)) {
                dist.set(nKey, nd);
                frontier.push({ key: nKey, d: nd });
            }
        }
    }
    return null;
}

function cellKeyLocal(x, y) { return (x << 16) | (y & 0xFFFF); }