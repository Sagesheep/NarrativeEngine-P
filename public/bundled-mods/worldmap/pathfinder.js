/**
 * World Map — terrain pathfinding (WORKORDER 6.0).
 *
 * Textbook A* over the chunk grid, 8-way movement, octile heuristic, binary
 * heap open set. No host imports, no rendering, no store writes, no LLM, no
 * UI. One function: given two cells and a travel mode, return the least-cost
 * route across the terrain grid, or report that there isn't one.
 *
 *   findRoute(chunkStore, from, to, mode) -> { cells, cost, days }
 *                                          | { blocked: true, reason }
 *
 * Per-cell cost is read through `chunkStore.getCell(x, y)` (`field.js:504`).
 * Calling `sampleField` directly here would erode the WO 5.3 §3 rule that
 * keeps the cost fix from regressing — every consumer outside `field.js` and
 * the chunk generator reads the grid, never the field.
 *
 * Mode matters beyond a multiplier. A cart does not cross a mountain pass
 * slowly; it does not cross it at all. Each mode carries a multiplier *and*
 * an impassable set, so route choice becomes mode-dependent — the point of
 * the feature, not a side effect.
 *
 * This module deliberately has no imports. A bundled native mod is served as
 * a runtime asset and may not depend on host-internal `src/` paths.
 */

const SQRT2 = Math.SQRT2;

/**
 * Per-biome base cost. Tunable from mod settings in a later work order; the
 * table here is the WO 6.0 §2 baseline. The WO table marks ocean as
 * "impassable", but impassability is mode-dependent and the per-mode
 * impassable set is the sole authority — `boat` crosses ocean, foot does
 * not. A finite base cost here lets `boat` compute a real route length
 * while the impassable set returns `Infinity` for every other mode.
 */
export const BIOME_BASE_COST = Object.freeze({
    plains: 1.0,
    farmland: 1.0,
    savanna: 1.0,
    forest: 1.6,
    taiga: 1.6,
    tundra: 1.6,
    desert: 2.2,
    marsh: 2.2,
    jungle: 2.6,
    mountain: 4.0,
    glacier: 5.0,
    ocean: 1.0,
});

/**
 * Per-mode multiplier and impassable biome set. The impassable set is the
 * authority — `ocean` is not a sentinel in `BIOME_BASE_COST`, it is a row
 * in this table, so a future mode could in principle cross it.
 */
export const TRAVEL_MODES = Object.freeze({
    foot: Object.freeze({ multiplier: 1.0, impassable: Object.freeze(new Set(['ocean'])), speed: 1.0 }),
    mount: Object.freeze({ multiplier: 0.7, impassable: Object.freeze(new Set(['ocean', 'glacier'])), speed: 1.4 }),
    cart: Object.freeze({ multiplier: 0.6, impassable: Object.freeze(new Set(['ocean', 'glacier', 'mountain', 'marsh'])), speed: 1.2 }),
    boat: Object.freeze({ multiplier: 1.0, impassable: Object.freeze(new Set(['glacier', 'tundra', 'taiga', 'forest', 'plains', 'farmland', 'savanna', 'desert', 'marsh', 'jungle', 'mountain'])), speed: 1.0 }),
});

export const DEFAULT_EXPLORED_CAP = 250_000;
export const BASE_GRIDS_PER_DAY = 3;

const ENDPOINT_SNAP_RADIUS = 3;

const ORTHO_NEIGHBOURS = [
    [1, 0], [-1, 0], [0, 1], [0, -1],
];
const DIAG_NEIGHBOURS = [
    [1, 1], [1, -1], [-1, 1], [-1, -1],
];
const ALL_NEIGHBOURS = [
    [1, 0, false], [-1, 0, false], [0, 1, false], [0, -1, false],
    [1, 1, true], [1, -1, true], [-1, 1, true], [-1, -1, true],
];

/**
 * Binary min-heap of `{ key, priority }` entries keyed by an external id map.
 * The textbook array-of-indices open set for A* — pops the lowest-priority
 * entry in O(log n), decreases-key in O(log n). The heap is allocated once
 * per search and discarded with it; there is no reuse across calls.
 */
class MinHeap {
    constructor() {
        this.keys = [];
        this.priorities = [];
        this.index = new Map();
    }

    get size() { return this.keys.length; }

    has(key) { return this.index.has(key); }

    priority(key) { return this.index.has(key) ? this.priorities[this.index.get(key)] : Infinity; }

    push(key, priority) {
        const idx = this.index.get(key);
        if (idx !== undefined) {
            if (priority >= this.priorities[idx]) return;
            this.priorities[idx] = priority;
            this.siftUp(idx);
            return;
        }
        this.keys.push(key);
        this.priorities.push(priority);
        this.index.set(key, this.keys.length - 1);
        this.siftUp(this.keys.length - 1);
    }

