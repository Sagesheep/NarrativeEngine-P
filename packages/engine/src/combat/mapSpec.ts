import { AREA_TYPES, DEFAULT_AREA_LABELS, DEFAULT_HAZARD_LABELS, MAP_DENSITIES } from './areas/index';
import type { AreaType, HazardKind, MapSize, MapSpec, ResolvedMapSpec, TerrainLabels } from './types';

export const HAZARD_KINDS: readonly HazardKind[] = ['none', 'fire', 'deep_water', 'electric', 'toxic', 'pit'];
export const MAP_SIZE_KEYS: readonly MapSize[] = ['small', 'medium', 'large'];
export const LABEL_MAX = 24;
export const PLACE_MAX = 160;

const LABEL_KEYS = ['wall', 'cover', 'difficult', 'hazard'] as const;

type Entry = { area: AreaType; words: readonly string[]; labels?: TerrainLabels; strong?: boolean };

export const AREA_KEYWORDS: readonly Entry[] = [
    { area: 'ruins', strong: true, words: ['ruins', 'ruin', 'ruined', 'crumbling', 'ancient ruins', 'collapsed building', 'collapsed temple', 'collapsed tunnel'], labels: { wall: 'broken walls', cover: 'fallen pillars', difficult: 'rubble' } },
    { area: 'ruins', strong: true, words: ['bombed-out', 'bombed out', 'war-torn', 'burned-out', 'burnt-out', 'razed', 'shelled'], labels: { wall: 'shattered walls', cover: 'rubble heaps', difficult: 'rubble' } },
    { area: 'ruins', words: ['wreck', 'shipwreck', 'wrecked ship', 'derelict', 'crash site'], labels: { wall: 'hull sections', cover: 'debris', difficult: 'wreckage' } },
    { area: 'wetland', strong: true, words: ['flooded', 'waterlogged', 'submerged', 'sunken temple', 'sunken city', 'sunken ship', 'flooded cave'], labels: { wall: 'rock', cover: 'debris', difficult: 'flood water' } },
    { area: 'wetland', words: ['swamp', 'bog', 'mire', 'fen', 'bayou', 'quagmire', 'wetland', 'everglade'], labels: { wall: 'rock', cover: 'dead trees', difficult: 'swamp water' } },
    { area: 'wetland', words: ['marsh', 'marshland', 'reed bed', 'salt marsh'], labels: { wall: 'rock', cover: 'reed clumps', difficult: 'marsh water' } },
    { area: 'wetland', words: ['mangrove', 'mangrove swamp'], labels: { wall: 'rock', cover: 'mangroves', difficult: 'brackish water' } },
    { area: 'wetland', words: ['ford', 'river crossing', 'riverbank', 'river bank', 'stream', 'creek', 'shallows', 'shoreline', 'shore', 'lakeshore', 'delta', 'estuary', 'lagoon'], labels: { wall: 'rock', cover: 'rocks', difficult: 'shallows' } },
    { area: 'wetland', words: ['mudflat', 'mudflats', 'tidal flats', 'rice paddy', 'paddy', 'paddies'], labels: { wall: 'rock', cover: 'rocks', difficult: 'mud' } },
    { area: 'rows', words: ['server room', 'data center', 'data centre', 'server farm', 'server hall'], labels: { wall: 'wall', cover: 'server racks', difficult: 'cables' } },
    { area: 'rows', words: ['warehouse', 'storehouse', 'stockroom', 'storeroom', 'storage room', 'depot', 'cargo hold', 'loading bay', 'distribution center'], labels: { wall: 'wall', cover: 'crates', difficult: 'spilled cargo' } },
    { area: 'rows', words: ['library', 'archive', 'archives', 'records room', 'scriptorium'], labels: { wall: 'wall', cover: 'bookshelves', difficult: 'scattered books' } },
    { area: 'rows', words: ['market', 'marketplace', 'bazaar', 'souk', 'night market', 'flea market', 'trading post'], labels: { wall: 'wall', cover: 'stalls', difficult: 'spilled goods' } },
    { area: 'rows', words: ['hangar', 'garage', 'motor pool', 'parking lot', 'parking garage', 'car park', 'vehicle bay', 'docking bay'], labels: { wall: 'wall', cover: 'vehicles', difficult: 'oil slicks' } },
    { area: 'rows', words: ['factory', 'factory floor', 'assembly line', 'foundry', 'workshop', 'mill', 'refinery', 'plant floor'], labels: { wall: 'wall', cover: 'machinery', difficult: 'scrap' } },
    { area: 'rows', words: ['greenhouse', 'hydroponics', 'hydroponic bay', 'vineyard', 'orchard', 'plantation', 'crop field'], labels: { wall: 'wall', cover: 'planters', difficult: 'soft soil' } },
    { area: 'rows', words: ['laboratory', 'lab', 'classroom', 'lecture hall', 'barracks', 'dormitory', 'morgue', 'stables', 'cubicles', 'cubicle farm', 'shop', 'supermarket', 'pharmacy'], labels: { wall: 'wall', cover: 'shelves', difficult: 'clutter' } },
    { area: 'corridors', words: ['starship', 'spaceship', 'space station', 'ship corridor', 'airlock', 'submarine', 'space hulk', 'orbital', 'freighter', 'cruiser'], labels: { wall: 'bulkheads', cover: 'cargo crates', difficult: 'debris' } },
    { area: 'corridors', words: ['dungeon', 'catacombs', 'catacomb', 'labyrinth', 'maze', 'prison', 'jail', 'cell block', 'oubliette', 'fortress', 'citadel', 'stronghold'], labels: { wall: 'stone walls', cover: 'barrels', difficult: 'rubble' } },
    { area: 'corridors', words: ['sewer', 'sewers', 'storm drain', 'cistern', 'drainage tunnel'], labels: { wall: 'brick walls', cover: 'pipes', difficult: 'sewage' } },
    { area: 'corridors', words: ['bunker', 'facility', 'compound', 'military base', 'research complex', 'vault', 'silo'], labels: { wall: 'concrete', cover: 'crates', difficult: 'debris' } },
    { area: 'corridors', words: ['corridor', 'corridors', 'hallway', 'hallways', 'passage', 'passageway', 'tunnel', 'tunnels', 'subway', 'metro', 'maintenance shaft', 'service tunnel', 'ventilation shaft'], labels: { wall: 'wall', cover: 'crates', difficult: 'debris' } },
    { area: 'corridors', words: ['office floor', 'office block', 'office building', 'skyscraper floor'], labels: { wall: 'partitions', cover: 'desks', difficult: 'debris' } },
    { area: 'corridors', words: ['trench', 'trenches', 'foxhole', 'earthworks'], labels: { wall: 'earthworks', cover: 'sandbags', difficult: 'mud' } },
    { area: 'cavern', words: ['cave', 'caves', 'cavern', 'caverns', 'grotto', 'underdark', 'lava tube', 'sinkhole cave'], labels: { wall: 'rock', cover: 'stalagmites', difficult: 'rubble' } },
    { area: 'cavern', words: ['mines', 'gold mine', 'old mine', 'abandoned mine', 'mine tunnel', 'mineshaft', 'mine shaft', 'quarry', 'dig site'], labels: { wall: 'rock', cover: 'ore carts', difficult: 'rubble' } },
    { area: 'cavern', words: ['burrow', 'den', 'lair', 'warren', 'nest', 'hive'], labels: { wall: 'earth', cover: 'boulders', difficult: 'bone piles' } },
    { area: 'cavern', words: ['ice cave', 'glacier cave', 'crystal cave', 'geode'], labels: { wall: 'ice', cover: 'ice pillars', difficult: 'slick ice' } },
    { area: 'ledge', words: ['mountain pass', 'narrow pass', 'high pass', 'mountain path', 'mountain trail', 'switchback', 'cliff path', 'cliff', 'cliffs', 'cliffside', 'cliff edge', 'ledge', 'ridge', 'ridgeline', 'precipice', 'mountainside', 'goat track'], labels: { wall: 'sheer drop', cover: 'rocks', difficult: 'scree' } },
    { area: 'ledge', words: ['rampart', 'ramparts', 'battlement', 'battlements', 'parapet', 'castle wall', 'castle walls', 'city wall', 'city walls', 'wall walk', 'wall-walk', 'walkway', 'tower top'], labels: { wall: 'sheer drop', cover: 'crenellations', difficult: 'rubble' } },
    { area: 'ledge', words: ['catwalk', 'catwalks', 'gantry', 'scaffolding', 'girder', 'girders', 'crane arm', 'pipeline'], labels: { wall: 'long drop', cover: 'machinery', difficult: 'loose grating' } },
    { area: 'ledge', words: ['bridge', 'rope bridge', 'stone bridge', 'drawbridge', 'viaduct', 'aqueduct'], labels: { wall: 'sheer drop', cover: 'railings', difficult: 'loose planks' } },
    { area: 'street', words: ['alley', 'alleyway', 'back alley', 'backstreet', 'side street', 'underpass'], labels: { wall: 'buildings', cover: 'dumpsters', difficult: 'trash' } },
    { area: 'street', words: ['street', 'avenue', 'boulevard', 'main street', 'high street', 'intersection', 'downtown', 'city street', 'highway', 'freeway', 'overpass', 'bridge approach'], labels: { wall: 'buildings', cover: 'cars', difficult: 'debris' } },
    { area: 'street', words: ['village street', 'town street', 'lane', 'cobbled street', 'cobblestone street', 'market street'], labels: { wall: 'houses', cover: 'carts', difficult: 'mud' } },
    { area: 'street', words: ['road', 'country road', 'dirt road', 'sunken road', 'causeway'], labels: { wall: 'hedgerows', cover: 'carts', difficult: 'mud' } },
    { area: 'street', words: ['forest road', 'woodland road', 'forest path', 'forest trail', 'jungle path', 'jungle trail'], labels: { wall: 'dense forest', cover: 'carts', difficult: 'undergrowth' } },
    { area: 'street', words: ['canal', 'canal side', 'canalside', 'docks', 'dock', 'wharf', 'quay', 'harbor', 'harbour', 'port', 'pier', 'waterfront', 'boardwalk'], labels: { wall: 'warehouses', cover: 'cargo crates', difficult: 'puddles' } },
    { area: 'street', words: ['slum', 'slums', 'shantytown', 'favela', 'shanty town'], labels: { wall: 'shacks', cover: 'junk piles', difficult: 'trash' } },
    { area: 'street', words: ['canyon', 'ravine', 'gorge', 'gully', 'gulch'], labels: { wall: 'canyon walls', cover: 'boulders', difficult: 'scree' } },
    { area: 'room', words: ['tavern', 'inn', 'pub', 'bar', 'saloon', 'alehouse', 'taproom', 'common room', 'cantina', 'speakeasy', 'mess hall', 'cafeteria', 'canteen', 'restaurant', 'diner', 'cafe', 'kitchen'], labels: { wall: 'wall', cover: 'tables', difficult: 'spilled drinks' } },
    { area: 'room', words: ['nightclub', 'night club', 'disco', 'lounge', 'casino', 'brothel'], labels: { wall: 'wall', cover: 'booths', difficult: 'debris' } },
    { area: 'room', words: ['hall', 'great hall', 'mead hall', 'banquet hall', 'ballroom', 'feast hall', 'guildhall', 'guild hall'], labels: { wall: 'wall', cover: 'tables', difficult: 'debris' } },
    { area: 'room', words: ['throne room', 'audience chamber', 'temple', 'shrine', 'sanctum', 'sanctuary', 'palace', 'cathedral', 'church', 'chapel', 'crypt', 'tomb', 'mausoleum'], labels: { wall: 'wall', cover: 'pillars', difficult: 'debris' } },
    { area: 'room', words: ['office', 'boardroom', 'lobby', 'foyer', 'atrium', 'reception', 'bank', 'courtroom', 'council chamber', 'senate'], labels: { wall: 'wall', cover: 'desks', difficult: 'debris' } },
    { area: 'room', words: ['mansion', 'manor', 'estate', 'parlor', 'parlour', 'bedroom', 'chamber', 'apartment', 'penthouse', 'loft', 'hideout', 'safehouse', 'safe house', 'cabin', 'hut', 'house', 'home'], labels: { wall: 'wall', cover: 'furniture', difficult: 'debris' } },
    { area: 'room', words: ['dojo', 'gym', 'training hall', 'bathhouse', 'bridge deck', 'command deck', 'command bridge', 'control room', 'cockpit'], labels: { wall: 'wall', cover: 'pillars', difficult: 'debris' } },
    { area: 'scattered', words: ['forest', 'woods', 'woodland', 'grove', 'thicket', 'copse', 'taiga', 'treeline', 'tree line', 'birch wood', 'pine forest'], labels: { wall: 'rock', cover: 'trees', difficult: 'undergrowth' } },
    { area: 'scattered', words: ['jungle', 'rainforest', 'rain forest'], labels: { wall: 'rock', cover: 'trees', difficult: 'vines' } },
    { area: 'scattered', words: ['graveyard', 'cemetery', 'churchyard', 'necropolis', 'burial ground', 'tombstones', 'barrow'], labels: { wall: 'stone walls', cover: 'tombstones', difficult: 'grave mounds' } },
    { area: 'scattered', words: ['junkyard', 'scrapyard', 'scrap yard', 'landfill', 'salvage yard', 'dump'], labels: { wall: 'scrap walls', cover: 'scrap heaps', difficult: 'loose scrap' } },
    { area: 'scattered', words: ['boulder field', 'boulders', 'rocky slope', 'badlands', 'scree field', 'rockfall', 'standing stones', 'stone circle'], labels: { wall: 'rock', cover: 'boulders', difficult: 'scree' } },
    { area: 'scattered', words: ['garden', 'gardens', 'park', 'hedge maze', 'topiary'], labels: { wall: 'hedges', cover: 'hedges', difficult: 'flowerbeds' } },
    { area: 'scattered', words: ['camp', 'campsite', 'encampment', 'war camp', 'bandit camp', 'caravan', 'wagon circle'], labels: { wall: 'palisade', cover: 'tents', difficult: 'trampled mud' } },
    { area: 'scattered', words: ['mushroom forest', 'fungal forest', 'debris field', 'wreckage field', 'asteroid'], labels: { wall: 'rock', cover: 'wreckage', difficult: 'debris' } },
    { area: 'open', words: ['rooftop', 'roof', 'rooftops', 'helipad', 'skybridge'], labels: { wall: 'wall', cover: 'vents', difficult: 'loose gravel' } },
    { area: 'open', words: ['landing pad', 'launch pad', 'airfield', 'runway', 'tarmac', 'flight deck'], labels: { wall: 'wall', cover: 'cargo crates', difficult: 'scorched plating' } },
    { area: 'open', words: ['arena', 'colosseum', 'coliseum', 'fighting pit', 'pit fight', 'boxing ring', 'stadium', 'tournament ground', 'dueling ground', 'duelling ground', 'training ground', 'parade ground'], labels: { wall: 'wall', cover: 'pillars', difficult: 'loose sand' } },
    { area: 'open', words: ['plaza', 'town square', 'city square', 'village square', 'piazza', 'forum', 'courtyard', 'yard', 'quad'], labels: { wall: 'wall', cover: 'statues', difficult: 'rubble' } },
    { area: 'open', words: ['field', 'fields', 'meadow', 'pasture', 'farmland', 'farm', 'farmyard', 'hayfield', 'wheat field'], labels: { wall: 'stone walls', cover: 'hay bales', difficult: 'tall grass' } },
    { area: 'open', words: ['plains', 'grassland', 'steppe', 'savanna', 'savannah', 'tundra', 'heath', 'moor', 'moorland', 'prairie', 'hilltop', 'hill', 'clearing', 'crossroads', 'battlefield'], labels: { wall: 'rock', cover: 'boulders', difficult: 'tall grass' } },
    { area: 'open', words: ['beach', 'desert', 'dunes', 'sand dunes', 'salt flats', 'wasteland', 'snowfield', 'ice field', 'frozen lake', 'glacier'], labels: { wall: 'rock', cover: 'rocks', difficult: 'soft sand' } },
    { area: 'open', words: ['deck', 'ship deck', 'main deck', 'galleon', 'longship'], labels: { wall: 'railing', cover: 'barrels', difficult: 'coiled rope' } },
];

