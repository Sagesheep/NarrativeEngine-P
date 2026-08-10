import type { ValidatedMod, ValidatedModTierEntry } from './modTypes';
import type { ModTierEntry } from '../turn/tierBlockRegistry';
import type { AiTier } from '../../types';

/**
 * Phase 7.3 — adapt a validated mod's `tierEntries[]` into `ModTierEntry[]`
 * the tier block registry can hold.
 *
 * Mirrors `modToComputeTrack` (`computeTrack.ts`) and `modToContributionModule`
 * (`modAdapter.ts`): the registry never learns what produced an entry — a
 * built-in and a mod arrive as the same `ModTierEntry` shape.
 *
 * The one invariant this file enforces:
 *
 *   NAMESPACING. Every entry id is `mod.<modId>.<entryId>`. A mod can
 *   therefore never collide with — or impersonate — a built-in `TierFeature`
 *   id, no matter what its author writes. The `MATRIX` lookup in `tierAllows`
 *   is keyed on `TierFeature` literals (`'planner'`, `'enemyDiscovery'`, …);
 *   a `mod.`-prefixed id is never in `MATRIX`, so it always falls through to
 *   the mod tier block registry — exactly where it should resolve.
 */
export function modTierEntryId(modId: string, entryId: string): string {
    return `mod.${modId}.${entryId}`;
}

function toMatrix(matrix: ValidatedModTierEntry['matrix']): Record<AiTier, boolean> {
    return {
        lite: matrix.lite ?? false,
        pro: matrix.pro ?? false,
        max: matrix.max ?? false,
    };
}

export function modToTierEntries(mod: ValidatedMod): ModTierEntry[] {
    const entries = Array.isArray(mod.tierEntries) ? mod.tierEntries : [];

    return entries.map((entry) => ({
        id: modTierEntryId(mod.id, entry.id),
        name: entry.name,
        description: typeof entry.description === 'string' ? entry.description : '',
        toggleable: entry.toggleable,
        trigger: entry.trigger,
        defaultEnabled: entry.defaultEnabled,
        callsModel: entry.callsModel,
        matrix: toMatrix(entry.matrix),
        cooldown: entry.cooldown,
        modId: mod.id,
    }));
}