    pop() {
        if (this.keys.length === 0) return null;
        const topKey = this.keys[0];
        const topPriority = this.priorities[0];
        const last = this.keys.length - 1;
        if (last === 0) {
            this.keys.length = 0;
            this.priorities.length = 0;
            this.index.clear();
            return { key: topKey, priority: topPriority };
        }
        this.keys[0] = this.keys[last];
        this.priorities[0] = this.priorities[last];
        this.index.set(this.keys[0], 0);
        this.keys.length -= 1;
        this.priorities.length -= 1;
        this.index.delete(topKey);
        this.siftDown(0);
        return { key: topKey, priority: topPriority };
    }

    siftUp(idx) {
        const keys = this.keys;
        const prios = this.priorities;
        const idxMap = this.index;
        const itemKey = keys[idx];
        const itemPri = prios[idx];
        while (idx > 0) {
            const parent = (idx - 1) >> 1;
            if (prios[parent] <= itemPri) break;
            keys[idx] = keys[parent];
            prios[idx] = prios[parent];
            idxMap.set(keys[idx], idx);
            idx = parent;
        }
        keys[idx] = itemKey;
        prios[idx] = itemPri;
        idxMap.set(itemKey, idx);
    }

    siftDown(idx) {
        const keys = this.keys;
        const prios = this.priorities;
        const idxMap = this.index;
        const len = keys.length;
        const itemKey = keys[idx];
        const itemPri = prios[idx];
        let child = (idx << 1) + 1;
        while (child < len) {
            const right = child + 1;
            if (right < len && prios[right] < prios[child]) child = right;
            if (itemPri <= prios[child]) break;
            keys[idx] = keys[child];
            prios[idx] = prios[child];
            idxMap.set(keys[idx], idx);
            idx = child;
            child = (idx << 1) + 1;
        }
        keys[idx] = itemKey;
        prios[idx] = itemPri;
        idxMap.set(itemKey, idx);
    }
}

function cellKey(x, y) { return (x << 16) | (y & 0xFFFF); }

/**
 * Octile distance between two integer cells. Admissible because it is the
 * exact cost of the cheapest 8-way path across uniform terrain, and scaled
 * here by the minimum per-cell cost the search will encounter so it never
 * overestimates. An inadmissible heuristic silently returns non-optimal
 * paths, which is exactly the kind of bug nobody notices for months — the
 * guard against it is the optimality test (§6), not a review note.
 */
function octile(ax, ay, bx, by, minCost) {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    const straight = Math.abs(dx - dy);
    const diag = Math.min(dx, dy);
    return minCost * (straight + (SQRT2 * diag));
}

/**
 * Per-cell movement cost for a given mode, or `Infinity` if impassable. The
 * base biome cost is multiplied by the mode's multiplier; the mode's
 * impassable set takes precedence over any finite base cost. Diagonal moves
 * carry `√2` on top of this — applied in `findRoute`, not here.
 */
export function cellCost(chunkStore, x, y, modeDef) {
    const { biome } = chunkStore.getCell(x, y);
    if (modeDef.impassable.has(biome)) return Infinity;
    const base = BIOME_BASE_COST[biome];
    if (!Number.isFinite(base)) return Infinity;
    return base * modeDef.multiplier;
}

/**
 * Minimum per-cell cost across the biomes the mode can enter. Used to scale
 * the heuristic so it stays admissible: the heuristic value never exceeds
 * the true cost of any path through passable terrain.
 */
function minimumPassableCost(modeDef) {
    let min = Infinity;
    for (const [biome, base] of Object.entries(BIOME_BASE_COST)) {
        if (modeDef.impassable.has(biome)) continue;
        if (!Number.isFinite(base)) continue;
        const cost = base * modeDef.multiplier;
        if (cost < min) min = cost;
    }
    return Number.isFinite(min) ? min : 1;
}

/**
 * Snap an impassable endpoint to the nearest passable cell within
 * `ENDPOINT_SNAP_RADIUS`, deterministically. Spiral outward by ring, break
 * ties in (dx, dy) order. Returns `{ x, y, snapped: bool }`. Beyond the
 * radius, returns `null` — the caller emits `endpoint-impassable`.
 */
function snapEndpoint(chunkStore, x, y, modeDef) {
    if (Number.isFinite(cellCost(chunkStore, x, y, modeDef))) {
        return { x, y, snapped: false };
    }
    for (let radius = 1; radius <= ENDPOINT_SNAP_RADIUS; radius += 1) {
        for (let dy = -radius; dy <= radius; dy += 1) {
            for (let dx = -radius; dx <= radius; dx += 1) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (Number.isFinite(cellCost(chunkStore, nx, ny, modeDef))) {
                    return { x: nx, y: ny, snapped: true };
                }
            }
        }
    }
    return null;
}