type HazardEntry = { hazard: Exclude<HazardKind, 'none'>; words: readonly string[]; strong?: boolean };

export const HAZARD_KEYWORDS: readonly HazardEntry[] = [
    { hazard: 'fire', words: ['fire', 'fires', 'flames', 'burning', 'blaze', 'inferno', 'lava', 'magma', 'molten', 'embers', 'brazier', 'braziers', 'pyre', 'bonfire', 'wildfire', 'flamethrower', 'burning oil'] },
    { hazard: 'deep_water', words: ['deep water', 'deep pool', 'deep pools', 'rapids', 'river', 'underground river', 'torrent', 'whirlpool', 'drowning pool', 'flood channel'] },
    { hazard: 'electric', words: ['live wire', 'live wires', 'electrified', 'electric fence', 'sparking', 'exposed cables', 'exposed wiring', 'power conduit', 'power conduits', 'plasma conduit', 'plasma conduits', 'tesla coil', 'tesla coils', 'high voltage', 'arcing', 'lightning rods'] },
    { hazard: 'toxic', words: ['toxic', 'poison gas', 'poisonous', 'acid', 'acid pool', 'acid vat', 'chemical spill', 'chemicals', 'radioactive', 'radiation', 'miasma', 'noxious', 'caustic', 'sludge', 'toxic sludge', 'spores', 'biohazard', 'nerve gas', 'venom pool'] },
    { hazard: 'pit', words: ['spike pit', 'spike pits', 'pits', 'pitfall', 'pitfalls', 'chasm', 'crevasse', 'crevasses', 'sinkhole', 'trapdoor', 'trapdoors', 'open pit', 'bottomless pit', 'abyss'] },
];

