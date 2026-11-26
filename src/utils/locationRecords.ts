import type { LocationEntry } from '../types/location';

/** Keep authored content visible; hide only plain generated travel records. */
export function isTemporaryLocation(entry: LocationEntry): boolean {
    if (entry.pinned || entry.description?.trim() || entry.status?.trim()
        || entry.aliases?.trim() || entry.features?.length) return false;
    if (entry.recordKind === 'position') return /^Exploration point \(\d+,\s*\d+\)$/.test(entry.name);
    return (entry.kind === 'transit' || entry.recordKind === 'route') && /^Road between /i.test(entry.name);
}
