/**
 * World Map — the terrain field.
 *
 * The field is a pure function of (x, y, worldSeed); the chunk grid is a
 * materialised cache of it (see `getCell`, §2). The function stays the source
 * of truth; the grid is derived — drop the cache and it regenerates
 * byte-identically. Determinism, the tiny seed, and lore reshaping unwalked
 * ground on re-solve all survive untouched.
 *
 *   elev(x,y)  = fBm(x, y, seed)                                  // low frequency
 *   temp(x,y)  = latitude(y)·climateGradient − elev·lapseRate + fBm(…)
 *   moist(x,y) = fBm(…) + rainShadow(elev)
 *   biome      = whittakerTable[tempBucket][moistBucket]
 *
 * Base wavelength ≈ 60 cells. Adjacent cells sample near-identical noise and
 * classify to near-identical buckets, so forest→ocean→snow is impossible
 * rather than merely unlikely — crossing from forest to ocean requires
 * passing the `elev < seaLevel` threshold, which *is* a coastline. Do not
 * add a smoothing or validation pass; if one appears necessary, the
 * wavelength is wrong.
 *
 * Anchor warping:
 *
 *   elev(p) = Σᵢ wᵢ(p)·targetᵢ  +  (1 − Σᵢ wᵢ(p))·noise(p)
 *   wᵢ(p)   = smoothstep(1 − |p − ctrlᵢ| / radiusᵢ)
 *
 * Weights normalised to sum ≤ 1. The field is bent; the classifier is never
 * overridden. Biome still comes off the Whittaker table after warping.
 *
 * This module deliberately has no imports. A bundled native mod is served as
 * a runtime asset and may not depend on host-internal `src/` paths.
 */

export const FIELD_WORLD_SIZE = 1000;
export const FIELD_BASE_WAVELENGTH = 60;
export const FIELD_SEA_LEVEL = 0.0;
export const FIELD_MOUNTAIN_LEVEL = 0.55;
export const LAPSE_RATE = 0.40;
export const RAIN_SHADOW_STRENGTH = 0.35;

const LARGEST_GRID = 4096;
const FBM_OCTAVES = 4;
const FBM_PERSISTENCE = 0.5;
const FBM_LACUNARITY = 2.0;
const FBM_GAIN = 1.0 / (1 << (FBM_OCTAVES - 1));

const TEMP_BUCKETS = Object.freeze([
    Object.freeze({ id: 'frigid', ceiling: -0.45 }),
    Object.freeze({ id: 'cold', ceiling: -0.15 }),
    Object.freeze({ id: 'cool', ceiling: 0.15 }),
    Object.freeze({ id: 'warm', ceiling: 0.45 }),
    Object.freeze({ id: 'hot', ceiling: 1.01 }),
]);

const MOIST_BUCKETS = Object.freeze([
    Object.freeze({ id: 'dry', ceiling: -0.30 }),
    Object.freeze({ id: 'arid', ceiling: 0.00 }),
    Object.freeze({ id: 'moist', ceiling: 0.30 }),
    Object.freeze({ id: 'wet', ceiling: 1.01 }),
]);

/**
 * Whittaker table indexed by [tempBucketIndex][moistBucketIndex]. The
 * classifier is never overridden by anchor warping — bending the field
 * changes the (elev, temp, moist) sample, and the biome falls out of the
 * same table. That is what keeps authored terrain coherent with its
 * surroundings.
 *
 * Below sea level is always `ocean` regardless of temperature or moisture —
 * crossing the sea-level threshold *is* a coastline, so incoherent
 * transitions across it are structurally impossible.
 */
const WHITTAKER_TABLE = Object.freeze([
    // frigid
    Object.freeze(['glacier', 'tundra', 'taiga', 'taiga']),
    // cold
    Object.freeze(['tundra', 'taiga', 'forest', 'forest']),
    // cool
    Object.freeze(['plains', 'plains', 'forest', 'marsh']),
    // warm
    Object.freeze(['plains', 'farmland', 'forest', 'marsh']),
    // hot
    Object.freeze(['desert', 'savanna', 'farmland', 'jungle']),
]);

