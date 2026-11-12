import type { AttackRange, Combatant, CombatState, Grid, Pos, Side, Tile } from './types';

export const TILE_KINDS: readonly Tile[] = ['floor', 'wall', 'cover', 'difficult', 'hazard'];
export const DEFAULT_SPEED = 6;
export const REACH_DISTANCE = 2;
export const RANGED_DISTANCE = 12;
export const HAZARD_AVOID_PENALTY = 10;
export const HALF_COVER_BONUS = 2;
export const THREE_QUARTER_COVER_BONUS = 5;

const DIRECTIONS: readonly Pos[] = [
    { x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    { x: 1, y: 1 }, { x: 1, y: -1 }, { x: -1, y: 1 }, { x: -1, y: -1 },
];

export function inBounds(grid: Grid, p: Pos): boolean {
    return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0 && p.x < grid.width && p.y < grid.height;
}

export function tileAt(grid: Grid, p: Pos): Tile {
    if (!inBounds(grid, p)) return 'wall';
    return grid.tiles[p.y * grid.width + p.x] ?? 'wall';
}

export function isWalkableTile(tile: Tile): boolean {
    return tile === 'floor' || tile === 'difficult' || tile === 'hazard';
}

export function isWalkable(grid: Grid, p: Pos): boolean {
    return inBounds(grid, p) && isWalkableTile(tileAt(grid, p));
}

function squeezes(tile: Tile): boolean {
    return tile === 'wall' || tile === 'cover';
}

export function stepCost(tile: Tile): number {
    return tile === 'difficult' ? 2 : 1;
}

export function distance(a: Pos, b: Pos): number {
    return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function samePos(a: Pos | undefined, b: Pos | undefined): boolean {
    return !!a && !!b && a.x === b.x && a.y === b.y;
}

export function canStep(grid: Grid, from: Pos, to: Pos): boolean {
    if (!isWalkable(grid, to)) return false;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1 || (dx === 0 && dy === 0)) return false;
    if (dx !== 0 && dy !== 0) {
        if (squeezes(tileAt(grid, { x: from.x + dx, y: from.y })) || squeezes(tileAt(grid, { x: from.x, y: from.y + dy }))) return false;
    }
    return true;
}

export function neighbours(grid: Grid, p: Pos): Pos[] {
    const out: Pos[] = [];
    for (const d of DIRECTIONS) {
        const next = { x: p.x + d.x, y: p.y + d.y };
        if (canStep(grid, p, next)) out.push(next);
    }
    return out;
}

export function traceLine(a: Pos, b: Pos): Pos[][] {
    const steps: Pos[][] = [[{ x: a.x, y: a.y }]];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const nx = Math.abs(dx);
    const ny = Math.abs(dy);
    const sx = Math.sign(dx);
    const sy = Math.sign(dy);
    let x = a.x;
    let y = a.y;
    let ix = 0;
    let iy = 0;
    while (ix < nx || iy < ny) {
        const decision = (1 + 2 * ix) * ny - (1 + 2 * iy) * nx;
        if (decision === 0) {
            steps.push([{ x: x + sx, y }, { x, y: y + sy }]);
            x += sx;
            y += sy;
            ix++;
            iy++;
        } else if (decision < 0) {
            x += sx;
            ix++;
        } else {
            y += sy;
            iy++;
        }
        steps.push([{ x, y }]);
    }
    return steps;
}

function innerSteps(a: Pos, b: Pos): Pos[][] {
    return traceLine(a, b).slice(1, -1);
}

export function hasLineOfSight(grid: Grid, a: Pos, b: Pos): boolean {
    return innerSteps(a, b).every(step => step.every(p => tileAt(grid, p) !== 'wall'));
}

export function coverBetween(grid: Grid, a: Pos, b: Pos): number {
    let crossings = 0;
    for (const step of innerSteps(a, b)) {
        if (step.some(p => tileAt(grid, p) === 'cover')) crossings++;
    }
    if (crossings >= 2) return THREE_QUARTER_COVER_BONUS;
    if (crossings === 1) return HALF_COVER_BONUS;
    return 0;
}

export function speedOf(c: Pick<Combatant, 'speed'>): number {
    return Number.isFinite(c.speed) && (c.speed as number) >= 0 ? Math.floor(c.speed as number) : DEFAULT_SPEED;
}

export function rangeOf(c: Pick<Combatant, 'range'>): AttackRange {
    return c.range === 'reach' || c.range === 'ranged' ? c.range : 'close';
}

function teamOf(side: Side): 'party' | 'enemy' | 'neutral' {
    if (side === 'player' || side === 'ally') return 'party';
    return side;
}

export function sameTeam(a: Side, b: Side): boolean {
    return teamOf(a) === teamOf(b);
}

function indexOf(grid: Grid, p: Pos): number {
    return p.y * grid.width + p.x;
}

function posOf(grid: Grid, index: number): Pos {
    return { x: index % grid.width, y: Math.floor(index / grid.width) };
}

type HeapItem = { index: number; weight: number; cost: number };

class MinHeap {
    private items: HeapItem[] = [];

    get size(): number {
        return this.items.length;
    }

    private less(a: HeapItem, b: HeapItem): boolean {
        if (a.weight !== b.weight) return a.weight < b.weight;
        if (a.cost !== b.cost) return a.cost < b.cost;
        return a.index < b.index;
    }

    push(item: HeapItem): void {
        const items = this.items;
        items.push(item);
        let i = items.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (!this.less(items[i], items[parent])) break;
            [items[i], items[parent]] = [items[parent], items[i]];
            i = parent;
        }
    }

    pop(): HeapItem | undefined {
        const items = this.items;
        if (items.length === 0) return undefined;
        const top = items[0];
        const last = items.pop() as HeapItem;
        if (items.length > 0) {
            items[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let best = i;
                if (l < items.length && this.less(items[l], items[best])) best = l;
                if (r < items.length && this.less(items[r], items[best])) best = r;
                if (best === i) break;
                [items[i], items[best]] = [items[best], items[i]];
                i = best;
            }
        }
        return top;
    }
}

