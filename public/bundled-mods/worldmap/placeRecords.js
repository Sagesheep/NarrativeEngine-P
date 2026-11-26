import { validCell } from './exploration.js';

// Retain IDs for story and journey references; positions are not permanent places.
export function isTemporaryPlace(entry) {
    if (!entry || entry.pinned || entry.description?.trim() || entry.status?.trim()
        || entry.aliases?.trim() || entry.features?.length) return false;
    if (entry.recordKind === 'position') return /^Exploration point \(\d+,\s*\d+\)$/.test(entry.name ?? '');
    return (entry.kind === 'transit' || entry.recordKind === 'route') && /^Road between /i.test(entry.name ?? '');
}
export function reconcilePlaceRecords(ledger, anchors, sites) {
    const byId = new Map(anchors.map(anchor => [anchor.locationId, anchor]));
    const bySite = new Map([...sites].map(site => [site.id, site]));
    let changed = false;
    const next = ledger.map(entry => {
        const site = bySite.get(entry.id), anchor = site ?? byId.get(entry.id);
        const recordKind = entry.recordKind ?? (entry.kind === 'transit' ? 'route' : site?.type === 'wilderness' ? 'position' : 'place');
        const coordinates = recordKind === 'route' ? entry.coordinates
            : validCell(entry.coordinates) ? entry.coordinates : validCell(anchor) ? { x: anchor.x, y: anchor.y } : undefined;
        if (recordKind === entry.recordKind && coordinates === entry.coordinates) return entry;
        changed = true; return { ...entry, recordKind, ...(coordinates ? { coordinates } : {}) };
    });
    return changed ? next : ledger;
}
