import { travelUnitWords, type TravelUnit } from './travelUnit';

export type DistanceBand =
    | 'adjacent' | 'nearby' | 'local' | 'regional'
    | 'far' | 'distant' | 'remote' | 'farthest';

/** Ordered nearest → farthest. `maxGrids: Infinity` on the last entry. */
export const DISTANCE_BANDS: ReadonlyArray<{
    id: DistanceBand;
    minGrids: number;
    maxGrids: number;
    label: string;
}> = [
    { id: 'adjacent', minGrids: 0, maxGrids: 0, label: 'adjacent — same place, no travel' },
    { id: 'nearby', minGrids: 1, maxGrids: 2, label: 'nearby — 1–2 grids' },
    { id: 'local', minGrids: 3, maxGrids: 6, label: 'local — 3–6 grids' },
    { id: 'regional', minGrids: 7, maxGrids: 15, label: 'regional — 7–15 grids' },
    { id: 'far', minGrids: 16, maxGrids: 30, label: 'far — 16–30 grids' },
    { id: 'distant', minGrids: 31, maxGrids: 60, label: 'distant — 31–60 grids' },
    { id: 'remote', minGrids: 61, maxGrids: 120, label: 'remote — 61–120 grids' },
    { id: 'farthest', minGrids: 121, maxGrids: Infinity, label: 'farthest — 121+ grids' },
];

export const BASE_GRIDS_PER_DAY = 3;

function bandDefinition(band: DistanceBand) {
    return DISTANCE_BANDS.find(entry => entry.id === band) ?? DISTANCE_BANDS[2];
}

/** Day range for a band at baseline speed. `adjacent` → { min: 0, max: 0 }. */
export function bandToDayRange(band: DistanceBand): { min: number; max: number } {
    const { minGrids, maxGrids } = bandDefinition(band);
    return {
        min: Math.ceil(minGrids / BASE_GRIDS_PER_DAY),
        max: Math.ceil(maxGrids / BASE_GRIDS_PER_DAY),
    };
}

/**
 * Day range for a band at the given travel speed (grids/day). The mode-aware
 * estimate shown in the picker — a cart and a walker visibly differ before the
 * player commits (WO 3.1 §3). `adjacent` → { min: 0, max: 0 }.
 */
export function bandToDayRangeForMode(band: DistanceBand, gridsPerDay: number): { min: number; max: number } {
    const { minGrids, maxGrids } = bandDefinition(band);
    const step = Math.max(1, gridsPerDay);
    return {
        min: Math.ceil(minGrids / step),
        max: Number.isFinite(maxGrids) ? Math.ceil(maxGrids / step) : Infinity,
    };
}

function formatLegRange({ min, max }: { min: number; max: number }, unit: TravelUnit | undefined): string {
    const words = travelUnitWords(unit);
    if (min === 0 && max === 0) return 'no travel';
    if (max === Infinity) return `${min}+ ${words.many}`;
    if (min === max) return `about ${min} ${min === 1 ? words.one : words.many}`;
    return `${min}–${max} ${words.many}`;
}

/**
 * Format a band's travel-time range for player-facing context. A leg is a day
 * unless the campaign travels in hours, which reads the same counts as hours.
 */
export function formatDayRange(band: DistanceBand, unit?: TravelUnit): string {
    return formatLegRange(bandToDayRange(band), unit);
}

/**
 * Format a `(band, mode)` day-range for the picker. Mode-aware companion to
 * `formatDayRange`. `adjacent` reads "no travel"; `farthest` reads "N+ days";
 * a single-day band reads "about 1 day"; otherwise "M–N days". Hours replace
 * days when `unit` is 'hours'.
 */
export function formatDayRangeForMode(band: DistanceBand, gridsPerDay: number, unit?: TravelUnit): string {
    return formatLegRange(bandToDayRangeForMode(band, gridsPerDay), unit);
}