export type MoveSearch = {
    grid: Grid;
    start: Pos;
    cost: number[];
    weight: number[];
    prev: number[];
    occupied: Set<number>;
};

export type SearchOptions = { budget: number; avoidHazards: boolean };

export function searchMoves(state: CombatState, actorId: string, opts: SearchOptions): MoveSearch | null {
    const grid = state.grid;
    const actor = state.combatants[actorId];
    if (!grid || !actor || !actor.position || !inBounds(grid, actor.position)) return null;
    const total = grid.width * grid.height;
    const cost = new Array<number>(total).fill(Infinity);
    const weight = new Array<number>(total).fill(Infinity);
    const prev = new Array<number>(total).fill(-1);
    const blocked = new Set<number>();
    const occupied = new Set<number>();
    for (const other of Object.values(state.combatants)) {
        if (other.id === actor.id || other.status !== 'up' || !other.position || !inBounds(grid, other.position)) continue;
        const idx = indexOf(grid, other.position);
        occupied.add(idx);
        if (!sameTeam(actor.side, other.side)) blocked.add(idx);
    }
    const start = indexOf(grid, actor.position);
    cost[start] = 0;
    weight[start] = 0;
    const heap = new MinHeap();
    heap.push({ index: start, weight: 0, cost: 0 });
    while (heap.size > 0) {
        const item = heap.pop() as HeapItem;
        if (item.weight > weight[item.index] || (item.weight === weight[item.index] && item.cost > cost[item.index])) continue;
        const here = posOf(grid, item.index);
        for (const next of neighbours(grid, here)) {
            const ni = indexOf(grid, next);
            if (blocked.has(ni)) continue;
            const tile = tileAt(grid, next);
            const nc = item.cost + stepCost(tile);
            if (nc > opts.budget) continue;
            const nw = item.weight + stepCost(tile) + (opts.avoidHazards && tile === 'hazard' ? HAZARD_AVOID_PENALTY : 0);
            if (nw < weight[ni] || (nw === weight[ni] && nc < cost[ni])) {
                weight[ni] = nw;
                cost[ni] = nc;
                prev[ni] = item.index;
                heap.push({ index: ni, weight: nw, cost: nc });
            }
        }
    }
    return { grid, start: actor.position, cost, weight, prev, occupied };
}

export type ReachableTile = Pos & { cost: number };

export function destinations(search: MoveSearch): Array<ReachableTile & { weight: number }> {
    const out: Array<ReachableTile & { weight: number }> = [];
    const startIdx = indexOf(search.grid, search.start);
    for (let i = 0; i < search.cost.length; i++) {
        if (i === startIdx || !Number.isFinite(search.cost[i]) || search.occupied.has(i)) continue;
        out.push({ ...posOf(search.grid, i), cost: search.cost[i], weight: search.weight[i] });
    }
    return out;
}

export function pathFromSearch(search: MoveSearch, to: Pos): Pos[] | null {
    const grid = search.grid;
    if (!inBounds(grid, to)) return null;
    const target = indexOf(grid, to);
    if (!Number.isFinite(search.cost[target])) return null;
    const startIdx = indexOf(grid, search.start);
    const path: Pos[] = [];
    let cursor = target;
    while (cursor !== startIdx) {
        if (cursor < 0) return null;
        path.push(posOf(grid, cursor));
        cursor = search.prev[cursor];
    }
    return path.reverse();
}

export function costAt(search: MoveSearch, p: Pos): number {
    if (!inBounds(search.grid, p)) return Infinity;
    return search.cost[indexOf(search.grid, p)];
}

export function weightAt(search: MoveSearch, p: Pos): number {
    if (!inBounds(search.grid, p)) return Infinity;
    return search.weight[indexOf(search.grid, p)];
}

export function isOccupiedIn(search: MoveSearch, p: Pos): boolean {
    return inBounds(search.grid, p) && search.occupied.has(indexOf(search.grid, p));
}

export function pathCost(grid: Grid, path: readonly Pos[]): number {
    return path.reduce((sum, p) => sum + stepCost(tileAt(grid, p)), 0);
}

export function isOccupied(state: CombatState, p: Pos, exceptId?: string): boolean {
    return Object.values(state.combatants).some(c => c.id !== exceptId && c.status === 'up' && samePos(c.position, p));
}
