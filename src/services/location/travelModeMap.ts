/**
 * WO 6.1 — adapter between WO 3 `TravelMode` and the WO 6.0 terrain
 * pathfinder's mode set.
 *
 * The two systems disagree on purpose:
 * - WO 3 (`travelModes.ts`) owns the travel loop, the departure sentence, and
 *   the leg-count formula. Its modes are `foot | cart | horseback | flying`.
 * - WO 6.0 (`pathfinder.js`) owns terrain routing. Its modes are
 *   `foot | mount | cart | boat`, each with a multiplier and an impassable
 *   biome set.
 *
 * The intersection is `foot` and `cart`. `horseback` maps to the pathfinder's
 * `mount`; `flying` has no pathfinder entry because flying ignores terrain;
 * `boat` is a pathfinder-only mode with no WO 3 counterpart and is not surfaced
 * as a travel option (WO 3 has no concept of water travel).
 *
 * `flying` routes are computed as a straight-line octile path with cost equal
 * to the cell count — no terrain awareness, no impassable cells. This matches
 * WO 3's treatment of flying as the fast mode that goes everywhere.
 */
import type { TravelMode } from './travelModes';
import { gridsPerDayFor } from './travelModes';
import { BASE_GRIDS_PER_DAY, DISTANCE_BANDS, type DistanceBand } from './distance';

/** The WO 6.0 pathfinder's mode ids. */
export type PathfinderMode = 'foot' | 'mount' | 'cart' | 'boat';

/** The WO 6.0 pathfinder's per-mode definition (mirrored for type safety). */
export type PathfinderModeDef = {
    multiplier: number;
    speed: number;
    impassable: ReadonlySet<string>;
};

/** The pathfinder's mode table, mirrored from `pathfinder.js:56`. */
export const PATHFINDER_MODES: Readonly<Record<PathfinderMode, PathfinderModeDef>> = Object.freeze({
    foot: Object.freeze({ multiplier: 1.0, speed: 1.0, impassable: new Set(['ocean']) }),
    mount: Object.freeze({ multiplier: 0.7, speed: 1.4, impassable: new Set(['ocean', 'glacier']) }),
    cart: Object.freeze({ multiplier: 0.6, speed: 1.2, impassable: new Set(['ocean', 'glacier', 'mountain', 'marsh']) }),
    boat: Object.freeze({ multiplier: 1.0, speed: 1.0, impassable: new Set(['glacier', 'tundra', 'taiga', 'forest', 'plains', 'farmland', 'savanna', 'desert', 'marsh', 'jungle', 'mountain']) }),
});

/**
 * Map a WO 3 `TravelMode` to the WO 6.0 pathfinder mode used for terrain
 * routing. `flying` returns `null` — it has no pathfinder counterpart and is
 * handled separately (straight-line route, no terrain awareness).
 */
export function toPathfinderMode(mode: TravelMode): PathfinderMode | null {
    switch (mode) {
        case 'foot': return 'foot';
        case 'cart': return 'cart';
        case 'horseback': return 'mount';
        case 'flying': return null;
    }
}

/**
 * Does the WO 3 mode ignore terrain? Only `flying` — it routes in a straight
 * line and no biome is impassable. Used by the routing layer to skip the
 * pathfinder call and compute a direct octile route.
 */
export function modeIgnoresTerrain(mode: TravelMode): boolean {
    return mode === 'flying';
}

/**
 * Convert a pathfinder route cost into a terrain-real leg count (≡ days) that
 * is consistent with WO 3's speed model.
 *
 * The pathfinder's cost already includes the mode's `multiplier` (terrain
 * difficulty × mode efficiency). To get days under WO 3's speed model, first
 * "unadjust" the cost by dividing out the multiplier — yielding raw
 * terrain-weighted grids — then divide by the WO 3 mode's `gridsPerDay`.
 *
 *   rawGrids = cost / pathfinderMultiplier
 *   days     = ceil(rawGrids / gridsPerDayFor(wo3Mode))
 *
 * For `flying` (no pathfinder call), the cost is the raw octile cell count and
 * the multiplier is 1.0, so `days = ceil(cost / gridsPerDayFor('flying'))`.
 *
 * The leg count equals the day count: one committed turn advances one leg and
 * one day (WO 3 §7). A journey of 4 days is 4 legs, 4 turns, 4 day advances.
 */
export function costToLegs(
    cost: number,
    mode: TravelMode,
    pathfinderMultiplier: number = 1.0,
): number {
    if (!Number.isFinite(cost) || cost <= 0) return 1;
    const safeMultiplier = pathfinderMultiplier > 0 ? pathfinderMultiplier : 1.0;
    const rawGrids = cost / safeMultiplier;
    const gridsPerDay = gridsPerDayFor(mode);
    return Math.max(1, Math.ceil(rawGrids / gridsPerDay));
}

/**
 * Octile (8-way Chebyshev) distance between two integer cells. Used for the
 * `flying` straight-line route and for display when no pathfinder call is
 * made.
 */
export function octileDistance(ax: number, ay: number, bx: number, by: number): number {
    const dx = Math.abs(ax - bx);
    const dy = Math.abs(ay - by);
    return Math.abs(dx - dy) + Math.SQRT2 * Math.min(dx, dy);
}

/**
 * Derive a `DistanceBand` from a terrain-real grid count. The band is the
 * tightest band whose `[minGrids, maxGrids]` range contains the grid count,
 * falling back to `farthest` for anything past `remote`. Used so the
 * departure flow and the `[TRAVEL]` block can label the journey even when the
 * band was not authored — the terrain route is the authority.
 */
export function bandFromGrids(grids: number): DistanceBand {
    for (const band of DISTANCE_BANDS) {
        if (grids >= band.minGrids && grids <= band.maxGrids) return band.id;
    }
    return 'farthest';
}

export { BASE_GRIDS_PER_DAY };