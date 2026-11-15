import type { CombatAreaType } from '../../types';

export type PixelPieceKind = 'cover' | 'wall' | 'difficult' | 'hazard' | 'decal';

export type PixelSetDef = {
    floors: readonly string[];
    cover: readonly string[];
    wall: readonly string[];
    difficult: readonly string[];
    hazard: readonly string[];
    decal: readonly string[];
    generic: { cover: readonly string[]; wall: readonly string[]; difficult: readonly string[] };
};

export const PIXEL_SETS: Readonly<Record<string, PixelSetDef>> = {
    meadow: {
        floors: ['grass', 'dirt-path'],
        cover: ['bush', 'crates', 'log', 'rock', 'stump'],
        wall: ['cliff', 'house', 'rock-large', 'tree-oak', 'tree-pine'],
        difficult: ['mud', 'tall-grass', 'rubble'],
        hazard: ['campfire', 'thorns', 'flames'],
        decal: ['flowers-white', 'flowers-yellow', 'pebbles'],
        generic: { cover: ['crates', 'rock', 'bush'], wall: ['tree-oak', 'rock-large', 'cliff'], difficult: ['rubble', 'mud'] },
    },
    village: {
        floors: ['dirt-road', 'wood-planks', 'city-cobblestone'],
        cover: ['barrels', 'cart', 'fence', 'hay-bales', 'low-wall', 'market-stall', 'well'],
        wall: ['barn', 'cottage-thatched', 'dense-forest', 'house-timber', 'palisade', 'stone-wall', 'wooden-wall'],
        difficult: ['debris', 'rubble'],
        hazard: ['burning-debris', 'flames'],
        decal: ['puddle', 'straw'],
        generic: { cover: ['barrels', 'hay-bales', 'low-wall'], wall: ['wooden-wall', 'stone-wall'], difficult: ['rubble', 'debris'] },
    },
    dungeon: {
        floors: ['dungeon-flagstone', 'cave-stone', 'sewer-brick', 'stone-rampart'],
        cover: ['altar', 'boulder', 'brazier', 'pillar', 'stalagmite', 'tomb'],
        wall: ['cave-rock', 'dungeon-gate', 'rock-pillar', 'sheer-drop', 'statue-guardian', 'stone-brick', 'stone-pillar'],
        difficult: ['bones', 'scree', 'rubble'],
        hazard: ['lava', 'pit', 'spikes'],
        decal: ['floor-cracks', 'moss-patch', 'pebbles'],
        generic: { cover: ['pillar', 'boulder', 'brazier'], wall: ['stone-brick', 'cave-rock'], difficult: ['scree', 'bones'] },
    },
    city: {
        floors: ['asphalt', 'pavement', 'carpet', 'tiled-floor'],
        cover: ['bar-counter', 'car-wreck', 'desk', 'dumpster', 'sofa', 'van'],
        wall: ['apartment-block', 'brick-wall', 'building-roof', 'lamp-post', 'partition', 'shopfront'],
        difficult: ['broken-glass', 'trash'],
        hazard: ['gas-cloud', 'open-manhole'],
        decal: ['manhole', 'road-lines'],
        generic: { cover: ['dumpster', 'desk', 'van'], wall: ['brick-wall', 'building-roof'], difficult: ['trash', 'broken-glass'] },
    },
    cyberpunk: {
        floors: ['asphalt-wet', 'concrete', 'metal-grating'],
        cover: ['generator', 'oil-drums', 'pallet', 'server-rack', 'shipping-container', 'vent-unit'],
        wall: ['billboard', 'chainlink', 'city-rooftop', 'concrete-wall', 'factory-machine', 'scrap-wall', 'storage-tank'],
        difficult: ['cables', 'scrap'],
        hazard: ['electric-arc', 'live-conduit', 'toxic-sludge'],
        decal: ['neon-glow', 'oil-stain'],
        generic: { cover: ['pallet', 'oil-drums', 'generator'], wall: ['concrete-wall', 'scrap-wall'], difficult: ['scrap', 'cables'] },
    },
    starship: {
        floors: ['metal-plating', 'rusted-deck'],
        cover: ['cargo-pod', 'console', 'cryo-pod', 'locker', 'wreckage'],
        wall: ['bulkhead-door', 'escape-pod', 'metal-bulkhead', 'pipe-column', 'reactor-core', 'viewport-window'],
        difficult: ['spilled-cargo', 'cables'],
        hazard: ['acid-splash', 'coolant', 'plasma-leak'],
        decal: ['deck-hatch', 'hazard-stripes'],
        generic: { cover: ['cargo-pod', 'locker', 'console'], wall: ['metal-bulkhead'], difficult: ['spilled-cargo'] },
    },
    hive: {
        floors: ['alien-organic'],
        cover: ['hive-pod', 'cryo-pod', 'wreckage'],
        wall: ['hive-wall', 'pipe-column'],
        difficult: ['organic-growth'],
        hazard: ['acid-splash'],
        decal: [],
        generic: { cover: ['hive-pod', 'wreckage'], wall: ['hive-wall'], difficult: ['organic-growth'] },
    },
    wetland: {
        floors: ['swamp', 'swamp-water'],
        cover: ['reeds', 'dead-tree', 'driftwood'],
        wall: ['mangrove-tree', 'dense-forest'],
        difficult: ['marsh-water'],
        hazard: ['quicksand'],
        decal: ['lily-pads'],
        generic: { cover: ['reeds', 'dead-tree'], wall: ['mangrove-tree', 'dense-forest'], difficult: ['marsh-water'] },
    },
    desert: {
        floors: ['sand'],
        cover: ['cactus', 'driftwood', 'fallen-stones'],
        wall: ['mesa-rock', 'palm-tree', 'sandstone-wall'],
        difficult: ['sand-drift'],
        hazard: ['quicksand'],
        decal: ['dry-cracks'],
        generic: { cover: ['cactus', 'fallen-stones'], wall: ['sandstone-wall', 'mesa-rock'], difficult: ['sand-drift'] },
    },
    snow: {
        floors: ['snow'],
        cover: ['ice-block', 'dead-tree'],
        wall: ['ice-spire', 'ice-wall'],
        difficult: ['snowdrift', 'slick-ice'],
        hazard: ['frost-vent'],
        decal: ['snow-tracks'],
        generic: { cover: ['ice-block', 'dead-tree'], wall: ['ice-wall', 'ice-spire'], difficult: ['snowdrift'] },
    },
    ruins: {
        floors: ['mossy-stone'],
        cover: ['fallen-pillar', 'fallen-stones', 'tombstone'],
        wall: ['broken-column', 'ruined-wall'],
        difficult: ['rubble'],
        hazard: ['collapsed-floor'],
        decal: ['floor-cracks', 'moss-patch'],
        generic: { cover: ['fallen-stones', 'fallen-pillar'], wall: ['ruined-wall', 'broken-column'], difficult: ['rubble'] },
    },
};

