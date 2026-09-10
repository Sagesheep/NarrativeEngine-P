import { siteLabel } from './discoveries.js';

// Seeded geography stays outside the relational layout solver. Ledger edits
// can change identity and connections, but never a discovered coordinate.
export function fixedSiteAnchors(result, sites, ledger) {
    const byId = new Map((result.anchors ?? []).map(anchor => [anchor.locationId, anchor]));
    const entries = new Map(ledger.map(entry => [entry.id, entry]));
    for (const site of sites) if (entries.has(site.id)) {
        byId.set(site.id, { locationId: site.id, x: site.x, y: site.y, source: 'discovery', name: entries.get(site.id).name });
    }
    for (const entry of ledger) {
        if (entry.kind !== 'transit' || byId.has(entry.id)) continue;
        const ends = entry.connections.map(connection => byId.get(connection.toId)).filter(Boolean);
        if (ends.length < 2) continue;
        byId.set(entry.id, { locationId: entry.id, x: Math.round((ends[0].x + ends[1].x) / 2),
            y: Math.round((ends[0].y + ends[1].y) / 2), source: 'transit' });
    }
    return [...byId.values()];
}
export function promoteSite(site, ledger, fromId, bandFor = () => 'local') {
    if (ledger.some(entry => entry.id === site.id)) return ledger;
    const from = ledger.find(entry => entry.id === fromId);
    const neighbours = from?.kind === 'transit' ? from.connections.map(edge => edge.toId) : [fromId];
    const connected = [...new Set(neighbours)].filter(id => id && id !== site.id && ledger.some(entry => entry.id === id));
    const entry = { id: site.id, name: siteLabel(site), description: site.description || '',
        aliases: '', broadLocation: '', features: [], source: 'manual', firstSeenScene: '', lastSeenScene: '',
        connections: connected.map(toId => ({ toId, band: bandFor(toId) })) };
    return [...ledger.map(place => connected.includes(place.id)
        ? { ...place, connections: [...place.connections, { toId: site.id, band: bandFor(place.id) }] } : place), entry];
}
// Prefer known sites already on the route. No detours, moved sites, extra
// days, or increased daily cost for either side of a substituted checkpoint.
export function preferSiteStops(checkpoints, cells, sites, budget) {
    const byCell = new Map(sites.map(site => [`${site.x},${site.y}`, site]));
    let previousIndex = 0;
    return checkpoints.map((checkpoint, index) => {
        const originalIndex = cells.findIndex((cell, i) => i >= previousIndex && cell.x === checkpoint.x && cell.y === checkpoint.y);
        if (originalIndex < 0 || checkpoint.kind === 'place') return checkpoint;
        const next = checkpoints[index + 1];
        const nextIndex = next ? cells.findIndex((cell, i) => i > originalIndex && cell.x === next.x && cell.y === next.y) : cells.length - 1;
        let selected = originalIndex;
        if (nextIndex >= 0) for (let i = originalIndex; i > previousIndex; i--) {
            if (cells[originalIndex].cost - cells[i].cost > budget / 4) break;
            if (byCell.has(`${cells[i].x},${cells[i].y}`)
                && cells[i].cost - cells[previousIndex].cost <= budget + 1e-6
                && cells[nextIndex].cost - cells[i].cost <= budget + 1e-6) { selected = i; break; }
        }
        previousIndex = selected;
        const site = byCell.get(`${cells[selected].x},${cells[selected].y}`);
        return { ...checkpoint, x: cells[selected].x, y: cells[selected].y,
            ...(site ? { siteId: site.id, siteName: siteLabel(site) } : {}) };
    });
}
