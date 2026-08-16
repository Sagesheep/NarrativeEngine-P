import { describe, expect, it } from 'vitest';
import {
    BIOME_IDS,
    ChunkStore,
    CHUNK_SIZE,
    biomeAt,
    buildWarpField,
    classifyBiome,
    sampleField,
    sampleRawField,
    seedSalts,
} from '../../../../public/bundled-mods/worldmap/field.js';
import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';

function location(id, name) {
    return { id, name, aliases: '', connections: [] };
}

describe('World Map chunk grid — determinism (§11)', () => {
    it('biome(x, y, seed) is byte-identical across 10,000 calls', () => {
        const seen = new Map();
        for (let i = 0; i < 10000; i += 1) {
            const key = `${300},${400}\u241fseed-determinism-chunk`;
            if (!seen.has(key)) seen.set(key, biomeAt(300, 400, 'seed-determinism-chunk', 0.65).biome);
            const now = seen.get(key);
            const again = biomeAt(300, 400, 'seed-determinism-chunk', 0.65).biome;
            expect(again).toBe(now);
        }
        expect(seen.size).toBe(1);
    });

    it('biome(x, y, seed) is byte-identical across a fresh module re-import', async () => {
        const before = biomeAt(123, 456, 'fresh-seed-chunk', 0.65).biome;
        const fresh = await import('../../../../public/bundled-mods/worldmap/field.js?fresh=' + Date.now());
        const after = fresh.biomeAt(123, 456, 'fresh-seed-chunk', 0.65).biome;
        expect(after).toBe(before);
    });

    it('two different seeds yield different fields (guards numeric salt derivation §8)', () => {
        let differences = 0;
        for (let y = 200; y < 220; y += 1) {
            for (let x = 200; x < 220; x += 1) {
                const a = biomeAt(x, y, 'seed-A-chunk', 0.65).biome;
                const b = biomeAt(x, y, 'seed-B-chunk', 0.65).biome;
                if (a !== b) differences += 1;
            }
        }
        expect(differences).toBeGreaterThan(0);
    });
});

describe('World Map chunk grid — coherence (§11)', () => {
    it('walk a 200-cell transect: no adjacent pair crosses more than one Whittaker bucket in either axis', () => {
        const seed = 'coherence-seed-chunk';
        let violations = 0;
        let prev = null;
        for (let x = 0; x < 200; x += 1) {
            const sample = sampleRawField(x, 500, seed, 0.65);
            if (prev) {
                const elevJump = Math.abs(sample.elev - prev.elev);
                const tempJump = Math.abs(sample.temp - prev.temp);
                const moistJump = Math.abs(sample.moist - prev.moist);
                if (elevJump > 0.5 || tempJump > 0.5 || moistJump > 0.5) violations += 1;
            }
            prev = sample;
        }
        expect(violations).toBe(0);
    });
});

describe('World Map chunk grid — getCell (§2, §11)', () => {
    it('getCell returns identical values whether the chunk was freshly generated or served from cache', () => {
        const store = new ChunkStore('cache-seed', 0.65, [], new Map());
        const first = store.getCell(100, 100);
        // Read the same cell again — chunk is cached, must return identical data.
        const second = store.getCell(100, 100);
        expect(second.biome).toBe(first.biome);
        expect(second.elevation).toBe(first.elevation);
        // Cross-check the cached chunk against a fresh store (independent generation).
        const fresh = new ChunkStore('cache-seed', 0.65, [], new Map());
        const fromFresh = fresh.getCell(100, 100);
        expect(fromFresh.biome).toBe(first.biome);
        expect(fromFresh.elevation).toBe(first.elevation);
    });

    it('getCell classifies identically to biomeAt for the same inputs', () => {
        const store = new ChunkStore('parity-seed', 0.65, [], new Map());
        for (let i = 0; i < 50; i += 1) {
            const x = 200 + i;
            const y = 300 + i;
            const cell = store.getCell(x, y);
            const direct = biomeAt(x, y, 'parity-seed', 0.65, [], new Map());
            expect(cell.biome).toBe(direct.biome);
        }
    });

    it('every classified biome is a known id', () => {
        const store = new ChunkStore('known-ids-chunk', 0.65, [], new Map());
        for (let y = 100; y < 120; y += 1) {
            for (let x = 100; x < 120; x += 1) {
                const cell = store.getCell(x, y);
                expect(BIOME_IDS).toContain(cell.biome);
            }
        }
    });

    it('chunk generation is lazy — reading one cell generates exactly one chunk, not its neighbours', () => {
        const store = new ChunkStore('lazy-seed', 0.65, [], new Map());
        // Reading (70, 70) lands in chunk (1, 1) because CHUNK_SIZE=64.
        store.getCell(70, 70);
        expect(store.chunks.size).toBe(1);
        expect(store.chunks.has('1,1')).toBe(true);
        expect(store.chunks.has('0,0')).toBe(false);
        expect(store.chunks.has('2,2')).toBe(false);
        // Reading a cell in the same chunk does not create another.
        store.getCell(71, 71);
        expect(store.chunks.size).toBe(1);
        // Reading a cell in an adjacent chunk creates exactly one more.
        store.getCell(5, 5);
        expect(store.chunks.size).toBe(2);
    });

    it('hardened cells survive regeneration and return their frozen biome', () => {
        const hardened = new Map([['100\u241f100', 'plains']]);
        const store = new ChunkStore('hardened-seed', 0.65, [], hardened);
        const cell = store.getCell(100, 100);
        expect(cell.biome).toBe('plains');
        // Drop and regenerate: the chunk cache clears, the hardened map persists.
        store.bumpWorldVersion();
        const after = store.getCell(100, 100);
        expect(after.biome).toBe('plains');
    });
});

