import { FIELD_WORLD_SIZE, BIOME_IDS } from './field.js';
import { validCell, visibleCells } from './exploration.js';

export const BIOME_TARGETS = Object.freeze({
    snow: { elev: 0.2, temp: -0.75, moist: 0, geology: 0 },
    glacier: { elev: 0.2, temp: -0.8, moist: -0.5, geology: 0 },
    tundra: { elev: 0.2, temp: -0.3, moist: -0.5, geology: 0 },
    taiga: { elev: 0.2, temp: -0.2, moist: -0.1, geology: 0 },
    forest: { elev: 0.2, temp: 0, moist: 0.2, geology: 0 },
    plains: { elev: 0.2, temp: 0, moist: -0.2, geology: 0 },
    farmland: { elev: 0.2, temp: 0.3, moist: -0.1, geology: 0 },
    savanna: { elev: 0.2, temp: 0.6, moist: -0.1, geology: 0 },
    desert: { elev: 0.2, temp: 0.6, moist: -0.4, geology: 0 },
    marsh: { elev: 0.2, temp: 0, moist: 0.5, geology: 0 },
    jungle: { elev: 0.2, temp: 0.6, moist: 0.5, geology: 0 },
    mountain: { elev: 0.7, temp: 0, moist: 0, geology: 0 },
    ocean: { elev: -0.5, temp: 0, moist: 0, geology: 0 },
    volcanic: { elev: 0.5, temp: 0.3, moist: 0, geology: 0.6 },
    deadzone: { elev: 0.2, temp: 0.3, moist: -0.5, geology: -0.5 },
    sand: { elev: 0.2, temp: 0.7, moist: -0.6, geology: 0 },
    swamp: { elev: 0.1, temp: 0.3, moist: 0.5, geology: 0 },
});
const vectors = { n: [0, -1], ne: [Math.SQRT1_2, -Math.SQRT1_2], e: [1, 0], se: [Math.SQRT1_2, Math.SQRT1_2],
    s: [0, 1], sw: [-Math.SQRT1_2, Math.SQRT1_2], w: [-1, 0], nw: [-Math.SQRT1_2, -Math.SQRT1_2] };
