import type { LocationEntry } from '../../types';

export function hasKnownPosition(place: Pick<LocationEntry, 'knowledge'>): boolean {
    return place.knowledge !== 'rumoured' && place.knowledge !== 'secret';
}
