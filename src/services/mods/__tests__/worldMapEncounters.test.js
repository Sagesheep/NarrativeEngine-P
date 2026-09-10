import { it, expect } from 'vitest';
import { rollEncounter, weatherAt, recordCheckpoint, handleEncounter, noteEncounter, readEncounters, serializeEncounters } from '../../../../public/bundled-mods/worldmap/encounters.js';

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
    const site = { ...input, biome: 'plains', weather: 'wind', feature: { id: 'site', type: 'ruin', distance: 0 } };
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


it('does not generate activity at a nearby site as though it had been reached', () => {
    const result = rollEncounter({ ...input, biome: 'forest', weather: 'clear', feature: { id: 'ruin', type: 'ruin', distance: 1 } }, () => 0);
    expect(result.featureId).toBeNull();
    expect(result.events.some(event => event.source === 'feature')).toBe(false);
});
it('keeps a generated participant, scene and player outcome through save, reload and departure', () => {
    const stop = { ...input, biome: 'plains', weather: 'clear', onRoad: true };
    const scene = rollEncounter(stop, () => 0);
    expect(scene.events[0]).toMatchObject({ id: 'road-merchant', actor: { role: 'travelling merchant' } });
    expect(scene.events[0].text).toContain(scene.events[0].actor.name);
    const saved = noteEncounter(new Map([[scene.key, scene]]), scene.key, 'Bought rope. Meet again at the crossing.');
    const loaded = readEncounters(JSON.parse(JSON.stringify(serializeEncounters(saved))));
    expect(recordCheckpoint(loaded, { ...stop, onRoad: false }).record).toEqual(saved.get(scene.key));
    const departed = recordCheckpoint(loaded, { ...stop, worldDay: 11 });
    expect(departed.records.get(scene.key)).toMatchObject({ status: 'passed', note: 'Bought rope. Meet again at the crossing.', events: scene.events });
});
it('does not populate a reached settlement with wilderness wildlife', () => {
    const result = rollEncounter({ ...input, biome: 'forest', weather: 'clear', feature: { id: 'village', type: 'settlement', distance: 0 } }, () => 0);
    expect(result.events.map(event => event.source)).toEqual(['feature']);
    expect(result.events[0].actor.role).toBe('resident');
});
it('limits notes and keeps the original map untouched', () => {
    const first = recordCheckpoint(new Map(), input).records;
    const next = noteEncounter(first, '10:5:7', 'x'.repeat(1400));
    expect(next.get('10:5:7').note).toHaveLength(1200);
    expect(first.get('10:5:7').note).toBeUndefined();
    expect(noteEncounter(first, 'missing', 'note')).toBe(first);
});
