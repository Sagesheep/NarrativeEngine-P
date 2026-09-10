import { it, expect } from 'vitest';
import { rollEncounter, weatherAt, recordCheckpoint, handleEncounter, readEncounters, serializeEncounters } from '../../../../public/bundled-mods/worldmap/encounters.js';

const input = { seed: 'test', x: 5, y: 7, worldDay: 10, biome: 'ocean', weather: 'thunderstorm' };
it('uses repeatable weather and checkpoint rolls', () => {
    expect(weatherAt('test', 5, 7, 10, 'ocean')).toBe(weatherAt('test', 5, 7, 10, 'ocean'));
    expect(rollEncounter(input)).toEqual(rollEncounter(input));
});
it('weights matching combinations without guaranteeing them, replacing all base events when selected', () => {
    expect(rollEncounter(input, () => 0.9).events).toEqual([expect.objectContaining({ id: 'sea-storm', source: 'combination' })]);
    expect(rollEncounter(input, () => 0).events.map(row => row.source)).toEqual(['biome', 'weather']);
});
it('can compose all three base tables or record an explicit quiet outcome', () => {
    const site = { ...input, biome: 'plains', weather: 'wind', feature: { id: 'site', type: 'ruin' } };
    expect(rollEncounter(site, () => 0).events.map(row => row.source)).toEqual(['feature', 'biome', 'weather']);
    expect(rollEncounter(site, () => 0.99)).toMatchObject({ quiet: true, events: [] });
});
it('retains the first result through reload and changed names, features or weather', () => {
    const first = recordCheckpoint(new Map(), input);
    const loaded = readEncounters(JSON.parse(JSON.stringify(serializeEncounters(first.records))));
    const replay = recordCheckpoint(loaded, { ...input, weather: 'clear', feature: { id: 'new', type: 'ruin' } });
    expect(replay.changed).toBe(false);
    expect(replay.record).toEqual(first.record);
});
it('handles once and preserves handled state across reload and revisit', () => {
    const first = recordCheckpoint(new Map(), input);
    const handled = handleEncounter(first.records, first.record.key);
    expect(handleEncounter(handled, first.record.key)).toBe(handled);
    const second = recordCheckpoint(handled, { ...input, x: 6 });
    const returned = recordCheckpoint(readEncounters(serializeEncounters(second.records)), input);
    expect(returned.record.status).toBe('handled');
    expect(returned.records.get(second.record.key).status).toBe('passed');
    expect(returned.records.size).toBe(2);
});
it('consumes an ignored situation on departure and rolls a new day only once', () => {
    const first = recordCheckpoint(new Map(), input);
    const next = recordCheckpoint(first.records, { ...input, worldDay: 11 });
    expect(next.records.get(first.record.key).status).toBe('passed');
    expect(next.records.size).toBe(2);
    expect(recordCheckpoint(next.records, input).record.status).toBe('passed');
});
it('ignores malformed persistence rows', () => {
    expect(readEncounters(null).size).toBe(0);
    expect(readEncounters({ records: [null, { x: 1, y: 2, worldDay: 3, key: 'wrong', events: [] }] }).size).toBe(0);
});