const REGION_RADIUS = 8;
export function placementFor(entry) {
    return entry.placement ?? (Number.isFinite(entry.placementPendingUntil) ? { preferredBiomes: [] } : null);
}
export function pendingPlacement(entry, now = Date.now()) {
    return !validCell(entry.coordinates) && Number.isFinite(entry.placementPendingUntil) && entry.placementPendingUntil > now;
}
function regionRadius(value) { return Number.isFinite(value) ? Math.max(3, Math.min(24, Math.round(value))) : REGION_RADIUS; }
function bearing(id) {
    let hash = 2166136261;
    for (const char of String(id)) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
    const angle = (hash >>> 0) / 4294967296 * Math.PI * 2;
    return [Math.cos(angle), Math.sin(angle)];
}
export function terrainTransects(ledger) {
    return ledger.filter(entry => validCell(entry.coordinates) && Object.hasOwn(BIOME_TARGETS, entry.terrainBiome)).map(entry => ({
        locationId: entry.id, source: 'Point of interest biome', noiseResumeDistance: regionRadius(entry.terrainRadius),
        coreRadius: Math.min(3, regionRadius(entry.terrainRadius) / 2), controlPoints: [{ kind: 'terrain', ...entry.coordinates, target: BIOME_TARGETS[entry.terrainBiome] }],
    }));
}
function knownCells(explored, generated, hardened) {
    const keys = new Set([...explored, ...generated]);
    for (const key of hardened.keys()) keys.add(key.replace('\u241f', ','));
    return keys;
}
function biomeAtCell(store, hardened, x, y) {
    return hardened.get(`${x}\u241f${y}`) ?? store.getCell(x, y)?.biome;
}
export function buildPlacementContext(snapshot, worldSize = FIELD_WORLD_SIZE) {
    const player = snapshot.party ?? snapshot.anchors.find(anchor => anchor.locationId === snapshot.locationId);
    const explored = snapshot.explored ?? new Set();
    const hardened = snapshot.hardened ?? new Map();
    let north = Infinity, south = -Infinity, west = Infinity, east = -Infinity;
    for (const key of explored) {
        const [x, y] = key.split(',').map(Number);
        north = Math.min(north, y); south = Math.max(south, y); west = Math.min(west, x); east = Math.max(east, x);
    }
    const samples = new Map();
    for (const key of knownCells(explored, snapshot.generated ?? new Set(), hardened)) {
        const [x, y] = key.split(',').map(Number);
        const biome = biomeAtCell(snapshot.chunkStore, hardened, x, y);
        const group = samples.get(biome) ?? [];
        const sample = { x, y, explored: explored.has(key) };
        group.push(sample);
        group.sort((a, b) => Math.hypot(a.x - (player?.x ?? 500), a.y - (player?.y ?? 500)) - Math.hypot(b.x - (player?.x ?? 500), b.y - (player?.y ?? 500)));
        if (group.length > 6) group.length = 6;
        samples.set(biome, group);
    }
    return { worldSize, player: player ? { x: player.x, y: player.y, placeId: snapshot.locationId,
        biome: biomeAtCell(snapshot.chunkStore, hardened, player.x, player.y) } : null,
        exploredCells: explored.size, fullyExplored: explored.size >= worldSize * worldSize,
        exploredBounds: explored.size ? { north, south, west, east } : null,
        exploredReach: player && explored.size ? { north: Math.max(0, player.y - north), south: Math.max(0, south - player.y),
            west: Math.max(0, player.x - west), east: Math.max(0, east - player.x) } : null,
        boundsAreNotCoverage: true, terrainSamples: [...samples].map(([biome, cells]) => ({ biome, cells })),
        knownPlaces: snapshot.anchors.filter(anchor => !anchor.hidden).slice(0, 80).map(anchor => ({ id: anchor.locationId, name: anchor.name, x: anchor.x, y: anchor.y })) };
}

