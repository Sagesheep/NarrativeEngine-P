import { useCallback, useContext, useMemo, useState } from 'react';
import type { CombatGrid } from '../../types';
import { TileAvailabilityContext } from './tileAvailability';
import type { TileAvailability } from './tileAvailability';
import { hasArt, resolveTileset, withoutPaths } from './tileset';
import type { Tileset } from './tileset';

export type TileArtState = {
    tileset: Tileset;
    tiles: TileAvailability;
    seed: number;
    onFail: (path: string) => void;
};

export function useTileArt(grid: CombatGrid | undefined, place: string | undefined, seed: number): TileArtState | null {
    const available = useContext(TileAvailabilityContext);
    const [failed, setFailed] = useState<ReadonlySet<string>>(() => new Set());
    const tiles = useMemo(() => withoutPaths(available, failed), [available, failed]);
    const tileset = useMemo(() => (grid ? resolveTileset({ grid, tiles, place }) : null), [grid, tiles, place]);
    const onFail = useCallback((path: string) => {
        setFailed(prev => (prev.has(path) ? prev : new Set([...prev, path])));
    }, []);
    return useMemo(() => (tileset && hasArt(tileset) ? { tileset, tiles, seed, onFail } : null), [tileset, tiles, seed, onFail]);
}
