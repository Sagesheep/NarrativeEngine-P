// Physical, undirected trail segments. Terrain remains the passability authority.
export const MIN_TRAIL_MULTIPLIER = 0.7;
export function trailKey(a, b) {
    const first = `${a.x},${a.y}`, second = `${b.x},${b.y}`;
    return first < second ? `${first}:${second}` : `${second}:${first}`;
}
export function readTrails(raw) {
    const edges = new Map();
    for (const edge of Array.isArray(raw?.edges) ? raw.edges : []) {
        if (![edge?.a?.x, edge?.a?.y, edge?.b?.x, edge?.b?.y].every(Number.isSafeInteger)) continue;
        if (Math.max(Math.abs(edge.a.x - edge.b.x), Math.abs(edge.a.y - edge.b.y)) !== 1) continue;
        if (!Number.isFinite(edge.passes) || edge.passes < 1) continue;
        edges.set(trailKey(edge.a, edge.b), { a: edge.a, b: edge.b, passes: Math.min(3, Math.floor(edge.passes)) });
    }
    return { edges, progress: typeof raw?.progress?.key === 'string' && Number.isSafeInteger(raw.progress.index) && raw.progress.index >= 0 ? raw.progress : null };
}
export function serializeTrails(trails) {
    return { edges: [...trails.edges.values()], progress: trails.progress };
}
export function trailMultiplier(trails, a, b) {
    return 1 - 0.1 * (trails?.edges.get(trailKey(a, b))?.passes ?? 0);
}
// Record only the traversed prefix. The persisted cursor prevents repaint and
// reload from wearing a trail a second time. Future route cells earn nothing.
export function recordTrailProgress(trails, journey, endIndex) {
    if (!journey || journey.mode === 'flying' || journey.mode === 'boat') return false;
    const key = journey.id ?? `${journey.fromId}:${journey.toId}:${journey.startedOnDay}`;
    const previous = trails.progress?.key === key ? trails.progress.index : 0;
    const end = Math.min(journey.cells.length - 1, endIndex);
    if (end <= previous) return false;
    for (let i = previous + 1; i <= end; i++) {
        const a = journey.cells[i - 1], b = journey.cells[i];
        if (Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) !== 1) continue;
        const edgeKey = trailKey(a, b);
        const passes = Math.min(3, (trails.edges.get(edgeKey)?.passes ?? 0) + 1);
        trails.edges.set(edgeKey, { a: { x: a.x, y: a.y }, b: { x: b.x, y: b.y }, passes });
    }
    trails.progress = { key, index: end };
    return true;
}
