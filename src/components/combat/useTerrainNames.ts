import { useMemo } from 'react';
import { TILE_KINDS } from '@narrative/engine';
import { useTranslation } from '../../i18n/useTranslation';
import type { CombatGrid, CombatTile } from '../../types';
import { terrainLabel } from './combatVisuals';

export function useTerrainNames(grid: CombatGrid | undefined): Record<CombatTile, string> {
    const { t } = useTranslation();
    return useMemo(() => {
        const out = {} as Record<CombatTile, string>;
        for (const tile of TILE_KINDS) {
            const label = terrainLabel(grid, tile);
            out[tile] = label ? t('combat.board.tileLabelled', { label, kind: t(`combat.board.tile.${tile}`) }) : t(`combat.board.tile.${tile}`);
        }
        return out;
    }, [grid, t]);
}