export const PIXEL_COMPANIONS: Readonly<Record<string, string>> = {
    grass: 'dirt-path',
    'dirt-road': 'city-cobblestone',
    'city-cobblestone': 'dirt-road',
    'dungeon-flagstone': 'cave-stone',
    'stone-rampart': 'dungeon-flagstone',
    'sewer-brick': 'dungeon-flagstone',
    asphalt: 'pavement',
    'asphalt-wet': 'concrete',
    'metal-plating': 'rusted-deck',
    swamp: 'swamp-water',
    'swamp-water': 'swamp',
};

export const NO_MIRROR: ReadonlySet<string> = new Set([
    'house', 'house-timber', 'barn', 'cottage-thatched', 'shopfront', 'apartment-block', 'billboard', 'bar-counter',
    'market-stall', 'dungeon-gate', 'bulkhead-door', 'viewport-window', 'escape-pod', 'tombstone', 'console', 'server-rack',
    'vent-unit', 'statue-guardian', 'reactor-core', 'storage-tank', 'factory-machine', 'well', 'altar', 'tomb',
]);

export function canMirror(name: string): boolean {
    return !NO_MIRROR.has(name);
}

const OUTDOOR_FLOORS: readonly string[] = [
    'grass', 'dirt-path', 'dirt-road', 'city-cobblestone', 'wood-planks', 'sand', 'snow', 'swamp', 'swamp-water',
    'asphalt', 'pavement', 'asphalt-wet', 'concrete',
];

const INDOOR_FLOORS: readonly string[] = ['wood-planks', 'tiled-floor', 'carpet', 'metal-plating', 'dungeon-flagstone', 'concrete', 'rusted-deck'];

