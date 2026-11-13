import type { AreaType, HazardKind, MapDensity, Rng, TerrainLabels } from '../types';
import type { AreaLayout } from './canvas';
import type { AreaDefinition } from './bands';
import { OPEN_AREA, generateOpen } from './open';
import { SCATTERED_AREA, generateScattered } from './scattered';
import { ROOM_AREA, generateRoom } from './room';
import { ROWS_AREA, generateRows } from './rows';
import { CORRIDORS_AREA, generateCorridors } from './corridors';
import { CAVERN_AREA, generateCavern } from './cavern';
import { STREET_AREA, generateStreet } from './street';
import { LEDGE_AREA, generateLedge } from './ledge';
import { RUINS_AREA, generateRuins } from './ruins';
import { WETLAND_AREA, generateWetland } from './wetland';

export type AreaGenerator = (width: number, height: number, density: MapDensity, rng: Rng) => AreaLayout;

export const AREA_GENERATORS: Readonly<Record<AreaType, AreaGenerator>> = {
    open: generateOpen,
    scattered: generateScattered,
    room: generateRoom,
    rows: generateRows,
    corridors: generateCorridors,
    cavern: generateCavern,
    street: generateStreet,
    ledge: generateLedge,
    ruins: generateRuins,
    wetland: generateWetland,
};

export const AREA_DEFINITIONS: Readonly<Record<AreaType, AreaDefinition>> = {
    open: OPEN_AREA,
    scattered: SCATTERED_AREA,
    room: ROOM_AREA,
    rows: ROWS_AREA,
    corridors: CORRIDORS_AREA,
    cavern: CAVERN_AREA,
    street: STREET_AREA,
    ledge: LEDGE_AREA,
    ruins: RUINS_AREA,
    wetland: WETLAND_AREA,
};

export const DEFAULT_AREA_LABELS: Readonly<Record<AreaType, Required<Omit<TerrainLabels, 'hazard'>>>> = {
    open: { wall: 'wall', cover: 'crates', difficult: 'rough ground' },
    scattered: { wall: 'rock', cover: 'trees', difficult: 'undergrowth' },
    room: { wall: 'wall', cover: 'tables', difficult: 'debris' },
    rows: { wall: 'wall', cover: 'racks', difficult: 'clutter' },
    corridors: { wall: 'wall', cover: 'crates', difficult: 'debris' },
    cavern: { wall: 'rock', cover: 'boulders', difficult: 'rubble' },
    street: { wall: 'buildings', cover: 'crates', difficult: 'debris' },
    ledge: { wall: 'sheer drop', cover: 'rocks', difficult: 'scree' },
    ruins: { wall: 'broken walls', cover: 'fallen stones', difficult: 'rubble' },
    wetland: { wall: 'rock', cover: 'dead trees', difficult: 'water' },
};

export const DEFAULT_HAZARD_LABELS: Readonly<Record<HazardKind, string>> = {
    none: 'hazard',
    fire: 'fire',
    deep_water: 'deep water',
    electric: 'live current',
    toxic: 'toxic sludge',
    pit: 'pit',
};

export { AREA_TYPES, MAP_DENSITIES, STRUCTURAL_AREAS, shareBand, measuredRows, bandCounts, terrainShare } from './bands';
export type { AreaDefinition, BandCounts } from './bands';
export { Canvas, SPAWN_COLUMNS } from './canvas';
export type { AreaLayout, Piece, PieceKind } from './canvas';
