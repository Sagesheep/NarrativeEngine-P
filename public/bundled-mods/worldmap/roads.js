import { findRoute } from './pathfinder.js';
import { trailKey } from './trails.js';
import { validCell } from './exploration.js';

export function readRoads(raw) {
    return (Array.isArray(raw?.routes) ? raw.routes : []).filter(route => typeof route?.id === 'string'
        && ['road', 'path'].includes(route.kind) && Array.isArray(route.cells) && route.cells.length >= 2
        && route.cells.length <= 8192 && route.cells.every(validCell)
        && route.cells.every((cell, i) => i === 0 || Math.max(Math.abs(cell.x - route.cells[i-1].x), Math.abs(cell.y - route.cells[i-1].y)) === 1))
        .map(route => ({ ...route, name: String(route.name ?? 'Unnamed path').slice(0, 80), cells: route.cells.map(({ x, y }) => ({ x, y })) }));
}
export function serializeRoads(routes) { return { routes }; }
export function roadEdges(routes) {
    const edges = new Map();
    for (const route of routes) for (let i = 1; i < route.cells.length; i++) {
        const a = route.cells[i - 1], b = route.cells[i], key = trailKey(a, b);
        const passes = route.kind === 'road' ? 3 : 1;
        if ((edges.get(key)?.passes ?? 0) < passes) edges.set(key, { a, b, passes, kind: route.kind });
    }
    return edges;
}
export function travelSurfaces(trails, roads) {
    const edges = new Map(trails?.edges ?? []);
    for (const [key, edge] of roadEdges(roads)) if ((edges.get(key)?.passes ?? 0) < edge.passes) edges.set(key, edge);
    return { edges, progress: trails?.progress ?? null };
}
export function planRoad(store, points, kind = 'path', surfaces) {
    if (!['path', 'road'].includes(kind) || !Array.isArray(points) || points.length < 2 || points.length > 12 || !points.every(validCell))
        return { blocked: true, reason: 'Choose 2–12 waypoint cells.' };
    const cells = []; let cost = 0;
    for (let i = 1; i < points.length; i++) {
        if (Math.hypot(points[i].x - points[i-1].x, points[i].y - points[i-1].y) > 160)
            return { blocked: true, reason: 'Waypoints must be within 160 cells of each other.' };
        const leg = findRoute(store, points[i-1], points[i], kind === 'road' ? 'cart' : 'foot', { trails: surfaces });
        if (leg.blocked || leg.snapped) return { blocked: true, reason: `Segment ${i} cannot cross this terrain. Move its waypoint or use a footpath.` };
        cells.push(...leg.cells.slice(i === 1 ? 0 : 1).map(({ x, y }) => ({ x, y })));
        cost += leg.cost;
        if (cells.length > 8192) return { blocked: true, reason: 'Path is too long; create shorter sections.' };
    }
    return { cells, cost, kind };
}
export function roadCandidates(anchors, ledger, sites, roads) {
    const wilderness = new Set(sites.filter(site => site.type === 'wilderness').map(site => site.id));
    const places = new Map(anchors.filter(a => a.kind !== 'transit' && !wilderness.has(a.locationId)).map(a => [a.locationId, a]));
    for (const site of sites) if (site.type === 'settlement') places.set(site.id, { ...site, locationId: site.id });
    const key = (a, b) => [a, b].sort().join('|');
    const used = new Set(roads.filter(r => r.fromId && r.toId).map(r => key(r.fromId, r.toId)));
    const pairs = [];
    const add = (a, b) => {
        if (!a || !b || a.locationId === b.locationId || used.has(key(a.locationId, b.locationId))) return;
        if (Math.hypot(a.x-b.x, a.y-b.y) > 160) return;
        used.add(key(a.locationId, b.locationId)); pairs.push([a, b]);
    };
    for (const entry of ledger) if (entry.kind !== 'transit') for (const edge of entry.connections ?? []) if (!edge.passage) add(places.get(entry.id), places.get(edge.toId));
    const settlements = sites.filter(site => site.type === 'settlement');
    for (const site of settlements) {
        const from = places.get(site.id);
        const near = [...places.values()].filter(a => a.locationId !== site.id && Math.hypot(a.x-site.x, a.y-site.y) <= 40)
            .sort((a, b) => Math.hypot(a.x-site.x, a.y-site.y) - Math.hypot(b.x-site.x, b.y-site.y) || a.locationId.localeCompare(b.locationId));
        if (near[0]) add(from, near[0]);
    }
    return pairs.slice(0, 24);
}
export function roadConnectedLedger(ledger, roads) {
    return ledger.map(entry => {
        const targets = roads.flatMap(road => road.fromId === entry.id ? [road.toId] : road.toId === entry.id ? [road.fromId] : [])
            .filter(id => id && ledger.some(place => place.id === id));
        return { ...entry, connections: [...(entry.connections ?? []), ...targets.filter(id => !entry.connections?.some(edge => edge.toId === id)).map(toId => ({ toId }))] };
    });
}