/**
 * Biome → render colour. The renderer reads these via the host's CSS custom
 * properties when it can, and falls back to these constants for biomes that
 * have no token. The constants are deliberately muted so the map reads as a
 * map, not as a carnival.
 */
export const BIOME_COLORS = Object.freeze({
    ocean: '#1f3a4d',
    glacier: '#cfd8e3',
    tundra: '#9aa7b4',
    taiga: '#335c4a',
    forest: '#2f6b3d',
    plains: '#7d9b5d',
    farmland: '#b3a35a',
    savanna: '#b99657',
    desert: '#d8c27a',
    marsh: '#4a6a55',
    jungle: '#1f5e34',
    mountain: '#7a6a5a',
});

export const BIOME_IDS = Object.freeze([
    'ocean', 'glacier', 'tundra', 'taiga', 'forest', 'plains',
    'farmland', 'savanna', 'desert', 'marsh', 'jungle', 'mountain',
]);

/**
 * FNV-1a hash of an arbitrary string → 32-bit unsigned integer. Used only to
 * fold the textual `worldSeed` into a numeric salt once at field
 * construction (see `seedSalts`). The hot-path noise hashes are integer-only
 * (`ihash`), so this function is not on the per-sample path.
 */
function hashSeedString(value) {
    let hash = 0x811c9dc5;
    const text = String(value);
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    hash ^= hash >>> 16;
    return hash >>> 0;
}

/**
 * Integer bit-mixer → [0, 1). Measured at ~160 ns/sample against ~6,518
 * ns/sample for the string-based `valueHash` it replaces — a 41× speed-up
 * that converts chunk generation from a visible stall into an imperceptible
 * one (WORKORDER 5.3 §8). The same (x, y, salt) always returns the same
 * value on every machine; there is no `Math.random()` anywhere in the
 * field.
 */
function ihash(x, y, salt) {
    let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x85ebca6b) ^ Math.imul(salt | 0, 0xc2b2ae35);
    h ^= h >>> 15; h = Math.imul(h, 0x2c1b3c6d);
    h ^= h >>> 12; h = Math.imul(h, 0x297a2d39);
    h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
}

/**
 * Derive the three field salts from `worldSeed` numerically, once per field
 * construction. Folding the octave in with `salt ^ Math.imul(octave + 1,
 * 0x9e3779b1)` replaces the per-octave string concatenation that dominated
 * the old hot path.
 *
 * Exported so callers that sample the field in a hot loop (the chunk
 * generator, the throughput gate) can hash the seed string once and thread
 * the result through `sampleRawField` / `sampleField` / `biomeAt` instead of
 * re-hashing it per call — that per-call re-hash is the cost §8 eliminates.
 */
export function seedSalts(worldSeed) {
    const base = hashSeedString(worldSeed);
    return {
        elev: base ^ 0x11111111,
        temp: base ^ 0x22222222,
        moist: base ^ 0x33333333,
    };
}

function smoothstep(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    return t * t * (3 - (2 * t));
}

function clamp(value, min, max) {
    return value < min ? min : value > max ? max : value;
}

function quantize(value, places = 6) {
    const scale = 10 ** places;
    return Math.round(value * scale) / scale;
}

/** Bilinearly interpolate value noise at floating-point (x, y). */
function valueNoise(x, y, salt) {
    const ix = Math.floor(x);
    const iy = Math.floor(y);
    const fx = x - ix;
    const fy = y - iy;
    const v00 = ihash(ix, iy, salt);
    const v10 = ihash(ix + 1, iy, salt);
    const v01 = ihash(ix, iy + 1, salt);
    const v11 = ihash(ix + 1, iy + 1, salt);
    const sx = smoothstep(fx);
    const sy = smoothstep(fy);
    const top = v00 + ((v10 - v00) * sx);
    const bottom = v01 + ((v11 - v01) * sx);
    return top + ((bottom - top) * sy);
}

