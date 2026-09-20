import { findRoute } from './pathfinder.js';
import { validCell } from './exploration.js';
export function waterRoute(store, from, to, options = {}) {
    const water = (x, y) => validCell({ x, y }) && store.getCell(x, y)?.biome === 'ocean';
    const accessible = cell => water(cell.x, cell.y) || [[1,0],[-1,0],[0,1],[0,-1]].some(([dx,dy]) => water(cell.x + dx, cell.y + dy));
    if (!accessible(from) || !accessible(to)) return { blocked: true, reason: 'A boat needs water or a shoreline at both ends.' };
    const coastal = { getCell(x, y) {
        const cell = store.getCell(x, y);
        return (x === from.x && y === from.y) || (x === to.x && y === to.y) ? { ...cell, biome: 'ocean' } : { ...cell, biome: cell?.biome === 'ocean' ? 'ocean' : 'mountain' };
    } };
    return findRoute(coastal, from, to, 'boat', options);
}
