/**
 * World Map anchor grammar and deterministic constraint solver.
 *
 * This module deliberately has no imports. A bundled native mod is served as
 * a runtime asset and may not depend on host-internal `src/` paths. The band
 * rows below are therefore a runtime mirror of the public LocationConnection
 * vocabulary; the app test suite locks the mirror to the host table.
 */

export const WORLD_SIZE = 1000;

export const DISTANCE_BANDS = Object.freeze([
    Object.freeze({ id: 'adjacent', minGrids: 0, maxGrids: 0 }),
    Object.freeze({ id: 'nearby', minGrids: 1, maxGrids: 2 }),
    Object.freeze({ id: 'local', minGrids: 3, maxGrids: 6 }),
    Object.freeze({ id: 'regional', minGrids: 7, maxGrids: 15 }),
    Object.freeze({ id: 'far', minGrids: 16, maxGrids: 30 }),
    Object.freeze({ id: 'distant', minGrids: 31, maxGrids: 60 }),
    Object.freeze({ id: 'remote', minGrids: 61, maxGrids: 120 }),
    Object.freeze({ id: 'farthest', minGrids: 121, maxGrids: Infinity }),
]);

export const TERRAIN_VOCABULARY = Object.freeze({
    ocean: Object.freeze({ elev: -0.60 }),
    mountain: Object.freeze({ elev: 0.80, temp: -0.30 }),
    hills: Object.freeze({ elev: 0.30 }),
    plains: Object.freeze({ elev: 0.05 }),
    tundra: Object.freeze({ elev: 0.10, temp: -0.70, moist: -0.20 }),
    pasture: Object.freeze({ moist: 0.30 }),
    farmland: Object.freeze({ elev: 0.05, temp: 0.20, moist: 0.40 }),
});

export const SLOPE_VOCABULARY = Object.freeze({
    cliff: Object.freeze({ minDeltaElev: 0.5, maxCells: 2 }),
    drop: Object.freeze({ minDeltaElev: 0.5, maxCells: 2 }),
    steep: Object.freeze({ minDeltaElev: 0.5, maxCells: 4 }),
    rolling: Object.freeze({ maxDeltaElev: 0.2, cells: 4 }),
});

const GRAMMAR_DISTANCES = Object.freeze({
    '0': Object.freeze({ min: 0, max: 1, priority: 6, label: 'hard' }),
    close: Object.freeze({ min: 2, max: 5, priority: 5, label: 'firm' }),
    mid: Object.freeze({ min: 6, max: 15, priority: 4, label: 'soft' }),
    far: Object.freeze({ min: 16, max: 40, priority: 3, label: 'hint' }),
});

const ROAD_BANDS = Object.freeze({
    '0': 'adjacent',
    close: 'local',
    mid: 'regional',
    far: 'far',
});

const DIRECTION_VECTORS = Object.freeze({
    center: Object.freeze({ x: 0, y: 0 }),
    n: Object.freeze({ x: 0, y: -1 }),
    ne: Object.freeze({ x: Math.SQRT1_2, y: -Math.SQRT1_2 }),
    e: Object.freeze({ x: 1, y: 0 }),
    se: Object.freeze({ x: Math.SQRT1_2, y: Math.SQRT1_2 }),
    s: Object.freeze({ x: 0, y: 1 }),
    sw: Object.freeze({ x: -Math.SQRT1_2, y: Math.SQRT1_2 }),
    w: Object.freeze({ x: -1, y: 0 }),
    nw: Object.freeze({ x: -Math.SQRT1_2, y: -Math.SQRT1_2 }),
});

const DIRECTION_ALIASES = Object.freeze({
    n: 'n', north: 'n',
    ne: 'ne', northeast: 'ne', 'north-east': 'ne',
    e: 'e', east: 'e',
    se: 'se', southeast: 'se', 'south-east': 'se',
    s: 's', south: 's',
    sw: 'sw', southwest: 'sw', 'south-west': 'sw',
    w: 'w', west: 'w',
    nw: 'nw', northwest: 'nw', 'north-west': 'nw',
});

const EPSILON = 0.15;

function finiteNumber(value) {
    return typeof value === 'number' && Number.isFinite(value);
}

function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
}

