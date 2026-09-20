import type { LocationEntry, LocationPlacement } from '../../types';
import { DISTANCE_BANDS } from './distance';
import { modEventBus } from '../mods/events';

export const LOCATION_BIOMES = ['snow', 'glacier', 'tundra', 'taiga', 'forest', 'plains', 'farmland', 'savanna', 'desert', 'marsh', 'jungle', 'mountain', 'ocean', 'volcanic', 'deadzone', 'sand', 'swamp'] as const;
const directions = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const;
export function sanitizePlacement(raw: unknown, entry: LocationEntry, ledger: LocationEntry[]): LocationPlacement | undefined {
    if (!raw || typeof raw !== 'object' || entry.coordinates || entry.placement) return undefined;
    const value = raw as Record<string, unknown>;
    const reference = ledger.find(place => place.id === value.referencePlaceId && place.id !== entry.id);
    const distanceBand = DISTANCE_BANDS.find(band => band.id === value.distanceBand)?.id;
    const direction = directions.find(direction => direction === String(value.direction).toLowerCase());
    const preferredBiomes = Array.isArray(value.preferredBiomes)
        ? [...new Set(value.preferredBiomes.filter((biome): biome is typeof LOCATION_BIOMES[number] => LOCATION_BIOMES.includes(biome)))].slice(0, 4) : [];
    const biomePolicy = value.biomePolicy === 'preferred' || value.biomePolicy === 'exception' ? value.biomePolicy : 'required';
    const biomeRadius = typeof value.biomeRadius === 'number' && Number.isFinite(value.biomeRadius)
        ? Math.max(3, Math.min(24, Math.round(value.biomeRadius))) : undefined;
    const cell = value.coordinates as { x?: number; y?: number } | undefined;
    const coordinates = cell && Number.isSafeInteger(cell.x) && Number.isSafeInteger(cell.y)
        && cell.x! >= 0 && cell.y! >= 0 && cell.x! < 1000 && cell.y! < 1000 ? { x: cell.x!, y: cell.y! } : undefined;
    if (!preferredBiomes.length && !distanceBand && !coordinates) return undefined;
    return { referencePlaceId: reference?.id, distanceBand, direction, preferredBiomes, biomePolicy, biomeRadius, coordinates,
        reason: typeof value.reason === 'string' ? value.reason.trim().slice(0, 240) : undefined };
}
export function requestPlacementContext(campaignId: string): Promise<string | null> {
    if (!modEventBus.getListenerCount('mod.worldmap.placementContext')) return Promise.resolve(null);
    return new Promise(resolve => {
        const requestId = crypto.randomUUID();
        const finish = (context: string | null) => { clearTimeout(timer); off(); resolve(context); };
        const off = modEventBus.on('mod.worldmap.placementContextResult', payload => {
            if (payload.requestId !== requestId || payload.campaignId !== campaignId) return;
            finish(typeof payload.contextJson === 'string' && payload.contextJson.length < 30000 ? payload.contextJson : null);
        });
        const timer = setTimeout(() => finish(null), 3000);
        modEventBus.emitFromMod({ modId: 'worldmap', modName: 'World Map', file: 'worldmap/manifest.json' },
            'placementContext', { requestId, campaignId });
    });
}