export const AREA_FLOORS: Readonly<Record<CombatAreaType, readonly string[]>> = {
    open: [...OUTDOOR_FLOORS, 'mossy-stone'],
    scattered: [...OUTDOOR_FLOORS, 'mossy-stone'],
    ledge: [...OUTDOOR_FLOORS, 'stone-rampart', 'cave-stone', 'mossy-stone'],
    street: ['dirt-road', 'dirt-path', 'city-cobblestone', 'wood-planks', 'asphalt', 'pavement', 'asphalt-wet', 'concrete'],
    room: INDOOR_FLOORS,
    rows: [...INDOOR_FLOORS, 'metal-grating', 'asphalt', 'pavement', 'asphalt-wet', 'dirt-road'],
    corridors: [
        'dungeon-flagstone', 'sewer-brick', 'cave-stone', 'stone-rampart', 'metal-plating', 'metal-grating', 'rusted-deck',
        'alien-organic', 'concrete', 'tiled-floor', 'carpet',
    ],
    cavern: ['cave-stone', 'dungeon-flagstone', 'sewer-brick', 'mossy-stone', 'alien-organic'],
    ruins: ['mossy-stone', 'dungeon-flagstone', 'cave-stone', 'stone-rampart', 'sewer-brick'],
    wetland: ['swamp', 'swamp-water'],
};

export function areaAllowsFloor(area: CombatAreaType | undefined, floor: string): boolean {
    return !area || !AREA_FLOORS[area] || AREA_FLOORS[area].includes(floor);
}

export function areaAllowsSet(area: CombatAreaType | undefined, setId: string): boolean {
    return !area || !AREA_FLOORS[area] || AREA_FLOORS[area].some(f => PIXEL_SETS[setId]?.floors.includes(f));
}

export const PIXEL_PLACE_KEYWORDS: readonly { words: readonly string[]; floor: string }[] = [
    { words: ['highway', 'parking', 'freeway', 'intersection', 'crosswalk'], floor: 'asphalt' },
    { words: ['neon', 'cyberpunk', 'slum', 'rain slicked'], floor: 'asphalt-wet' },
    { words: ['sidewalk', 'plaza', 'promenade', 'courtyard'], floor: 'pavement' },
    { words: ['lobby', 'kitchen', 'hospital', 'clinic', 'mall', 'bathroom', 'restroom'], floor: 'tiled-floor' },
    { words: ['hotel', 'apartment', 'bedroom', 'living room'], floor: 'carpet' },
    { words: ['catwalk', 'grating', 'factory', 'foundry', 'refinery', 'power plant'], floor: 'metal-grating' },
    { words: ['derelict', 'wreck', 'rusted', 'engine room', 'cargo hold', 'freighter'], floor: 'rusted-deck' },
    { words: ['hive', 'nest', 'alien', 'organic'], floor: 'alien-organic' },
    { words: ['village', 'hamlet', 'farm', 'barn', 'stable', 'ranch', 'homestead'], floor: 'dirt-road' },
    { words: ['rampart', 'battlement', 'parapet'], floor: 'stone-rampart' },
    { words: ['pond', 'shallows'], floor: 'swamp-water' },
];

export const HAZARD_PIXEL_EXTRA: Readonly<Record<string, readonly string[]>> = {
    fire: ['campfire', 'plasma-leak'],
    electric: ['plasma-leak'],
    toxic: ['acid-splash', 'coolant'],
    pit: ['collapsed-floor', 'quicksand', 'open-manhole', 'frost-vent', 'thorns'],
    deep_water: [],
};

export const PAINTED_ONLY_FLOORS: readonly string[] = ['acid-pool', 'coolant', 'lava', 'marble', 'sewage'];

export function setIdForFloor(floor: string): string | null {
    for (const [id, def] of Object.entries(PIXEL_SETS)) if (def.floors.includes(floor)) return id;
    return null;
}

const KNOWN: Readonly<Record<PixelPieceKind, ReadonlySet<string>>> = {
    cover: new Set(Object.values(PIXEL_SETS).flatMap(s => s.cover)),
    wall: new Set(Object.values(PIXEL_SETS).flatMap(s => s.wall)),
    difficult: new Set(Object.values(PIXEL_SETS).flatMap(s => s.difficult)),
    hazard: new Set(Object.values(PIXEL_SETS).flatMap(s => s.hazard)),
    decal: new Set(Object.values(PIXEL_SETS).flatMap(s => s.decal)),
};

export function allowedInSet(setId: string | null, kind: PixelPieceKind, name: string): boolean {
    if (!setId) return true;
    if (PIXEL_SETS[setId][kind].includes(name)) return true;
    return !KNOWN[kind].has(name);
}

export function classifiedNames(kind: PixelPieceKind): ReadonlySet<string> {
    return KNOWN[kind];
}