/**
 * Find the least-cost route across the terrain grid, or report that there
 * isn't one. Reads terrain through `chunkStore.getCell`; writes nothing.
 *
 * @param {object} chunkStore  a `ChunkStore` (or anything exposing `getCell(x, y) -> { biome }`)
 * @param {{x:number,y:number}} from
 * @param {{x:number,y:number}} to
 * @param {'foot'|'mount'|'cart'|'boat'} mode
 * @param {object} [options]
 * @param {number} [options.exploredCap=DEFAULT_EXPLORED_CAP]
 * @returns {{cells: Array<{x:number,y:number}>, cost: number, days: number, snapped?: 'from'|'to'|'both'}}
 *        | {{ blocked: true, reason: 'no-route'|'search-exhausted'|'endpoint-impassable'|'unknown-mode'|'same-cell' }}
 */
export function findRoute(chunkStore, from, to, mode, options = {}) {
    if (!chunkStore || typeof chunkStore.getCell !== 'function') {
        return { blocked: true, reason: 'unknown-mode' };
    }
    const modeDef = TRAVEL_MODES[mode];
    if (!modeDef) return { blocked: true, reason: 'unknown-mode' };

    const fromX = Math.trunc(from?.x);
    const fromY = Math.trunc(from?.y);
    const toX = Math.trunc(to?.x);
    const toY = Math.trunc(to?.y);
    if (!Number.isFinite(fromX) || !Number.isFinite(fromY)
        || !Number.isFinite(toX) || !Number.isFinite(toY)) {
        return { blocked: true, reason: 'endpoint-impassable' };
    }
    if (fromX === toX && fromY === toY) {
        return { blocked: true, reason: 'same-cell' };
    }

    const exploredCap = Math.max(1, Math.trunc(options.exploredCap ?? DEFAULT_EXPLORED_CAP));

    const snappedFrom = snapEndpoint(chunkStore, fromX, fromY, modeDef);
    if (!snappedFrom) return { blocked: true, reason: 'endpoint-impassable' };
    const snappedTo = snapEndpoint(chunkStore, toX, toY, modeDef);
    if (!snappedTo) return { blocked: true, reason: 'endpoint-impassable' };

    const start = { x: snappedFrom.x, y: snappedFrom.y };
    const goal = { x: snappedTo.x, y: snappedTo.y };
    if (start.x === goal.x && start.y === goal.y) {
        const cost = 0;
        return {
            cells: [{ x: start.x, y: start.y }],
            cost,
            days: 0,
        };
    }

    const minCost = minimumPassableCost(modeDef);
    const open = new MinHeap();
    const gScore = new Map();
    const cameFrom = new Map();

    const startKey = cellKey(start.x, start.y);
    gScore.set(startKey, 0);
    open.push(startKey, octile(start.x, start.y, goal.x, goal.y, minCost));

    let explored = 0;
    let bestKey = null;
    const goalKey = cellKey(goal.x, goal.y);

    while (open.size > 0) {
        const current = open.pop();
        if (current.key === goalKey) {
            bestKey = current.key;
            break;
        }
        explored += 1;
        if (explored > exploredCap) {
            return { blocked: true, reason: 'search-exhausted' };
        }

        const cx = current.key >> 16;
        const cy = (current.key << 16) >> 16;
        const currentG = gScore.get(current.key) ?? Infinity;

        for (let i = 0; i < 8; i += 1) {
            const [dx, dy, diagonal] = ALL_NEIGHBOURS[i];
            const nx = cx + dx;
            const ny = cy + dy;
            const stepCost = cellCost(chunkStore, nx, ny, modeDef);
            if (!Number.isFinite(stepCost)) continue;

            if (diagonal) {
                // No corner-cutting: a diagonal between two impassable
                // orthogonal neighbours is not a legal move. The classic
                // rule, applied verbatim.
                const a = cellCost(chunkStore, cx + dx, cy, modeDef);
                const b = cellCost(chunkStore, cx, cy + dy, modeDef);
                if (!Number.isFinite(a) && !Number.isFinite(b)) continue;
            }

            const moveCost = diagonal ? stepCost * SQRT2 : stepCost;
            const tentative = currentG + moveCost;
            const nKey = cellKey(nx, ny);
            const known = gScore.get(nKey) ?? Infinity;
            if (tentative < known) {
                gScore.set(nKey, tentative);
                cameFrom.set(nKey, current.key);
                const f = tentative + octile(nx, ny, goal.x, goal.y, minCost);
                open.push(nKey, f);
            }
        }
    }

    if (bestKey === null) {
        return { blocked: true, reason: 'no-route' };
    }

    const path = [];
    let walk = bestKey;
    while (walk !== undefined) {
        const wx = walk >> 16;
        const wy = (walk << 16) >> 16;
        path.push({ x: wx, y: wy });
        walk = cameFrom.get(walk);
    }
    path.reverse();

    const cost = gScore.get(bestKey) ?? 0;
    const days = Math.ceil(cost / (BASE_GRIDS_PER_DAY * modeDef.speed));

    let snapped;
    if (snappedFrom.snapped && snappedTo.snapped) snapped = 'both';
    else if (snappedFrom.snapped) snapped = 'from';
    else if (snappedTo.snapped) snapped = 'to';

    const result = { cells: path, cost, days };
    if (snapped) result.snapped = snapped;
    return result;
}

export { MinHeap };