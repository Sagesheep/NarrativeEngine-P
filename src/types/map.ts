// ─── World Map Types ──────────────────────────────────────────────────────

export type BiomeDefinition = {
    id: string;
    label: string;
    color: string;
    registry: string;
    travelCost?: number;
    tags?: string[];
};

export type WorldAnchor = {
    name: string;
    type: 'capital' | 'city' | 'town' | 'dungeon' | 'landmark' | 'natural';
    biome: string;
    position: 'center' | 'north' | 'south' | 'east' | 'west' | 'northeast' | 'northwest' | 'southeast' | 'southwest';
    tags: string[];
    footprint: number;
};

export type MapPin = {
    id: string;
    x: number;
    y: number;
    label: string;
    color: string;
    createdAt: number;
};

export type WorldCell = {
    x: number;
    y: number;
    biome: string;
    elevation: number;
    isOcean: boolean;
    anchorName?: string | null;
};

export type BiomeZone = {
    biome: string;
    position: 'center' | 'north' | 'south' | 'east' | 'west' | 'northeast' | 'northwest' | 'southeast' | 'southwest';
};

export type WorldMap = {
    width: number;
    height: number;
    cells: WorldCell[];
    anchors: WorldAnchor[];
    biomeZones: BiomeZone[];
    pins: MapPin[];
    seed: number;
    worldType: 'single_continent' | 'two_continents' | 'archipelago' | 'coastal_kingdom';
    generatedAt: number;
};

export type WorldMapGenerateResult = {
    worldType: WorldMap['worldType'];
    anchors: WorldAnchor[];
    biomeZones: BiomeZone[];
};

export type EngineSeed = {
    surpriseTypes: string[];
    surpriseTones: string[];
    encounterTypes: string[];
    encounterTones: string[];
    worldWho: string[];
    worldWhere: string[];
    worldWhy: string[];
    worldWhat: string[];
};