function quantize(value, places = 6) {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

function canonical(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/[’']/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

function hash32(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    return hash >>> 0;
}

function seededUnit(seed, label) {
    return hash32(`${seed}\u241f${label}`) / 0x100000000;
}

function compareText(left, right) {
    const leftText = String(left);
    const rightText = String(right);
    if (leftText === rightText) return 0;
    return leftText < rightText ? -1 : 1;
}

function stableNodeCompare(left, right) {
    return compareText(canonical(left.name), canonical(right.name)) || compareText(left.id, right.id);
}

function vectorLength(x, y) {
    return Math.sqrt((x * x) + (y * y));
}

function distanceBetween(left, right) {
    return vectorLength(right.x - left.x, right.y - left.y);
}

function midpoint(min, max) {
    if (!Number.isFinite(max)) return min + 60;
    return (min + max) / 2;
}

function bandDefinition(rawBand) {
    const migrated = rawBand === 'short' || rawBand === undefined
        ? 'local'
        : rawBand === 'long'
            ? 'far'
            : rawBand;
    return DISTANCE_BANDS.find(entry => entry.id === migrated)
        ?? DISTANCE_BANDS.find(entry => entry.id === 'local');
}

function connectionRange(rawBand) {
    const band = bandDefinition(rawBand);
    if (band.id === 'adjacent') {
        // Distinct ledger entries must remain visible as distinct anchors.
        // One grid still satisfies the authored 0-grid relation.
        return { band: band.id, min: 0, max: 1 };
    }
    return { band: band.id, min: band.minGrids, max: band.maxGrids };
}

function makeWarning(message, input = {}) {
    return {
        kind: input.kind ?? 'warning',
        locationId: input.locationId ?? null,
        locationName: input.locationName ?? null,
        clause: input.clause ?? null,
        message,
    };
}

function parseDirection(raw) {
    return DIRECTION_ALIASES[String(raw).toLowerCase()] ?? null;
}

function grammarDistance(raw) {
    return GRAMMAR_DISTANCES[String(raw).toLowerCase()] ?? null;
}

function terrainTarget(name) {
    const value = TERRAIN_VOCABULARY[name];
    return {
        elev: value.elev ?? null,
        temp: value.temp ?? null,
        moist: value.moist ?? null,
    };
}

function mergeTerrainTargets(names) {
    const dimensions = ['elev', 'temp', 'moist'];
    const merged = {};
    for (const dimension of dimensions) {
        const values = names
            .map(name => TERRAIN_VOCABULARY[name][dimension])
            .filter(finiteNumber);
        merged[dimension] = values.length > 0
            ? quantize(values.reduce((sum, value) => sum + value, 0) / values.length)
            : null;
    }
    return merged;
}

/**
 * Compile terrain and derivative parts to a ray of relative control points.
 * A terrain/slope/terrain compound always produces at least three points.
 */
export function compileTransect(parts, direction, distanceBand) {
    const vector = DIRECTION_VECTORS[direction];
    const distance = grammarDistance(distanceBand);
    if (!vector || !distance) return [];

    let cursor = distanceBand === '0' ? 1 : midpoint(distance.min, distance.max);
    const points = [];
    for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index];
        if (part.kind === 'terrain') {
            points.push({
                kind: 'terrain',
                terrain: part.terrain,
                target: terrainTarget(part.terrain),
                distance: quantize(cursor),
                dx: quantize(vector.x * cursor),
                dy: quantize(vector.y * cursor),
            });
            const next = parts[index + 1];
            if (next?.kind === 'terrain') cursor += 1;
            continue;
        }

        const slope = SLOPE_VOCABULARY[part.slope];
        const span = slope.maxCells ?? slope.cells;
        cursor += span / 2;
        points.push({
            kind: 'slope',
            slope: part.slope,
            derivative: { ...slope },
            distance: quantize(cursor),
            dx: quantize(vector.x * cursor),
            dy: quantize(vector.y * cursor),
        });
        cursor += span / 2;
    }
    return points;
}

/**
 * Parse one `Neighbors` segment. Unknown field tokens invalidate the segment;
 * road targets remain arbitrary place names and are resolved separately.
 */
export function parseNeighborClause(rawClause, context = {}) {
    const source = String(rawClause ?? '').trim();
    const warnings = [];
    const match = source.match(/^(north-east|north-west|south-east|south-west|northeast|northwest|southeast|southwest|ne|nw|se|sw|north|south|east|west|n|s|e|w)\s*:?\s+(.+)$/i);
    if (!match) {
        warnings.push(makeWarning(`unreadable neighbor clause "${source}" — clause dropped`, {
            ...context,
            kind: 'invalid-clause',
            clause: source,
        }));
        return { clause: null, warnings };
    }

    const direction = parseDirection(match[1]);
    const bodyMatch = match[2].trim().match(/^(.*?)\s*,?\s*(?:distance\s+)?(0|close|mid|far)$/i);
    if (!bodyMatch) {
        warnings.push(makeWarning(`neighbor clause "${source}" has no known distance band — clause dropped`, {
            ...context,
            kind: 'invalid-distance',
            clause: source,
        }));
        return { clause: null, warnings };
    }

    const expression = bodyMatch[1].trim();
    const distance = bodyMatch[2].toLowerCase();
    const priority = grammarDistance(distance).priority;
    const roadMatch = expression.match(/^road(?:\s+to\s+(.+?))?$/i);
    if (roadMatch) {
        const targetRaw = roadMatch[1]?.trim() ?? '';
        const targetName = !targetRaw || canonical(targetRaw) === 'unknown' ? null : targetRaw;
        return {
            clause: {
                kind: 'road',
                direction,
                directionVector: { ...DIRECTION_VECTORS[direction] },
                targetName,
                distance,
                band: ROAD_BANDS[distance],
                priority,
                hard: distance === '0',
                source,
                locationId: context.locationId ?? null,
                locationName: context.locationName ?? null,
            },
            warnings,
        };
    }

    const tokens = expression
        .toLowerCase()
        .replace(/-to-/g, ' to ')
        .replace(/-/g, ' ')
        .split(/\s+/)
        .filter(Boolean);
    const parts = [];
    for (const token of tokens) {
        if (token === 'to') continue;
        if (Object.hasOwn(TERRAIN_VOCABULARY, token)) {
            parts.push({ kind: 'terrain', terrain: token });
        } else if (Object.hasOwn(SLOPE_VOCABULARY, token)) {
            parts.push({ kind: 'slope', slope: token });
        } else {
            warnings.push(makeWarning(`unknown terrain token "${token}" — clause dropped`, {
                ...context,
                kind: 'unknown-token',
                clause: source,
            }));
            return { clause: null, warnings };
        }
    }

    if (!parts.some(part => part.kind === 'terrain')) {
        warnings.push(makeWarning(`neighbor clause "${source}" has no terrain target — clause dropped`, {
            ...context,
            kind: 'missing-terrain',
            clause: source,
        }));
        return { clause: null, warnings };
    }

    return {
        clause: {
            kind: 'transect',
            direction,
            directionVector: { ...DIRECTION_VECTORS[direction] },
            distance,
            priority,
            hard: distance === '0',
            parts,
            controlPoints: compileTransect(parts, direction, distance),
            noiseResumeDistance: Math.max(5, Math.ceil(Math.max(
                ...compileTransect(parts, direction, distance).map(point => point.distance),
            ) + 3)),
            source,
            locationId: context.locationId ?? null,
            locationName: context.locationName ?? null,
        },
        warnings,
    };
}

export function parseLocationHeaderName(header) {
    let name = String(header ?? '').replace(/\[CHUNK:\s*[A-Z_]+[—\-\s]*\]/i, '').trim();
    const doubleDash = name.match(/^[A-Z][A-Z_\s]*--\s*(.+)/);
    if (doubleDash) {
        name = doubleDash[1].trim();
    } else {
        const emDash = name.match(/^[A-Z][A-Z_\s]*[—–]\s*(.+)/);
        if (emDash) name = emDash[1].trim();
    }
    const parenthetical = name.match(/^(.*?)\s*\(([^()]+)\)\s*$/);
    return parenthetical
        ? { name: parenthetical[1].trim(), broadLocation: parenthetical[2].trim() }
        : { name, broadLocation: '' };
}

function bulletValues(content, acceptedFields) {
    const wanted = new Set(acceptedFields.map(field => canonical(field)));
    const lines = String(content ?? '').split(/\r?\n/);
    const values = [];
    for (let index = 0; index < lines.length; index += 1) {
        const match = lines[index].match(/^\s*\*\*([^*]+):\*\*\s*(.*)$/);
        if (!match || !wanted.has(canonical(match[1]))) continue;
        let value = match[2].trim();
        let next = index + 1;
        while (next < lines.length && /^\s*\|/.test(lines[next])) {
            value += ` ${lines[next].trim()}`;
            next += 1;
        }
        values.push(value.trim());
        index = next - 1;
    }
    return values;
}

function parseList(raw) {
    return String(raw ?? '')
        .replace(/[\[\]]/g, '')
        .split(/[,;|]|\s{2,}/)
        .map(value => value.trim())
        .filter(Boolean);
}

function locationLookup(locations) {
    const lookup = new Map();
    for (const location of locations) {
        const candidates = [location.name, ...(String(location.aliases ?? '').split(','))];
        for (const candidate of candidates) {
            const key = canonical(candidate);
            if (key && !lookup.has(key)) lookup.set(key, location);
        }
    }
    return lookup;
}

function centralTerrainClause(raw, context) {
    const warnings = [];
    const known = [];
    for (const token of String(raw ?? '').toLowerCase().split(/[,;|\s]+/).filter(Boolean)) {
        if (Object.hasOwn(TERRAIN_VOCABULARY, token)) {
            known.push(token);
        } else {
            warnings.push(makeWarning(`unknown terrain token "${token}" — token dropped`, {
                ...context,
                kind: 'unknown-token',
                clause: `Terrain: ${raw}`,
            }));
        }
    }
    if (known.length === 0) return { clause: null, warnings };
    return {
        clause: {
            kind: 'transect',
            direction: 'center',
            directionVector: { x: 0, y: 0 },
            distance: '0',
            priority: 6,
            hard: true,
            parts: known.map(terrain => ({ kind: 'terrain', terrain })),
            controlPoints: [{
                kind: 'terrain',
                terrain: known.join('+'),
                terrains: known,
                target: mergeTerrainTargets(known),
                distance: 0,
                dx: 0,
                dy: 0,
            }],
            noiseResumeDistance: 5,
            source: `Terrain: ${raw}`,
            locationId: context.locationId,
            locationName: context.locationName,
        },
        warnings,
    };
}

/** Parse all WorldMap-owned lore bullets without touching the core parser. */
export function parseLoreConstraints(locationsInput, loreChunksInput) {
    const locations = Array.isArray(locationsInput) ? locationsInput : [];
    const loreChunks = Array.isArray(loreChunksInput) ? loreChunksInput : [];
    const byName = locationLookup(locations);
    const clauses = [];
    const pins = [];
    const connectedTo = [];
    const warnings = [];
    const seenChunks = new Set();

    for (const chunk of loreChunks) {
        if (!chunk || (chunk.category && chunk.category !== 'location')) continue;
        const headerName = parseLocationHeaderName(chunk.header).name;
        const location = byName.get(canonical(headerName));
        if (!location) continue;
        const chunkKey = `${location.id}\u241f${String(chunk.content ?? '')}`;
        if (seenChunks.has(chunkKey)) continue;
        seenChunks.add(chunkKey);
        const context = { locationId: location.id, locationName: location.name };

        for (const raw of bulletValues(chunk.content, ['Terrain'])) {
            const parsed = centralTerrainClause(raw, context);
            warnings.push(...parsed.warnings);
            if (parsed.clause) clauses.push(parsed.clause);
        }

        for (const raw of bulletValues(chunk.content, ['Neighbors', 'Neighbours'])) {
            for (const segment of raw.split('|').map(value => value.trim()).filter(Boolean)) {
                const parsed = parseNeighborClause(segment, context);
                warnings.push(...parsed.warnings);
                if (parsed.clause) clauses.push(parsed.clause);
            }
        }

        for (const raw of bulletValues(chunk.content, ['Coords', 'Coordinates'])) {
            const match = raw.match(/^\s*(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*$/);
            if (!match) {
                warnings.push(makeWarning(`invalid coordinates "${raw}" — pin dropped`, {
                    ...context,
                    kind: 'invalid-coordinates',
                    clause: `Coords: ${raw}`,
                }));
                continue;
            }
            pins.push({
                id: `coords:${location.id}:${pins.length}`,
                locationId: location.id,
                locationName: location.name,
                x: Number(match[1]),
                y: Number(match[2]),
                source: 'Coords',
                description: `${location.name} is pinned at ${match[1]},${match[2]}`,
            });
        }

        for (const raw of bulletValues(chunk.content, ['ConnectedTo', 'Connected To', 'Connections'])) {
            for (const targetName of parseList(raw)) {
                connectedTo.push({
                    fromId: location.id,
                    fromName: location.name,
                    targetName,
                    source: `ConnectedTo: ${targetName}`,
                });
            }
        }
    }

    clauses.sort((left, right) =>
        stableNodeCompare({ id: left.locationId, name: left.locationName }, { id: right.locationId, name: right.locationName })
        || compareText(left.source, right.source));
    return { clauses, pins, connectedTo, warnings };
}

function sanitizeLocations(input, warnings) {
    const locations = [];
    const seen = new Set();
    for (const raw of Array.isArray(input) ? input : []) {
        if (!raw || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.id || !raw.name.trim()) {
            warnings.push(makeWarning('malformed Location Ledger row — row dropped', { kind: 'invalid-location' }));
            continue;
        }
        if (seen.has(raw.id)) {
            warnings.push(makeWarning(`duplicate location id "${raw.id}" — later row dropped`, {
                kind: 'duplicate-location', locationId: raw.id, locationName: raw.name,
            }));
            continue;
        }
        seen.add(raw.id);
        locations.push({
            id: raw.id,
            name: raw.name.trim(),
            aliases: String(raw.aliases ?? ''),
            connections: Array.isArray(raw.connections) ? raw.connections : [],
        });
    }
    return locations.sort(stableNodeCompare);
}

function pairKey(leftId, rightId) {
    return compareText(leftId, rightId) <= 0 ? `${leftId}\u241f${rightId}` : `${rightId}\u241f${leftId}`;
}

function buildDistanceConstraints(locations, lore, warnings) {
    const ids = new Set(locations.map(location => location.id));
    const byName = locationLookup(locations);
    const constraints = [];
    const seen = new Set();

    const addConstraint = constraint => {
        const directed = constraint.direction ? `${constraint.fromId}>${constraint.toId}` : pairKey(constraint.fromId, constraint.toId);
        const key = `${directed}\u241f${constraint.band}\u241f${constraint.sourceKind}`;
        if (seen.has(key)) return;
        seen.add(key);
        constraints.push({ ...constraint, id: `distance:${key}` });
    };

    for (const location of locations) {
        for (const connection of location.connections) {
            if (!connection || typeof connection.toId !== 'string' || !ids.has(connection.toId) || connection.toId === location.id) {
                if (connection?.toId && !ids.has(connection.toId)) {
                    warnings.push(makeWarning(`${location.name} has a connection to missing location "${connection.toId}" — connection dropped`, {
                        kind: 'missing-connection', locationId: location.id, locationName: location.name,
                    }));
                }
                continue;
            }
            const range = connectionRange(connection.band);
            const target = locations.find(candidate => candidate.id === connection.toId);
            addConstraint({
                kind: 'distance',
                fromId: location.id,
                toId: target.id,
                locationIds: [location.id, target.id],
                locationNames: [location.name, target.name],
                min: range.min,
                max: range.max,
                band: range.band,
                priority: 4,
                hard: false,
                sourceKind: 'ledger',
                source: `${location.name} → ${target.name} is ${range.band}`,
            });
        }
    }

    for (const connection of lore.connectedTo) {
        const target = byName.get(canonical(connection.targetName));
        if (!target || target.id === connection.fromId) {
            warnings.push(makeWarning(`${connection.fromName} names unknown connection "${connection.targetName}" — connection dropped`, {
                kind: 'unknown-place', locationId: connection.fromId, locationName: connection.fromName,
                clause: connection.source,
            }));
            continue;
        }
        const from = locations.find(location => location.id === connection.fromId);
        const range = connectionRange('local');
        addConstraint({
            kind: 'distance',
            fromId: from.id,
            toId: target.id,
            locationIds: [from.id, target.id],
            locationNames: [from.name, target.name],
            min: range.min,
            max: range.max,
            band: range.band,
            priority: 4,
            hard: false,
            sourceKind: 'lore-connection',
            source: `${from.name} → ${target.name} is ${range.band}`,
        });
    }

    for (const clause of lore.clauses.filter(candidate => candidate.kind === 'road')) {
        if (!clause.targetName) {
            warnings.push(makeWarning(`${clause.source} names no road destination — connection deferred`, {
                kind: 'unknown-place', locationId: clause.locationId, locationName: clause.locationName,
                clause: clause.source,
            }));
            continue;
        }
        const target = byName.get(canonical(clause.targetName));
        if (!target || target.id === clause.locationId) {
            warnings.push(makeWarning(`${clause.source} names unknown place "${clause.targetName}" — connection dropped`, {
                kind: 'unknown-place', locationId: clause.locationId, locationName: clause.locationName,
                clause: clause.source,
            }));
            continue;
        }
        const from = locations.find(location => location.id === clause.locationId);
        const range = connectionRange(clause.band);
        addConstraint({
            kind: 'distance',
            fromId: from.id,
            toId: target.id,
            locationIds: [from.id, target.id],
            locationNames: [from.name, target.name],
            min: range.min,
            max: range.max,
            band: range.band,
            direction: clause.direction,
            directionVector: clause.directionVector,
            priority: clause.priority,
            hard: clause.hard,
            sourceKind: 'road',
            source: clause.source,
            clause,
        });
    }

    return constraints.sort((left, right) => compareText(left.id, right.id));
}

function collectPins(locations, existingAnchors, lorePins, warnings, refusals) {
    const byId = new Map(locations.map(location => [location.id, location]));
    const candidates = [];
    for (const anchor of Array.isArray(existingAnchors) ? existingAnchors : []) {
        if (!anchor || anchor.source !== 'player' || anchor.pinned !== true) continue;
        if (!byId.has(anchor.locationId) || !finiteNumber(anchor.x) || !finiteNumber(anchor.y)) {
            warnings.push(makeWarning('malformed player anchor — pin dropped', {
                kind: 'invalid-pin', locationId: anchor?.locationId ?? null,
            }));
            continue;
        }
        const location = byId.get(anchor.locationId);
        candidates.push({
            id: `player:${location.id}`,
            locationId: location.id,
            locationName: location.name,
            x: anchor.x,
            y: anchor.y,
            source: 'player',
            description: `${location.name} player pin at ${anchor.x},${anchor.y}`,
            order: 0,
        });
    }
    for (const pin of lorePins) candidates.push({ ...pin, order: 1 });
    candidates.sort((left, right) =>
        stableNodeCompare({ id: left.locationId, name: left.locationName }, { id: right.locationId, name: right.locationName })
        || left.order - right.order
        || compareText(left.id, right.id));

    const pins = new Map();
    for (const candidate of candidates) {
        const current = pins.get(candidate.locationId);
        if (!current) {
            pins.set(candidate.locationId, candidate);
            continue;
        }
        if (current.x === candidate.x && current.y === candidate.y) continue;
        refusals.push({
            kind: 'hard-conflict',
            locationIds: [candidate.locationId],
            constraintIds: [current.id, candidate.id],
            message: `${candidate.locationName} has conflicting hard pins (${current.x},${current.y}) and (${candidate.x},${candidate.y}). Keeping the existing pin; accept it, or remove one Coords value.`,
        });
    }
    return pins;
}

function constraintStrength(priority) {
    if (priority >= 6) return 0.34;
    if (priority === 5) return 0.24;
    if (priority === 4) return 0.16;
    return 0.08;
}

function initialPositions(locations, pins, fieldClauses, worldSeed) {
    const positions = new Map();
    const rotation = seededUnit(worldSeed, 'base-rotation') * Math.PI * 2;
    const goldenAngle = Math.PI * (3 - Math.sqrt(5));
    for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        const pin = pins.get(location.id);
        if (pin) {
            positions.set(location.id, { x: pin.x, y: pin.y });
            continue;
        }
        const radius = index === 0 ? 0 : 13 * Math.sqrt(index);
        const jitter = (seededUnit(worldSeed, `node:${canonical(location.name)}`) - 0.5) * 0.36;
        const angle = rotation + (index * goldenAngle) + jitter;
        let x = (WORLD_SIZE / 2) + (Math.cos(angle) * radius);
        let y = (WORLD_SIZE / 2) + (Math.sin(angle) * radius);

        // A transect is attached to its anchor, but it still needs to affect
        // the placement solve. Shift the anchor opposite the authored ray so
        // the control points occupy the requested side of the base layout.
        const ownClauses = fieldClauses.filter(clause => clause.locationId === location.id && clause.direction !== 'center');
        for (const clause of ownClauses) {
            const weight = clause.priority >= 6 ? 5 : clause.priority === 5 ? 4 : clause.priority === 4 ? 3 : 2;
            x -= clause.directionVector.x * weight;
            y -= clause.directionVector.y * weight;
        }
        positions.set(location.id, { x: quantize(x), y: quantize(y) });
    }
    return positions;
}

function deterministicUnit(worldSeed, leftId, rightId) {
    const angle = seededUnit(worldSeed, pairKey(leftId, rightId)) * Math.PI * 2;
    return { x: Math.cos(angle), y: Math.sin(angle) };
}

function addDelta(deltas, id, x, y) {
    const delta = deltas.get(id);
    delta.x += x;
    delta.y += y;
}

function applyConstraintDelta(constraint, positions, pins, deltas, worldSeed) {
    const from = positions.get(constraint.fromId);
    const to = positions.get(constraint.toId);
    if (!from || !to) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = vectorLength(dx, dy);
    const unit = length > 0.000001 ? { x: dx / length, y: dy / length } : deterministicUnit(worldSeed, constraint.fromId, constraint.toId);
    const targetDistance = length < constraint.min
        ? constraint.min
        : length > constraint.max
            ? (Number.isFinite(constraint.max) ? constraint.max : constraint.min)
            : length;
    const strength = constraintStrength(constraint.priority);

    let errorX;
    let errorY;
    if (constraint.directionVector) {
        const desiredDistance = midpoint(constraint.min, constraint.max);
        errorX = dx - (constraint.directionVector.x * desiredDistance);
        errorY = dy - (constraint.directionVector.y * desiredDistance);
    } else {
        const radialError = length - targetDistance;
        if (Math.abs(radialError) < 0.000001) return;
        errorX = unit.x * radialError;
        errorY = unit.y * radialError;
    }

    const fromPinned = pins.has(constraint.fromId);
    const toPinned = pins.has(constraint.toId);
    if (fromPinned && toPinned) return;
    if (fromPinned) {
        addDelta(deltas, constraint.toId, -errorX * strength, -errorY * strength);
    } else if (toPinned) {
        addDelta(deltas, constraint.fromId, errorX * strength, errorY * strength);
    } else {
        addDelta(deltas, constraint.fromId, errorX * strength * 0.5, errorY * strength * 0.5);
        addDelta(deltas, constraint.toId, -errorX * strength * 0.5, -errorY * strength * 0.5);
    }
}

function projectConstraint(constraint, positions, pins, worldSeed) {
    const from = positions.get(constraint.fromId);
    const to = positions.get(constraint.toId);
    if (!from || !to || (pins.has(constraint.fromId) && pins.has(constraint.toId))) return;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = vectorLength(dx, dy);
    const unit = length > 0.000001 ? { x: dx / length, y: dy / length } : deterministicUnit(worldSeed, constraint.fromId, constraint.toId);
    const desiredDistance = constraint.directionVector
        ? midpoint(constraint.min, constraint.max)
        : length < constraint.min
            ? constraint.min
            : length > constraint.max
                ? (Number.isFinite(constraint.max) ? constraint.max : constraint.min)
                : length;
    const desiredX = constraint.directionVector ? constraint.directionVector.x * desiredDistance : unit.x * desiredDistance;
    const desiredY = constraint.directionVector ? constraint.directionVector.y * desiredDistance : unit.y * desiredDistance;
    const errorX = dx - desiredX;
    const errorY = dy - desiredY;
    if (Math.abs(errorX) + Math.abs(errorY) < 0.000001) return;

    if (pins.has(constraint.fromId)) {
        to.x = quantize(to.x - errorX);
        to.y = quantize(to.y - errorY);
    } else if (pins.has(constraint.toId)) {
        from.x = quantize(from.x + errorX);
        from.y = quantize(from.y + errorY);
    } else {
        from.x = quantize(from.x + (errorX * 0.5));
        from.y = quantize(from.y + (errorY * 0.5));
        to.x = quantize(to.x - (errorX * 0.5));
        to.y = quantize(to.y - (errorY * 0.5));
    }
}

function runLayout(locations, pins, constraints, fieldClauses, worldSeed) {
    const positions = initialPositions(locations, pins, fieldClauses, worldSeed);
    const iterations = Math.min(900, 520 + (locations.length * 12));
    for (let iteration = 0; iteration < iterations; iteration += 1) {
        const deltas = new Map(locations.map(location => [location.id, { x: 0, y: 0 }]));
        for (let leftIndex = 0; leftIndex < locations.length; leftIndex += 1) {
            const left = locations[leftIndex];
            const leftPosition = positions.get(left.id);
            if (!pins.has(left.id)) {
                addDelta(deltas, left.id,
                    ((WORLD_SIZE / 2) - leftPosition.x) * 0.00035,
                    ((WORLD_SIZE / 2) - leftPosition.y) * 0.00035);
            }
            for (let rightIndex = leftIndex + 1; rightIndex < locations.length; rightIndex += 1) {
                const right = locations[rightIndex];
                const rightPosition = positions.get(right.id);
                const dx = rightPosition.x - leftPosition.x;
                const dy = rightPosition.y - leftPosition.y;
                const length = vectorLength(dx, dy);
                if (length >= 5.5) continue;
                const unit = length > 0.000001 ? { x: dx / length, y: dy / length } : deterministicUnit(worldSeed, left.id, right.id);
                const amount = (5.5 - length) * 0.055;
                if (!pins.has(left.id)) addDelta(deltas, left.id, -unit.x * amount, -unit.y * amount);
                if (!pins.has(right.id)) addDelta(deltas, right.id, unit.x * amount, unit.y * amount);
            }
        }
        for (const constraint of constraints) applyConstraintDelta(constraint, positions, pins, deltas, worldSeed);

        for (const location of locations) {
            const pin = pins.get(location.id);
            const position = positions.get(location.id);
            if (pin) {
                position.x = pin.x;
                position.y = pin.y;
                continue;
            }
            const delta = deltas.get(location.id);
            const magnitude = vectorLength(delta.x, delta.y);
            const scale = magnitude > 3.5 ? 3.5 / magnitude : 1;
            position.x = quantize(clamp(position.x + (delta.x * scale), 0, WORLD_SIZE - 1));
            position.y = quantize(clamp(position.y + (delta.y * scale), 0, WORLD_SIZE - 1));
        }
    }

    // Projection gives range springs an exact final pass. Lower-priority
    // constraints are projected first so hard/firm constraints have last say.
    const projectionOrder = [...constraints].sort((left, right) => left.priority - right.priority || compareText(left.id, right.id));
    for (let pass = 0; pass < 140; pass += 1) {
        for (const constraint of projectionOrder) projectConstraint(constraint, positions, pins, worldSeed);
        for (const pin of pins.values()) positions.set(pin.locationId, { x: pin.x, y: pin.y });
    }
    return positions;
}

function directionSatisfied(constraint, from, to) {
    if (!constraint.directionVector) return true;
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = vectorLength(dx, dy);
    if (length < 0.000001) return false;
    const alignment = ((dx / length) * constraint.directionVector.x) + ((dy / length) * constraint.directionVector.y);
    return alignment >= 0.86;
}

function distanceConstraintSatisfied(constraint, positions) {
    const from = positions.get(constraint.fromId);
    const to = positions.get(constraint.toId);
    if (!from || !to) return false;
    const distance = distanceBetween(from, to);
    return distance + EPSILON >= constraint.min
        && (!Number.isFinite(constraint.max) || distance - EPSILON <= constraint.max)
        && directionSatisfied(constraint, from, to);
}

function conflictMessage(constraint, positions, suffix) {
    const from = positions.get(constraint.fromId);
    const to = positions.get(constraint.toId);
    const grids = from && to ? Math.round(distanceBetween(from, to) * 10) / 10 : '?';
    const names = constraint.locationNames.join('/');
    return `${names} "${constraint.source}" ${suffix} at ${grids} grids`;
}

function relaxDistanceConstraints(locations, pins, constraintsInput, fieldClauses, worldSeed, relaxations, refusals) {
    const active = [...constraintsInput];
    let positions = runLayout(locations, pins, active, fieldClauses, worldSeed);
    let guard = constraintsInput.length + 2;
    while (guard > 0) {
        guard -= 1;
        const violations = active
            .filter(constraint => !distanceConstraintSatisfied(constraint, positions))
            .sort((left, right) => left.priority - right.priority || compareText(left.id, right.id));
        if (violations.length === 0) break;
        const constraint = violations[0];
        const index = active.findIndex(candidate => candidate.id === constraint.id);
        active.splice(index, 1);
        if (constraint.hard) {
            refusals.push({
                kind: 'hard-conflict',
                locationIds: constraint.locationIds,
                constraintIds: [constraint.id, ...constraint.locationIds.filter(id => pins.has(id)).map(id => pins.get(id).id)],
                message: `${conflictMessage(constraint, positions, 'conflicts with hard placement')}. Accept it, or re-describe one?`,
            });
        } else {
            relaxations.push({
                kind: 'relaxed',
                locationIds: constraint.locationIds,
                constraintId: constraint.id,
                message: `${conflictMessage(constraint, positions, 'relaxed')} — a higher-priority constraint wins`,
            });
        }
        positions = runLayout(locations, pins, active, fieldClauses, worldSeed);
    }
    return { active, positions };
}

function targetsConflict(left, right) {
    const dimensions = ['elev', 'temp', 'moist'];
    return dimensions.some(dimension =>
        finiteNumber(left[dimension])
        && finiteNumber(right[dimension])
        && Math.abs(left[dimension] - right[dimension]) > 0.5);
}

function absoluteControlPoint(clause, point, positions) {
    const anchor = positions.get(clause.locationId);
    return anchor ? { ...point, x: quantize(anchor.x + point.dx), y: quantize(anchor.y + point.dy) } : null;
}

function resolveFieldConflicts(fieldClausesInput, positions, relaxations, refusals) {
    const active = new Set(fieldClausesInput.map((_, index) => index));
    for (let leftIndex = 0; leftIndex < fieldClausesInput.length; leftIndex += 1) {
        if (!active.has(leftIndex)) continue;
        const left = fieldClausesInput[leftIndex];
        for (let rightIndex = leftIndex + 1; rightIndex < fieldClausesInput.length; rightIndex += 1) {
            if (!active.has(rightIndex)) continue;
            const right = fieldClausesInput[rightIndex];
            let conflictDistance = null;
            for (const leftPoint of left.controlPoints.filter(point => point.kind === 'terrain')) {
                const absoluteLeft = absoluteControlPoint(left, leftPoint, positions);
                for (const rightPoint of right.controlPoints.filter(point => point.kind === 'terrain')) {
                    const absoluteRight = absoluteControlPoint(right, rightPoint, positions);
                    if (!absoluteLeft || !absoluteRight || !targetsConflict(leftPoint.target, rightPoint.target)) continue;
                    const separation = distanceBetween(absoluteLeft, absoluteRight);
                    if (separation <= 0.75) conflictDistance = separation;
                }
            }
            if (conflictDistance === null) continue;

            if (left.hard && right.hard) {
                active.delete(leftIndex);
                active.delete(rightIndex);
                refusals.push({
                    kind: 'hard-conflict',
                    locationIds: [...new Set([left.locationId, right.locationId])],
                    constraintIds: [`field:${leftIndex}`, `field:${rightIndex}`],
                    message: `${left.locationName}/${right.locationName} require incompatible hard terrain in the same cell ("${left.source}" versus "${right.source}"). Accept one, or re-describe one?`,
                });
                break;
            }

            const dropLeft = left.priority < right.priority
                || (left.priority === right.priority && compareText(left.source, right.source) > 0);
            const droppedIndex = dropLeft ? leftIndex : rightIndex;
            const kept = dropLeft ? right : left;
            const dropped = dropLeft ? left : right;
            active.delete(droppedIndex);
            relaxations.push({
                kind: 'relaxed',
                locationIds: [...new Set([dropped.locationId, kept.locationId])],
                constraintId: `field:${droppedIndex}`,
                message: `"${dropped.source}" relaxed — conflicts with "${kept.source}" (${quantize(conflictDistance, 1)} cells)`,
            });
        }
    }
    return fieldClausesInput.filter((_, index) => active.has(index));
}

function resolveRoundedCollisions(locations, pins, positions, refusals) {
    const occupied = new Map();
    for (let index = 0; index < locations.length; index += 1) {
        const location = locations[index];
        const position = positions.get(location.id);
        position.x = pins.has(location.id) ? position.x : quantize(position.x, 3);
        position.y = pins.has(location.id) ? position.y : quantize(position.y, 3);
        let key = `${position.x},${position.y}`;
        const collision = occupied.get(key);
        if (!collision) {
            occupied.set(key, location);
            continue;
        }
        if (pins.has(location.id) && pins.has(collision.id)) {
            refusals.push({
                kind: 'hard-conflict',
                locationIds: [collision.id, location.id],
                constraintIds: [pins.get(collision.id).id, pins.get(location.id).id],
                message: `${collision.name}/${location.name} have hard pins at the same coordinate (${key}). Move one pin?`,
            });
            continue;
        }
        const movable = pins.has(location.id) ? collision : location;
        const movablePosition = positions.get(movable.id);
        let step = 1;
        do {
            const unit = deterministicUnit('collision', movable.id, `${index}:${step}`);
            movablePosition.x = quantize(movablePosition.x + (unit.x * 0.01 * step), 3);
            movablePosition.y = quantize(movablePosition.y + (unit.y * 0.01 * step), 3);
            key = `${movablePosition.x},${movablePosition.y}`;
            step += 1;
        } while (occupied.has(key) && step < 100);
        // If the current row is pinned, it takes ownership of the original
        // coordinate while the earlier unpinned row moves away.
        if (movable === collision) {
            occupied.set(`${position.x},${position.y}`, location);
        }
        occupied.set(key, movable);
    }
}

function buildTransects(fieldClauses, positions) {
    return fieldClauses.map((clause, index) => ({
        id: `transect:${clause.locationId}:${index}`,
        locationId: clause.locationId,
        locationName: clause.locationName,
        direction: clause.direction,
        distance: clause.distance,
        priority: clause.priority,
        hard: clause.hard,
        source: clause.source,
        noiseResumeDistance: clause.noiseResumeDistance,
        controlPoints: clause.controlPoints
            .map(point => absoluteControlPoint(clause, point, positions))
            .filter(Boolean),
    }));
}

function buildReport(locations, activeDistanceConstraints, activeFieldClauses, warnings, relaxations, refusals, positions) {
    const entries = locations.map(location => {
        const constraints = [
            ...activeDistanceConstraints.filter(constraint => constraint.locationIds.includes(location.id)),
            ...activeFieldClauses.filter(clause => clause.locationId === location.id),
        ];
        const ownWarnings = warnings.filter(warning => warning.locationId === location.id);
        const ownRelaxations = relaxations.filter(relaxation => relaxation.locationIds.includes(location.id));
        const ownRefusals = refusals.filter(refusal => refusal.locationIds.includes(location.id));
        return {
            locationId: location.id,
            name: location.name,
            x: positions.get(location.id).x,
            y: positions.get(location.id).y,
            satisfied: constraints.length,
            total: constraints.length + ownRelaxations.length + ownRefusals.length,
            warnings: ownWarnings.map(item => item.message),
            relaxations: ownRelaxations.map(item => item.message),
            refusals: ownRefusals.map(item => item.message),
        };
    });

    const lines = [`${locations.length} anchors placed.`];
    for (const entry of entries) {
        const details = [...entry.relaxations, ...entry.warnings];
        if (details.length > 0) {
            lines.push(`⚠ ${entry.name.padEnd(20)} ${details.join('; ')}`);
        } else if (entry.refusals.length === 0) {
            lines.push(`✓ ${entry.name.padEnd(20)} ${entry.satisfied}/${entry.total} clauses satisfied`);
        }
    }
    for (const refusal of refusals) lines.push(`✗ ${refusal.message}`);

    return {
        placed: locations.length,
        entries,
        warnings,
        relaxations,
        refusals,
        text: lines.join('\n'),
    };
}

/**
 * Drop field clauses whose terrain control points fall on a hardened cell.
 * A hardened cell is one the party has occupied; it is frozen and no future
 * anchor may alter it (WORKORDER 5 §4). The classifier still runs off the
 * Whittaker table, so dropping a clause here means the noise wins outright
 * at that cell — which is exactly what "frozen" means.
 *
 * Returns the filtered clauses and pushes a relaxation per dropped clause.
 */
function applyHardenedCells(fieldClauses, positions, hardened, relaxations) {
    if (!hardened || hardened.size === 0) return fieldClauses;
    const isHardened = (x, y) => hardened.has(`${x >> 0}\u241f${y >> 0}`);
    return fieldClauses.filter(clause => {
        for (const point of clause.controlPoints) {
            if (point.kind !== 'terrain') continue;
            const absolute = absoluteControlPoint(clause, point, positions);
            if (!absolute) continue;
            if (isHardened(absolute.x, absolute.y)) {
                relaxations.push({
                    kind: 'relaxed',
                    locationIds: [clause.locationId],
                    constraintId: `field-hardened:${clause.locationId}:${point.distance}`,
                    message: `"${clause.source}" relaxed — target cell (${absolute.x >> 0},${absolute.y >> 0}) is hardened`,
                });
                return false;
            }
        }
        return true;
    });
}

/**
 * Solve every known ledger location. Lower priorities are removed first;
 * hard conflicts are returned as refusals and are never silently discarded.
 *
 * `hardenedCells` is an optional Map of `"x,y"` → biome for cells the party
 * has occupied. They are priority-1 hard constraints: no field clause may
 * alter them (WORKORDER 5 §4).
 */
export function solveWorldMap(input = {}) {
    const warnings = [];
    const relaxations = [];
    const refusals = [];
    const locations = sanitizeLocations(input.locations, warnings);
    const worldSeed = String(input.worldSeed ?? 'worldmap-default-seed');
    const hardened = input.hardenedCells instanceof Map ? input.hardenedCells : new Map();
    const lore = parseLoreConstraints(locations, input.loreChunks);
    warnings.push(...lore.warnings);
    const pins = collectPins(locations, input.existingAnchors, lore.pins, warnings, refusals);
    const distanceConstraints = buildDistanceConstraints(locations, lore, warnings);
    let fieldClauses = lore.clauses.filter(clause => clause.kind === 'transect');

    let graph = relaxDistanceConstraints(
        locations,
        pins,
        distanceConstraints,
        fieldClauses,
        worldSeed,
        relaxations,
        refusals,
    );
    fieldClauses = resolveFieldConflicts(fieldClauses, graph.positions, relaxations, refusals);
    fieldClauses = applyHardenedCells(fieldClauses, graph.positions, hardened, relaxations);
    graph = relaxDistanceConstraints(
        locations,
        pins,
        graph.active,
        fieldClauses,
        worldSeed,
        relaxations,
        refusals,
    );
    resolveRoundedCollisions(locations, pins, graph.positions, refusals);

    const anchors = locations.map(location => {
        const position = graph.positions.get(location.id);
        const pin = pins.get(location.id);
        return {
            locationId: location.id,
            x: position.x,
            y: position.y,
            pinned: Boolean(pin),
            source: pin ? 'player' : 'solved',
        };
    });
    const transects = buildTransects(fieldClauses, graph.positions);
    const connections = graph.active.map(constraint => ({
        fromId: constraint.fromId,
        toId: constraint.toId,
        band: constraint.band,
        source: constraint.sourceKind,
        direction: constraint.direction ?? null,
    }));
    const report = buildReport(
        locations,
        graph.active,
        fieldClauses,
        warnings,
        relaxations,
        refusals,
        graph.positions,
    );
    return { anchors, transects, connections, report };
}

