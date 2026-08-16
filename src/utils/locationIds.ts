import type { LocationEntry } from '../types';

export function newLocationId(): string {
    return `loc_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

export function normalizeLocationIds(locations: LocationEntry[]): LocationEntry[] {
    const used = new Set<string>();
    let changed = false;
    const normalized = locations.map(location => {
        const existingId = location.id?.trim();
        const id = existingId && !used.has(existingId) ? existingId : newLocationId();
        used.add(id);
        if (id === location.id) return location;
        changed = true;
        return { ...location, id };
    });
    return changed ? normalized : locations;
}