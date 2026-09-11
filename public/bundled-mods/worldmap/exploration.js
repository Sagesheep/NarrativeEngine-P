import { FIELD_WORLD_SIZE } from './field.js';
export const SIGHT_RADIUS = 2;
export function cellKey(cell) { return `${cell.x},${cell.y}`; }
export function validCell(cell) { return Number.isSafeInteger(cell?.x) && Number.isSafeInteger(cell?.y)
    && cell.x >= 0 && cell.y >= 0 && cell.x < FIELD_WORLD_SIZE && cell.y < FIELD_WORLD_SIZE; }
export function visibleCells(centre, radius = SIGHT_RADIUS) {
    const result = new Set();
    if (!validCell(centre)) return result;
    for (let y = centre.y - radius; y <= centre.y + radius; y++) for (let x = centre.x - radius; x <= centre.x + radius; x++) {
        if (validCell({ x, y }) && Math.hypot(x - centre.x, y - centre.y) <= radius) result.add(`${x},${y}`);
    }
    return result;
}
export function readExploration(raw) {
    const cells = new Set();
    for (const key of Array.isArray(raw?.cells) ? raw.cells : []) {
        if (typeof key !== 'string') continue;
        const [x, y] = key.split(',').map(Number);
        if (validCell({ x, y }) && key === `${x},${y}`) cells.add(key);
    }
    return cells;
}
export function readGeneratedCells(raw) {
    return readExploration({ cells: Array.isArray(raw?.generatedCells) ? raw.generatedCells : raw?.cells });
}
export function serializeExploration(cells, generated = cells) {
    return { version: 2, cells: [...cells], generatedCells: [...generated] };
}
export function cellVisibility(key, generated, visible) {
    if (generated.has(key)) return visible.has(key) ? 'visible' : 'known';
    return 'ungenerated';
}
// Rendering cannot create local terrain by looking at an unknown cell or its neighbours.
export function observedTerrainStore(store, generated) {
    return generated ? { getCell: (x, y) => generated.has(`${x},${y}`) ? store.getCell(x, y) : null } : store;
}
export function revealCells(explored, centres) {
    let changed = false;
    for (const centre of centres) for (const key of visibleCells(centre)) if (!explored.has(key)) { explored.add(key); changed = true; }
    return changed;
}
export function explorationPoint(seed, x, y) {
    if (!validCell({ x, y })) return null;
    let hash = 2166136261; for (const c of seed) hash = Math.imul(hash ^ c.charCodeAt(0), 16777619);
    return { id: `point-${(hash >>> 0).toString(16)}-${x}-${y}`, x, y, type: 'wilderness', name: `Exploration point (${x}, ${y})`, description: '' };
}