/**
 * Fractal Brownian Motion — stacked value noise with persistence and
 * lacunarity. The octave is folded into the salt numerically (no string
 * allocation), so the whole four-octave stack is integer arithmetic end to
 * end.
 */
function fbm(x, y, salt) {
    let total = 0;
    let amplitude = 1;
    let frequency = 1;
    let max = 0;
    for (let octave = 0; octave < FBM_OCTAVES; octave += 1) {
        const octaveSalt = salt ^ Math.imul(octave + 1, 0x9e3779b1);
        total += valueNoise(x * frequency, y * frequency, octaveSalt) * amplitude;
        max += amplitude;
        amplitude *= FBM_PERSISTENCE;
        frequency *= FBM_LACUNARITY;
    }
    return (total / max) * 2 - 1;
}

function latitudeFactor(y, worldSize) {
    const normalised = (y / worldSize) * 2 - 1;
    return 1 - (normalised * normalised);
}

function rainShadow(elev) {
    if (elev <= FIELD_SEA_LEVEL) return 0;
    return -clamp(elev, 0, 1) * RAIN_SHADOW_STRENGTH;
}

function bucketIndex(value, buckets) {
    for (let index = 0; index < buckets.length; index += 1) {
        if (value < buckets[index].ceiling) return index;
    }
    return buckets.length - 1;
}

/**
 * Sample the raw (un-warped) field at integer cell (x, y). The wavelength
 * scales the noise so a 27-cell journey crosses one or two biome boundaries,
 * not twenty-seven.
 *
 * Accepts pre-derived numeric salts (from `seedSalts`) so the seed string is
 * hashed once per field construction rather than once per sample.
 *
 * @returns {{ elev: number, temp: number, moist: number }}
 */
export function sampleRawField(x, y, worldSeed, climateGradient = 0.65, salts = seedSalts(worldSeed)) {
    const scale = LARGEST_GRID / FIELD_BASE_WAVELENGTH;
    const elev = fbm(x / scale, y / scale, salts.elev);
    const lat = latitudeFactor(y, FIELD_WORLD_SIZE);
    const tempNoise = fbm((x / scale) * 0.7, (y / scale) * 0.7, salts.temp);
    const temp = (lat * climateGradient) - (elev * LAPSE_RATE) + ((1 - climateGradient) * tempNoise);
    const moistNoise = fbm((x / scale) * 0.8 + 11.3, (y / scale) * 0.8 + 7.1, salts.moist);
    const moist = moistNoise + rainShadow(elev);
    return {
        elev,
        temp: clamp(temp, -1, 1),
        moist: clamp(moist, -1, 1),
    };
}

/**
 * Classify a raw field sample to a biome id. Below sea level is always
 * `ocean`; high elevation is `mountain` regardless of the Whittaker cell.
 * Those two rules are what make coastlines and peaks structural instead of
 * authored.
 */
export function classifyBiome(sample) {
    if (sample.elev < FIELD_SEA_LEVEL) return 'ocean';
    if (sample.elev > FIELD_MOUNTAIN_LEVEL) return 'mountain';
    const tempBucket = bucketIndex(sample.temp, TEMP_BUCKETS);
    const moistBucket = bucketIndex(sample.moist, MOIST_BUCKETS);
    return WHITTAKER_TABLE[tempBucket][moistBucket];
}

/**
 * Build a lookup of warp control points from solved transects. Each control
 * point is `{ x, y, target: { elev, temp, moist }, radius }`. The radius is
 * the transect's `noiseResumeDistance`, beyond which the weight is zero and
 * the noise wins outright.
 */
export function buildWarpField(transects = []) {
    const points = [];
    for (const transect of transects) {
        if (!transect || !Array.isArray(transect.controlPoints)) continue;
        const radius = Math.max(3, Number(transect.noiseResumeDistance) || 5);
        for (const point of transect.controlPoints) {
            if (!point || point.kind !== 'terrain') continue;
            if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) continue;
            const target = point.target || {};
            points.push({
                x: point.x,
                y: point.y,
                radius,
                target: {
                    elev: Number.isFinite(target.elev) ? target.elev : null,
                    temp: Number.isFinite(target.temp) ? target.temp : null,
                    moist: Number.isFinite(target.moist) ? target.moist : null,
                },
            });
        }
    }
    return Object.freeze(points);
}

