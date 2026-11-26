/**
 * What one travel leg — one press, one checkpoint — stands for. The map's
 * distances and leg counts are the same either way; the unit changes the clock
 * (a day per leg, or an hour per leg) and the words the model and the player
 * read. A campaign that never set it travels in days.
 */
export type TravelUnit = 'days' | 'hours';

export function travelUnitWords(unit: TravelUnit | undefined) {
    return unit === 'hours'
        ? { one: 'hour', many: 'hours', short: 'h', title: 'Hour', stop: 'stop' }
        : { one: 'day', many: 'days', short: 'd', title: 'Day', stop: 'camp' };
}