export const KEYWORD_COUNT = AREA_KEYWORDS.reduce((n, e) => n + e.words.length, 0) + HAZARD_KEYWORDS.reduce((n, e) => n + e.words.length, 0);

function escape(word: string): string {
    return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[\s-]+/g, '[\\s-]+');
}

function patternFor(word: string, exclude?: string): RegExp {
    const plural = /s$/.test(word) ? '' : '(?:e?s)?';
    const tail = exclude ? `(?![\\s-]+${exclude})` : '';
    return new RegExp(`(?<![\\p{L}\\p{N}])${escape(word)}${plural}(?![\\p{L}\\p{N}])${tail}`, 'iu');
}

type Compiled<T> = { entry: T; word: string; re: RegExp };

const AREA_PATTERNS: ReadonlyArray<Compiled<Entry>> = AREA_KEYWORDS.flatMap(entry => entry.words.map(word => ({ entry, word, re: patternFor(word) })));

const HAZARD_PATTERNS: ReadonlyArray<Compiled<HazardEntry>> = HAZARD_KEYWORDS.flatMap(entry => entry.words.map(word => ({ entry, word, re: patternFor(word, word === 'fire' ? 'escape' : undefined) })));

type Hit<T> = { entry: T; word: string; index: number; text: string };

function bestHit<T extends { strong?: boolean }>(text: string, patterns: ReadonlyArray<Compiled<T>>): Hit<T> | null {
    let best: Hit<T> | null = null;
    for (const p of patterns) {
        const m = p.re.exec(text);
        if (!m) continue;
        const hit: Hit<T> = { entry: p.entry, word: p.word, index: m.index, text: m[0] };
        if (!best) {
            best = hit;
            continue;
        }
        const strongA = hit.entry.strong === true;
        const strongB = best.entry.strong === true;
        if (strongA !== strongB) {
            if (strongA) best = hit;
            continue;
        }
        if (hit.index < best.index || (hit.index === best.index && hit.text.length > best.text.length)) best = hit;
    }
    return best;
}