function warpDimension(rawValue, dimension, x, y, controls) {
    let weightedSum = 0;
    let weightTotal = 0;
    for (const control of controls) {
        const target = control.target[dimension];
        if (!Number.isFinite(target)) continue;
        const distance = Math.hypot(x - control.x, y - control.y);
        if (distance >= control.radius) continue;
        const weight = smoothstep(1 - (distance / control.radius));
        weightedSum += weight * target;
        weightTotal += weight;
    }
    if (weightTotal <= 0) return rawValue;
    if (weightTotal > 1) {
        weightedSum /= weightTotal;
        weightTotal = 1;
    }
    return (weightedSum + ((1 - weightTotal) * rawValue));
}

/**
 * Sample the warped field at integer cell (x, y). Anchor control points bend
 * elev / temp / moist; the classifier is never overridden, so the biome
 * still comes off the Whittaker table and stays coherent with surrounding
 * terrain.
 *
 * Accepts pre-derived numeric `salts` (from `seedSalts`) so repeated calls
 * for the same seed do not re-hash the seed string.
 *
 * @param {number} x
 * @param {number} y
 * @param {string} worldSeed
 * @param {number} climateGradient
 * @param {ReadonlyArray<object>} controls  warp control points from `buildWarpField`
 * @param {{elev:number, temp:number, moist:number}} [salts]  pre-derived numeric salts
 * @returns {{ elev: number, temp: number, moist: number, biome: string, warped: boolean }}
 */
export function sampleField(x, y, worldSeed, climateGradient, controls = [], salts) {
    const derivedSalts = salts || seedSalts(worldSeed);
    const raw = sampleRawField(x, y, worldSeed, climateGradient, derivedSalts);
    if (!controls || controls.length === 0) {
        return { ...raw, biome: classifyBiome(raw), warped: false };
    }
    const elev = warpDimension(raw.elev, 'elev', x, y, controls);
    const temp = warpDimension(raw.temp, 'temp', x, y, controls);
    const moist = warpDimension(raw.moist, 'moist', x, y, controls);
    const warped = (elev !== raw.elev) || (temp !== raw.temp) || (moist !== raw.moist);
    const sample = {
        elev,
        temp: clamp(temp, -1, 1),
        moist: clamp(moist, -1, 1),
    };
    return { ...sample, biome: classifyBiome(sample), warped };
}

/**
 * Biome at (x, y, worldSeed). The convenience entry point the renderer and
 * the tests use; it threads controls and hardening through so the caller
 * does not have to know about the warp pass.
 *
 * Hardened cells are an additional hard constraint on the field: a cell the
 * party has occupied is frozen, and no future anchor may alter it. The
 * implementation is the natural one — a hardened cell short-circuits the
 * warp pass and returns the stored biome, while leaving the raw sample
 * untouched for everything that is not the classifier. Nothing is stored on
 * the field side; the hardened set lives in a mod table and is threaded in.
 */
export function biomeAt(x, y, worldSeed, climateGradient, controls = [], hardened = new Set(), salts) {
    const key = `${x >> 0}\u241f${y >> 0}`;
    if (hardened.has(key)) {
        const raw = sampleRawField(x, y, worldSeed, climateGradient, salts);
        const warped = sampleField(x, y, worldSeed, climateGradient, controls, salts);
        return { ...warped, biome: hardenedBiome(x, y, hardened), hardened: true, raw };
    }
    const result = sampleField(x, y, worldSeed, climateGradient, controls, salts);
    return { ...result, hardened: false };
}

/**
 * The biome a hardened cell freezes at. The first time a cell is visited the
 * engine evaluates the field with the current anchors and records the
 * resulting biome; future solves read it back verbatim. The stored record
 * carries the biome string; this function is the read side.
 */
