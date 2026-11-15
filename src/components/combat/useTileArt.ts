import { useCallback, useContext, useMemo, useState } from 'react';
import type { CombatGrid } from '../../types';
import { normalizeCombatConfig } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { TileAvailabilityContext } from './tileAvailability';
import type { TileAvailability } from './tileAvailability';
import { PixelCatalogContext, withoutPixelPaths } from './pixelCatalog';
import { buildPixelPlan } from './pixelMap';
import type { PixelPlan } from './pixelMap';
import { hasArt, resolveTileset, withoutPaths } from './tileset';
import type { Tileset } from './tileset';

export type TileArtState = {
    tileset: Tileset;
    tiles: TileAvailability;
    seed: number;
    onFail: (path: string) => void;
    pixel: PixelPlan | null;
    onPixelFail: (path: string) => void;
};

const NONE: ReadonlySet<string> = new Set();

export function useTileArt(grid: CombatGrid | undefined, place: string | undefined, seed: number, occupied: ReadonlySet<string> = NONE): TileArtState | null {
    const available = useContext(TileAvailabilityContext);
    const catalog = useContext(PixelCatalogContext);
    const style = useAppStore(s => normalizeCombatConfig(s.context?.combatConfig).tileStyle);
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    const [pixelFailed, setPixelFailed] = useState<ReadonlySet<string>>(() => new Set());
    const tiles = useMemo(() => withoutPaths(available, failed), [available, failed]);
    const tileset = useMemo(() => (grid ? resolveTileset({ grid, tiles, place }) : null), [grid, tiles, place]);
    const pixel = useMemo(
        () => (grid ? buildPixelPlan({ grid, catalog: withoutPixelPaths(catalog, pixelFailed), seed, style, place, occupied }) : null),
        [grid, catalog, pixelFailed, seed, style, place, occupied],
    );
    const onFail = useCallback((path: string) => {
        setFailed(prev => (prev.has(path) ? prev : new Set([...prev, path])));
    }, []);
    const onPixelFail = useCallback((path: string) => {
        setPixelFailed(prev => (prev.has(path) ? prev : new Set([...prev, path])));
    }, []);
    return useMemo(
        () => (tileset && (pixel || hasArt(tileset)) ? { tileset, tiles, seed, onFail, pixel, onPixelFail } : null),
        [tileset, tiles, seed, onFail, pixel, onPixelFail],
    );
}
