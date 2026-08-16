import type { GameContext, LocationEntry } from '../../types';
import { DISTANCE_BANDS, bandToDayRange, formatDayRange } from '../location/distance';
import { connectionBand } from '../locationParser';

const MAX_TRAVEL_FACTS = 3;

/**
 * Build hard-world travel facts for the Continuity Director.
 *
 * This is deliberately silent unless the campaign has opted into a world day
 * and both ends of a connection resolve. The original connection order breaks
 * ties so ledger ordering remains deterministic.
 */
export function buildTravelFacts(context: GameContext, ledger: LocationEntry[]): string[] {
    if (context.worldDay === undefined || !Number.isFinite(context.worldDay)) return [];

    const currentPlace = context.currentPlaceId
        ? ledger.find(place => place.id === context.currentPlaceId)
        : undefined;
    if (!currentPlace) return [];

    const candidates = currentPlace.connections
        .map((connection, index) => ({
            connection,
            index,
            band: connectionBand(connection),
            destination: ledger.find(place => place.id === connection.toId),
        }))
        .filter(({ band, destination }) =>
            destination !== undefined
            && band !== 'adjacent',
        )
        .sort((a, b) => (
            DISTANCE_BANDS.findIndex(entry => entry.id === a.band)
            - DISTANCE_BANDS.findIndex(entry => entry.id === b.band)
        ) || (a.index - b.index))
        .slice(0, MAX_TRAVEL_FACTS);

    return candidates.map(({ band, destination }) => {
        const definition = DISTANCE_BANDS.find(entry => entry.id === band)!;
        const { min } = bandToDayRange(band);
        const arrivalDay = context.worldDay! + min;
        const grids = definition.maxGrids === Infinity
            ? `${definition.minGrids}+ grids`
            : definition.minGrids === definition.maxGrids
                ? `${definition.minGrids} grid`
                : `${definition.minGrids}–${definition.maxGrids} grids`;
        return `${currentPlace.name} → ${destination!.name} is ${band} (${grids}), roughly ${formatDayRange(band)} on foot. Today is day ${context.worldDay}; arrival is impossible before day ${arrivalDay}.`;
    });
}