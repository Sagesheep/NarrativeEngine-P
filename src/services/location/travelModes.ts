import type { DistanceBand } from './distance';
import { DISTANCE_BANDS } from './distance';

export type TravelMode = 'foot' | 'cart' | 'horseback' | 'flying';

export const TRAVEL_MODES: ReadonlyArray<{
    id: TravelMode;
    label: string;
    gridsPerDay: number;
}> = [
    { id: 'foot',      label: 'On foot',   gridsPerDay: 3 },
    { id: 'cart',      label: 'Cart',      gridsPerDay: 5 },
    { id: 'horseback', label: 'Horseback', gridsPerDay: 8 },
    { id: 'flying',    label: 'Flying',    gridsPerDay: 20 },
];

export function gridsPerDayFor(mode: TravelMode): number {
    return TRAVEL_MODES.find(entry => entry.id === mode)?.gridsPerDay ?? 3;
}

export function travelModeLabel(mode: TravelMode): string {
    return TRAVEL_MODES.find(entry => entry.id === mode)?.label ?? 'On foot';
}

/**
 * Deterministic leg count for a (band, mode) pair. The same journey always
 * splits the same way, so a regenerated or swiped turn sees the same leg.
 *
 * `adjacent` (0 grids) yields 1, but `adjacent` departures never enter the
 * travel state at all (WO3 §6) — so the floor of 1 is a defensive default,
 * not a value the loop ever reads.
 */
export function legsFor(band: DistanceBand, mode: TravelMode): number {
    const definition = DISTANCE_BANDS.find(b => b.id === band) ?? DISTANCE_BANDS[2];
    const { minGrids, maxGrids } = definition;
    const effective = Number.isFinite(maxGrids)
        ? Math.round((minGrids + maxGrids) / 2)
        : Math.round(minGrids * 1.25);
    return Math.max(1, Math.ceil(effective / gridsPerDayFor(mode)));
}