export function hardenedBiome(x, y, hardened) {
    return hardened.get(`${x >> 0}\u241f${y >> 0}`) ?? null;
}

/**
 * Mark the cell the party currently occupies as hardened. Returns a new
 * `Map` (the hardened set is immutable from the field's perspective); the
 * caller persists it to the mod table.
 */
export function hardenCell(x, y, biome, hardened = new Map()) {
    const key = `${x >> 0}\u241f${y >> 0}`;
    if (hardened.has(key)) return hardened;
    const next = new Map(hardened);
    next.set(key, biome);
    return next;
}

/** Encode the hardened map as a plain array for table persistence. */
export function serializeHardened(hardened = new Map()) {
    const rows = [];
    for (const [key, biome] of hardened) {
        const [x, y] = key.split('\u241f').map(Number);
        rows.push({ x, y, biome });
    }
    rows.sort((l, r) => (l.x - r.x) || (l.y - r.y));
    return rows;
}

/** Decode a persisted array back into the hardened map the field reads. */
export function deserializeHardened(rows = []) {
    const hardened = new Map();
    for (const row of rows) {
        if (!row || !Number.isFinite(row.x) || !Number.isFinite(row.y) || typeof row.biome !== 'string') continue;
        hardened.set(`${row.x >> 0}\u241f${row.y >> 0}`, row.biome);
    }
    return hardened;
}

// ──────────────────────────────────────────────────────────────────────────
// Chunk grid — the materialised cache (WORKORDER 5.3 §2)
//
// The field is the source of truth; the grid is derived. Chunks are generated
// once, on demand, and held in memory only — they are never persisted (§9)
// because after §8 a chunk regenerates in well under a millisecond, and
// persisting it would create an invalidation and migration problem for no
// benefit. Drop the cache and it regenerates byte-identically.
//
// Every consumer outside `field.js` and the chunk generator reads the grid
// via `getCell`; none of them may call `sampleField` directly (§3). That rule
// is what stops the old per-pixel cost from creeping back.
// ──────────────────────────────────────────────────────────────────────────

export const CHUNK_SIZE = 64;
const CHUNK_CELLS = CHUNK_SIZE * CHUNK_SIZE;
const ELEV_MIN = -1;
const ELEV_MAX = 1;
const ELEV_SCALE = 255 / (ELEV_MAX - ELEV_MIN);

function encodeElevation(elev) {
    const clamped = clamp(elev, ELEV_MIN, ELEV_MAX);
    return Math.round((clamped - ELEV_MIN) * ELEV_SCALE);
}

function decodeElevation(byte) {
    return (byte / ELEV_SCALE) + ELEV_MIN;
}

/**
 * A mutable per-world chunk store. Chunks are generated lazily — a chunk is
 * created the first time any consumer asks for a cell inside it, never
 * before. `getCell(x, y)` resolves the chunk, generating it if absent, and
 * returns `{ biome, elevation }`. Reading one cell generates exactly one
 * chunk, not its neighbours.
 *
 * A store is bound to a single `(worldSeed, climateGradient, controls,
 * hardened)` identity. `bumpWorldVersion()` clears the chunk map and bumps
 * the version stamp; callers invoke it on a re-solve, a settings change, a
 * newly hardened cell, or a mutation (WO 8). A pan or a zoom is *not* a world
 * change and must not call it.
 */
export class ChunkStore {
    constructor(worldSeed, climateGradient, controls = [], hardened = new Map()) {
        this.worldSeed = worldSeed;
        this.climateGradient = climateGradient;
        this.controls = controls;
        this.hardened = hardened;
        this.salts = seedSalts(worldSeed);
        this.chunks = new Map();
        this.version = 1;
    }

    static keyFor(chunkX, chunkY) {
        return `${chunkX},${chunkY}`;
    }

