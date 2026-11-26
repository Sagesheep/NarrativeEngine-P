import { modEventBus } from '../mods/events';
import type { TravelMode } from '../../types';

/** Use the active map's terrain preview before committing a departure. */
export function openMapTravelPreview(toId: string, mode: TravelMode): boolean {
    if (modEventBus.getListenerCount('mod.worldmap.planTravel') === 0) return false;
    modEventBus.emitFromMod({ modId: 'worldmap', modName: 'World Map', file: 'worldmap/manifest.json' }, 'planTravel', { toId, mode });
    return true;
}