export type MapInference = {
    matched: boolean;
    area: AreaType;
    labels?: TerrainLabels;
    hazard?: Exclude<HazardKind, 'none'>;
    hazardLabel?: string;
    source?: number;
};

export function inferHazard(text: string | undefined): { hazard: Exclude<HazardKind, 'none'>; label: string } | null {
    if (!text) return null;
    const hit = bestHit(text, HAZARD_PATTERNS);
    if (!hit) return null;
    const label = cleanLabel(hit.text);
    return { hazard: hit.entry.hazard, label: label || DEFAULT_HAZARD_LABELS[hit.entry.hazard] };
}

export function inferMapSpec(texts: string | ReadonlyArray<string | undefined | null>): MapInference {
    const list = typeof texts === 'string' ? [texts] : texts;
    for (let i = 0; i < list.length; i++) {
        const text = list[i];
        if (!text || typeof text !== 'string') continue;
        const hit = bestHit(text, AREA_PATTERNS);
        if (!hit) continue;
        return { matched: true, area: hit.entry.area, ...(hit.entry.labels ? { labels: { ...hit.entry.labels } } : {}), source: i };
    }
    return { matched: false, area: 'scattered' };
}

export function cleanLabel(raw: unknown): string {
    if (typeof raw !== 'string') return '';
    const text = raw.normalize('NFC').toLowerCase().replace(/[^\p{L}\p{M}\s'-]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (text.length <= LABEL_MAX) return text;
    const cut = text.slice(0, LABEL_MAX + 1);
    const space = cut.lastIndexOf(' ');
    return (space > 0 ? cut.slice(0, space) : text.slice(0, LABEL_MAX)).trim();
}

function cleanText(raw: unknown, max: number): string {
    return typeof raw === 'string' ? raw.replace(/\s+/g, ' ').trim().slice(0, max) : '';
}

function asRecord(raw: unknown): Record<string, unknown> | null {
    return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : null;
}

function pickFrom<T extends string>(raw: unknown, allowed: readonly T[]): T | undefined {
    if (typeof raw !== 'string') return undefined;
    const lower = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
    return (allowed as readonly string[]).includes(lower) ? lower as T : undefined;
}

export function normalizeLabels(raw: unknown): TerrainLabels | undefined {
    const rec = asRecord(raw);
    if (!rec) return undefined;
    const out: TerrainLabels = {};
    for (const key of LABEL_KEYS) {
        const label = cleanLabel(rec[key]);
        if (label) out[key] = label;
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

export function normalizeMapSpec(raw: unknown): MapSpec {
    const rec = asRecord(raw);
    if (!rec) return {};
    const out: MapSpec = {};
    const area = pickFrom(rec.area, AREA_TYPES);
    if (area) out.area = area;
    const density = pickFrom(rec.density, MAP_DENSITIES);
    if (density) out.density = density;
    const hazard = pickFrom(rec.hazard, HAZARD_KINDS);
    if (hazard) out.hazard = hazard;
    const labels = normalizeLabels(rec.labels);
    if (labels) out.labels = labels;
    const size = pickFrom(rec.size, MAP_SIZE_KEYS);
    if (size) out.size = size;
    const parts: string[] = [];
    const place = cleanText(rec.place, PLACE_MAX);
    if (place) parts.push(place);
    const theme = cleanText(rec.theme, PLACE_MAX);
    if (theme) parts.push(theme);
    if (Array.isArray(rec.features)) {
        for (const f of rec.features) {
            const kind = cleanText(asRecord(f)?.kind, 40);
            if (kind) parts.push(kind);
        }
    }
    const joined = parts.join(', ').slice(0, PLACE_MAX).trim();
    if (joined) out.place = joined;
    return out;
}

export function mapSizeFor(combatants: number, area?: AreaType): MapSize {
    const n = Number.isFinite(combatants) ? Math.max(0, Math.floor(combatants)) : 0;
    const size: MapSize = n <= 3 ? 'small' : n <= 7 ? 'medium' : 'large';
    if (size === 'small' && (area === 'ledge' || area === 'street')) return 'medium';
    return size;
}

export function defaultLabels(area: AreaType, hazard: HazardKind = 'none'): Required<TerrainLabels> {
    return { ...DEFAULT_AREA_LABELS[area], hazard: DEFAULT_HAZARD_LABELS[hazard] };
}

export type ResolveOptions = { combatants?: number; texts?: ReadonlyArray<string | undefined | null> };

export function resolveMapSpec(raw: unknown, opts: ResolveOptions = {}): ResolvedMapSpec {
    const spec = normalizeMapSpec(raw);
    const inferred = inferMapSpec([spec.place, ...(opts.texts ?? [])]);
    const area = spec.area ?? inferred.area;
    const hazardHit = spec.hazard ? null : inferHazard(spec.place);
    const hazard: HazardKind = spec.hazard ?? hazardHit?.hazard ?? 'none';
    const labels: Required<TerrainLabels> = {
        ...defaultLabels(area, hazard),
        ...(inferred.matched && inferred.area === area ? inferred.labels : {}),
        ...(hazardHit && hazard === hazardHit.hazard ? { hazard: hazardHit.label } : {}),
        ...(spec.labels ?? {}),
    } as Required<TerrainLabels>;
    const size = spec.size ?? (opts.combatants !== undefined ? mapSizeFor(opts.combatants, area) : 'medium');
    return {
        area,
        density: spec.density ?? 'normal',
        hazard,
        labels,
        size,
        ...(spec.place ? { place: spec.place } : {}),
    };
}