describe('World Map chunk grid — world version (§4.1, §11)', () => {
    it('a re-solve bumps worldVersion and invalidates the chunk cache', () => {
        const store = new ChunkStore('version-seed', 0.65, [], new Map());
        store.getCell(10, 10);
        expect(store.chunks.size).toBe(1);
        const before = store.version;
        store.bumpWorldVersion();
        expect(store.version).toBe(before + 1);
        expect(store.chunks.size).toBe(0);
    });

    it('pan and zoom do not bump worldVersion (the regression that matters most)', () => {
        const store = new ChunkStore('pan-seed', 0.65, [], new Map());
        const before = store.version;
        // Simulate a pan/zoom by reading many cells — none of this is a world change.
        for (let y = 0; y < 5; y += 1) {
            for (let x = 0; x < 5; x += 1) {
                store.getCell(x, y);
            }
        }
        expect(store.version).toBe(before);
    });
});

describe('World Map field — chunk grid stores nothing persisted (§9)', () => {
    it('a full chunk sweep writes no cell data to disk; the chunk map is in-memory only', () => {
        const store = new ChunkStore('no-storage-seed', 0.65, [], new Map());
        for (let y = 490; y < 520; y += 1) {
            for (let x = 490; x < 520; x += 1) {
                store.getCell(x, y);
            }
        }
        // The chunks exist in memory, but there is no persistence surface on
        // ChunkStore — no .save()/.persist()/.serialize() method exists.
        const methods = Object.getOwnPropertyNames(ChunkStore.prototype).filter(m => m !== 'constructor');
        expect(methods.some(m => /persist|save|serialize|write|dump/i.test(m))).toBe(false);
    });
});

describe('World Map field — throughput gate (§11)', () => {
    it('sampleField throughput has not regressed to string hashing', () => {
        const BATCHES = 20;
        const BATCH_SAMPLES = 20000;
        const seed = 'throughput-seed';
        const controls = buildWarpField([]);
        // §8: the seed is hashed once at field construction (seedSalts), not per
        // sample. The chunk store pre-derives salts and threads them through;
        // this test mirrors that real hot path. Passing salts avoids re-hashing
        // the seed string on every call, which is the cost §8 eliminates.
        const salts = seedSalts(seed);
        // Warm up so JIT effects do not skew the measurement.
        for (let i = 0; i < 2000; i += 1) sampleField(i & 1023, (i >> 1) & 1023, seed, 0.65, controls, salts);

        // Best-of-N batches, not one long run. `process.cpuUsage()` was the
        // obvious choice and is wrong here: it reports CPU for the whole
        // PROCESS, and vitest runs workers as threads sharing one process, so
        // sibling workers' CPU is billed to this measurement. That is why this
        // gate passed in isolation and failed under the full suite. The fastest
        // of several short batches approximates uncontended throughput, because
        // at least one batch usually lands in a quiet window.
        let bestSamplesPerSec = 0;
        for (let batch = 0; batch < BATCHES; batch += 1) {
            const start = performance.now();
            for (let i = 0; i < BATCH_SAMPLES; i += 1) {
                sampleField(i & 1023, (i >> 1) & 1023, seed, 0.65, controls, salts);
            }
            const ms = performance.now() - start;
            if (ms > 0) bestSamplesPerSec = Math.max(bestSamplesPerSec, (BATCH_SAMPLES / ms) * 1000);
        }

        // The regression this gate exists for: the original string-hashing field
        // measured 0.15 M/sec. The integer bit-mixer (§8) measures ~4.4 M/sec in
        // plain node. The bar is set at 1.5 M — an order of magnitude above the
        // thing being guarded against, with enough headroom that a loaded CI
        // machine cannot flap it. It deliberately will NOT catch a 2x slowdown;
        // a 2x slowdown is not what shipped a 4.7-second pan.
        expect(bestSamplesPerSec).toBeGreaterThanOrEqual(1_500_000);
    });
});

describe('World Map solver — hardened cells survive regeneration (§11)', () => {
    it('a hardened cell is unchanged after adding a new anchor adjacent to it and re-solving', () => {
        const locations = [location('a', 'Ashfen'), location('b', 'Briarwatch')];
        const base = solveWorldMap({ locations, loreChunks: [], worldSeed: 'harden-seed-chunk' });
        const anchorA = base.anchors.find(x => x.locationId === 'a');
        const controls = buildWarpField(base.transects);
        const before = biomeAt(anchorA.x, anchorA.y, 'harden-seed-chunk', 0.65, controls, new Map());
        const hardened = new Map([[`${anchorA.x >> 0}\u241f${anchorA.y >> 0}`, before.biome]]);

        const after = solveWorldMap({
            locations: [...locations, location('c', 'Cinderkeep')],
            loreChunks: [],
            existingAnchors: base.anchors,
            worldSeed: 'harden-seed-chunk',
            hardenedCells: hardened,
        });
        const afterControls = buildWarpField(after.transects);
        const afterResult = biomeAt(anchorA.x, anchorA.y, 'harden-seed-chunk', 0.65, afterControls, hardened);
        expect(afterResult.biome).toBe(before.biome);
        expect(afterResult.hardened).toBe(true);
    });
});