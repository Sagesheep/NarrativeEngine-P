export function routeKnowledge(cells, days, mode, explored = new Set(), roads = []) {
    const known = new Set(explored);
    for (const road of roads) for (const cell of road.cells ?? []) known.add(cell.x + ',' + cell.y);
    const unknown = mode === 'flying' ? 0 : cells.filter(cell => !known.has(cell.x + ',' + cell.y)).length;
    const uncertain = unknown > 0;
    const margin = uncertain ? Math.max(1, Math.ceil(days * (0.25 + 0.25 * unknown / Math.max(1, cells.length)))) : 0;
    return { uncertain, minDays: Math.max(1, days - margin), maxDays: Math.max(1, days + margin) };
}
export function estimateLabel(estimate) {
    return 'Estimated ' + estimate.minDays + '–' + estimate.maxDays + ' days · route uncertain';
}