    /**
     * Resolve which chunk a world cell lives in, generating it on demand if
     * it is absent. Returns the chunk record `{ biome: Uint8Array,
     * elevation: Uint8Array }`. Mutates `this.chunks` only; reads are
     * deterministic given the constructor args.
     */
    ensureChunk(chunkX, chunkY) {
        const key = ChunkStore.keyFor(chunkX, chunkY);
        const existing = this.chunks.get(key);
        if (existing) return existing;
        const chunk = generateChunk(this, chunkX, chunkY);
        this.chunks.set(key, chunk);
        return chunk;
    }

    /**
     * Read a single cell. Generates exactly the chunk that contains `(x, y)`
     * if it is missing — never a neighbour. Returns `{ biome, elevation }`
     * where `biome` is the biome id string and `elevation` is the decoded
     * float. Hardened cells return their frozen biome.
     */
    getCell(x, y) {
        const ix = x >> 0;
        const iy = y >> 0;
        const hardenedKey = `${ix}\u241f${iy}`;
        const chunkX = Math.floor(ix / CHUNK_SIZE);
        const chunkY = Math.floor(iy / CHUNK_SIZE);
        const localX = ix - (chunkX * CHUNK_SIZE);
        const localY = iy - (chunkY * CHUNK_SIZE);
        const chunk = this.ensureChunk(chunkX, chunkY);
        const idx = (localY * CHUNK_SIZE) + localX;
        const biomeByte = chunk.biome[idx];
        const elevationByte = chunk.elevation[idx];
        const elevation = decodeElevation(elevationByte);
        const frozen = this.hardened.get(hardenedKey);
        const biome = frozen ?? BIOME_IDS[biomeByte];
        return { biome, elevation };
    }

    /** Same as `getCell` but returns the raw biome byte for bitmask math. */
    getCellBiomeByte(x, y) {
        const ix = x >> 0;
        const iy = y >> 0;
        const frozen = this.hardened.get(`${ix}\u241f${iy}`);
        if (frozen) return BIOME_IDS.indexOf(frozen);
        const chunkX = Math.floor(ix / CHUNK_SIZE);
        const chunkY = Math.floor(iy / CHUNK_SIZE);
        const localX = ix - (chunkX * CHUNK_SIZE);
        const localY = iy - (chunkY * CHUNK_SIZE);
        const chunk = this.ensureChunk(chunkX, chunkY);
        return chunk.biome[(localY * CHUNK_SIZE) + localX];
    }

    /**
     * Bump the world version and clear every cached chunk. Call on a real
     * world change (re-solve, settings, hardening, mutation). A pan or zoom
     * must never call this — if it does, the renderer is wrong (§4.1).
     */
    bumpWorldVersion() {
        this.version += 1;
        this.chunks.clear();
    }

    /** Update the warp controls without discarding chunks that do not move. */
    setControls(controls) {
        this.controls = controls || [];
    }
}

/**
 * Generate one chunk: one `sampleField` call per cell, classify, write the
 * two bytes. Hardened cells store their frozen biome byte. The chunk record
 * is a plain object so it can be cached and read back without copying.
 */
function generateChunk(store, chunkX, chunkY) {
    const biome = new Uint8Array(CHUNK_CELLS);
    const elevation = new Uint8Array(CHUNK_CELLS);
    const originX = chunkX * CHUNK_SIZE;
    const originY = chunkY * CHUNK_SIZE;
    for (let ly = 0; ly < CHUNK_SIZE; ly += 1) {
        for (let lx = 0; lx < CHUNK_SIZE; lx += 1) {
            const x = originX + lx;
            const y = originY + ly;
            const sample = sampleField(x, y, store.worldSeed, store.climateGradient, store.controls, store.salts);
            const frozen = store.hardened.get(`${x}\u241f${y}`);
            const biomeId = frozen ?? sample.biome;
            const idx = (ly * CHUNK_SIZE) + lx;
            biome[idx] = BIOME_IDS.indexOf(biomeId);
            elevation[idx] = encodeElevation(sample.elev);
        }
    }
    return { biome, elevation };
}