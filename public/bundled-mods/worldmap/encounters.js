import { worldProfile } from './worldProfiles.js';
import { localEvent, siteEvent, localScene } from './encounterScenes.js';
// Authored situations: prompts for optional play, never automatic damage or movement.
export const FEATURE_EVENTS = {
    settlement: ['A public disagreement', 'Two locals disagree over a delivery. Either may welcome an impartial listener.'],
    ruin: ['Recent tracks', 'Fresh tracks lead toward the ruins; whoever left them may still be nearby.'],
    shrine: ['A waiting pilgrim', 'A pilgrim rests near the shrine, carrying an offering and an unfinished story.'],
    camp: ['Another campfire', 'Smoke from another campfire suggests travellers nearby. Their intentions are unknown.'],
    crossing: ['A stranded traveller', 'A traveller near the crossing is assessing damaged equipment and could use assistance.'],
    landmark: ['An unfinished sketch', 'A surveyor studies the landmark and compares it with a worn sketch.'],
};
export const BIOME_EVENTS = {
    plains: ['Distant travellers', 'Travellers appear on the horizon. There is time to decide whether to seek contact.'],
    farmland: ['An unattended load', 'A laden cart stands beside the fields, with signs of work interrupted.'],
    savanna: ['A moving herd', 'A herd crosses the open ground in the distance. Something has disturbed it.'],
    forest: ['Sounds in the trees', 'Branches crack beyond the clearing. The source is not yet visible.'],
    taiga: ['Tracks in the needles', 'Large animal tracks cut through the fallen needles near the stopping place.'],
    tundra: ['An abandoned bundle', 'A weathered bundle lies beside old tracks across the tundra.'],
    desert: ['A glint in the sand', 'Something catches the light beyond the immediate stopping place.'],
    marsh: ['An uncertain footing', 'Bubbles and shifting reeds reveal unstable ground nearby.'],
    jungle: ['A sudden silence', 'Bird calls cease in a patch of jungle near the party.'],
    mountain: ['Falling stones', 'Loose stones rattle down a nearby slope, warning of unstable ground.'],
    glacier: ['A crack in the ice', 'A sharp report echoes across the ice; a new fissure is visible nearby.'],
    ocean: ['A distant sail', 'A sail appears through the sea haze. Its course is not yet clear.'],
};
export const WEATHER_EVENTS = {
    rain: ['Steady rain', 'Rain makes exposed gear and shelter worth checking.'],
    fog: ['Thickening fog', 'Fog obscures distant landmarks around the stopping place.'],
    wind: ['Rising wind', 'Gusts tug at loose equipment and carry distant sounds.'],
    thunderstorm: ['Thunder overhead', 'Thunder rolls overhead and lightning makes exposed ground uninviting.'],
    snow: ['Gathering snow', 'Snow begins covering tracks and exposed supplies.'],
};
export const COMBINATIONS = [
    { id: 'sea-storm', biome: 'ocean', weather: 'thunderstorm', weight: 8, title: 'Storm at sea', text: 'Lightning reveals steep waves and a wall of rain. The party can decide how to respond to the storm.' },
    { id: 'marsh-rain', biome: 'marsh', weather: 'rain', weight: 8, title: 'Rising marsh water', text: 'Rain feeds the marsh around the stopping place. Water creeps toward the available dry ground.' },
    { id: 'ruin-fog', feature: 'ruin', weather: 'fog', weight: 8, title: 'Voices in the ruins', text: 'Fog surrounds the nearby ruins. Muffled voices seem to come from within, but their source is unclear.' },
    { id: 'mountain-wind', biome: 'mountain', weather: 'wind', weight: 8, title: 'Stones on the wind', text: 'Strong gusts accompany falling grit from an exposed slope near the stopping place.' },
    { id: 'camp-rain', feature: 'camp', weather: 'rain', weight: 8, title: 'Shelter by the camp', text: 'Rain drives nearby travellers toward the same limited shelter. Sharing it may require a conversation.' },
    { id: 'shrine-snow', feature: 'shrine', weather: 'snow', weight: 8, title: 'An offering in the snow', text: 'Fresh offerings lie in the snow near the shrine, beside footprints that are quickly fading.' },
];
function hash(value) {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    h ^= h >>> 16; h = Math.imul(h, 2246822507); h ^= h >>> 13;
    return h >>> 0;
}
function randomFor(seed) { let n = 0; return () => hash(`${seed}:${n++}`) / 4294967296; }
function pick(rows, random) {
    let roll = random() * rows.reduce((sum, row) => sum + row.weight, 0);
    for (const row of rows) { roll -= row.weight; if (roll < 0) return row; }
    return rows.at(-1);
}
export function weatherAt(seed, x, y, day, biome) {
    const random = randomFor(`${seed}:weather:${Math.floor(x / 32)}:${Math.floor(y / 32)}:${day}`);
    const weather = pick([{ id: 'clear', weight: 5 }, { id: 'rain', weight: 2 }, { id: 'fog', weight: 1 },
        { id: 'wind', weight: 2 }, { id: 'thunderstorm', weight: 1 }], random).id;
    return weather === 'rain' && ['tundra', 'taiga', 'glacier'].includes(biome) ? 'snow' : weather;
}
export function checkpointKey({ x, y, worldDay }) { return `${worldDay}:${x}:${y}`; }
export function rollEncounter(input, random = randomFor(`${input.seed}:encounter:${checkpointKey(input)}`)) {
    const weather = input.weather ?? weatherAt(input.seed, input.x, input.y, input.worldDay, input.biome);
    // A nearby discovery is not an occupied site.
    input = { ...input, feature: input.feature?.distance === 0 ? input.feature : undefined };
    const combinations = COMBINATIONS.filter(row => (!row.biome || row.biome === input.biome)
        && (!row.feature || row.feature === input.feature?.type) && row.weather === weather);
    const selected = pick([{ id: 'base', weight: 4 }, ...combinations], random);
    const events = [];
    if (selected.id !== 'base') events.push({ id: selected.id, source: 'combination', title: selected.title, text: selected.text });
    else {
        for (const [source, id, pair] of [['feature', input.feature?.type, FEATURE_EVENTS[input.feature?.type]],
            ['biome', input.biome, BIOME_EVENTS[input.biome]], ['weather', weather, WEATHER_EVENTS[weather]]]) {
            if (source === 'biome' && input.feature?.type === 'settlement') continue;
            if (pair && random() < 0.3) {
                const detailed = source === 'feature' ? siteEvent(input) : source === 'biome' ? localEvent(input, random) : null;
                events.push(detailed ?? { id: `${source}-${id}`, source, title: pair[0], text: pair[1] });
            }
        }
    }
    return { key: checkpointKey(input), x: input.x, y: input.y, worldDay: input.worldDay, biome: input.biome,
        weather, worldProfile: worldProfile(input.worldProfile).id, scene: localScene(input), onRoad: Boolean(input.onRoad), featureId: input.feature?.id ?? null, quiet: events.length === 0, events, status: 'available' };
}
export function readEncounters(raw) {
    const records = new Map();
    for (const row of Array.isArray(raw?.records) ? raw.records : []) {
        if (!row || !Number.isSafeInteger(row.x) || !Number.isSafeInteger(row.y) || !Number.isFinite(row.worldDay)
            || row.key !== checkpointKey(row) || !Array.isArray(row.events)
            || !row.events.every(event => typeof event?.title === 'string' && typeof event?.text === 'string')) continue;
        records.set(row.key, { ...row, status: ['available', 'handled', 'passed'].includes(row.status) ? row.status : 'available' });
    }
    return records;
}
export function serializeEncounters(records) { return { records: [...records.values()] }; }
export function recordCheckpoint(records, input) {
    const next = new Map(records);
    const key = checkpointKey(input);
    let changed = false;
    for (const [oldKey, row] of next) if (oldKey !== key && row.status === 'available') {
        next.set(oldKey, { ...row, status: 'passed' }); changed = true;
    }
    if (!next.has(key)) { next.set(key, rollEncounter(input)); changed = true; }
    return { records: next, record: next.get(key), changed };
}
export function handleEncounter(records, key) {
    const row = records.get(key);
    if (!row || row.status !== 'available') return records;
    const next = new Map(records); next.set(key, { ...row, status: 'handled' }); return next;
}

// Notes are player-authored memories, never an automatic reward or resolution.
export function noteEncounter(records, key, note) {
    const row = records.get(key);
    if (!row || typeof note !== 'string') return records;
    const next = new Map(records);
    next.set(key, { ...row, note: note.trim().slice(0, 1200) });
    return next;
}