export function resolvePlacements(ledger, { anchors = [], player, store, explored = new Set(), generated = new Set(), hardened = new Map(), bands, worldSize = FIELD_WORLD_SIZE }) {
    const occupied = new Map(anchors.filter(validCell).map(anchor => [anchor.locationId, { x: anchor.x, y: anchor.y }]));
    for (const entry of ledger) if (validCell(entry.coordinates)) occupied.set(entry.id, entry.coordinates);
    const known = knownCells(explored, generated, hardened);
    const inWorld = cell => validCell(cell) && cell.x < worldSize && cell.y < worldSize;
    let changed = false;
    const updates = new Map();
    for (const entry of [...ledger].sort((a, b) => a.id.localeCompare(b.id))) {
        const request = placementFor(entry);
        if (!request || validCell(entry.coordinates) || pendingPlacement(entry) || entry.kind === 'transit') continue;
        const preferred = (Array.isArray(request.preferredBiomes) ? request.preferredBiomes : []).filter(biome => Object.hasOwn(BIOME_TARGETS, biome)).slice(0, 4);
        const soft = request.biomePolicy === 'preferred';
        const radiusOfRegion = regionRadius(request.biomeRadius);
        const acceptable = biome => preferred.length && !soft ? preferred.includes(biome) : BIOME_IDS.includes(biome) && (biome !== 'ocean' || preferred.includes('ocean'));
        const matchesPreference = cell => preferred.includes(biomeAtCell(store, hardened, cell.x, cell.y));
        const reference = occupied.get(request.referencePlaceId) ?? player;
        const origin = inWorld(reference) ? reference : { x: Math.floor(worldSize / 2), y: Math.floor(worldSize / 2) };
        const band = bands.find(band => band.id === request.distanceBand);
        const min = band?.minGrids ?? 3, max = Math.min(band?.maxGrids ?? worldSize, Math.hypot(worldSize, worldSize));
        const direction = Object.hasOwn(vectors, request.direction) ? vectors[request.direction] : null;
        const within = cell => {
            const dx = cell.x - origin.x, dy = cell.y - origin.y, distance = Math.hypot(dx, dy);
            return inWorld(cell) && distance >= min && distance <= max
                && (!direction || distance === 0 || (dx * direction[0] + dy * direction[1]) / distance >= Math.cos(Math.PI / 8));
        };
        const free = cell => [...occupied.values()].every(other => other.x !== cell.x || other.y !== cell.y);
        const middle = band ? (min + Math.min(max, min + 60)) / 2 : Math.min(20, worldSize / 3);
        const heading = direction ?? bearing(entry.id);
        const desired = inWorld(request.coordinates) ? request.coordinates : {
            x: Math.max(0, Math.min(worldSize - 1, Math.round(origin.x + heading[0] * middle))),
            y: Math.max(0, Math.min(worldSize - 1, Math.round(origin.y + heading[1] * middle))) };
        const score = cell => Math.hypot(cell.x - desired.x, cell.y - desired.y) + (soft && preferred.length && !matchesPreference(cell) ? worldSize * 3 : 0);
        let chosen = null, relaxed = null;
        for (const key of known) {
            const [x, y] = key.split(',').map(Number), cell = { x, y };
            if (!inWorld(cell) || !free(cell) || !acceptable(biomeAtCell(store, hardened, x, y))) continue;
            if (within(cell) && (!chosen || score(cell) < score(chosen))) chosen = cell;
            if (!relaxed || score(cell) < score(relaxed)) relaxed = cell;
        }
        let terrainBiome;
        const canGenerate = cell => {
            if (!within(cell) || !free(cell) || cell.x < radiusOfRegion || cell.y < radiusOfRegion
                || cell.x + radiusOfRegion >= worldSize || cell.y + radiusOfRegion >= worldSize) return false;
            if ([...occupied].some(([id, other]) => {
                const existing = updates.get(id) ?? ledger.find(place => place.id === id);
                return Math.hypot(other.x - cell.x, other.y - cell.y) <= radiusOfRegion + regionRadius(existing?.terrainRadius);
            })) return false;
            for (const key of visibleCells(cell, radiusOfRegion)) {
                if (explored.has(key) || hardened.has(key.replace(',', '\u241f'))) return false;
            }
            return true;
        };
        if (!chosen && explored.size < worldSize * worldSize) {
            for (let radius = 0; radius <= Math.min(worldSize * 2, Math.ceil(max + Math.hypot(desired.x - origin.x, desired.y - origin.y))) && !chosen; radius++) {
                for (let dy = -radius; dy <= radius && !chosen; dy++) {
                    const dx = radius - Math.abs(dy);
                    for (const sign of dx === 0 ? [1] : [-1, 1]) {
                        const cell = { x: desired.x + dx * sign, y: desired.y + dy };
                        if (!within(cell) || !free(cell)) continue;
                        const compatible = acceptable(biomeAtCell(store, hardened, cell.x, cell.y))
                            && [...visibleCells(cell, 2)].every(key => {
                                const [x, y] = key.split(',').map(Number);
                                return acceptable(biomeAtCell(store, hardened, x, y));
                            });
                        if (compatible) { chosen = cell; break; }
                        if (!soft && canGenerate(cell)) { chosen = cell; terrainBiome = preferred[0] ?? 'plains'; break; }
                    }
                }
            }
        }
        let issue;
        if (!chosen && explored.size >= worldSize * worldSize && relaxed) {
            chosen = relaxed; issue = 'Map fully explored: used compatible terrain outside the requested distance or direction.';
        }
        if (!chosen) issue = 'No compatible site fits this placement without changing explored terrain or existing places.';
        const next = chosen ? { ...entry, placement: request, coordinates: chosen, terrainBiome, terrainRadius: terrainBiome ? radiusOfRegion : undefined, placementIssue: issue }
            : { ...entry, placement: request, placementIssue: issue };
        if (chosen) occupied.set(entry.id, chosen);
        if (chosen || entry.placementIssue !== issue || !entry.placement) { changed = true; updates.set(entry.id, next); }
    }
    return changed ? ledger.map(entry => updates.get(entry.id) ?? entry) : ledger;
}
