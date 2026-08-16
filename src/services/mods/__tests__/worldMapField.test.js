import { describe, expect, it } from 'vitest';
import {
    BIOME_IDS,
    biomeAt,
    buildWarpField,
    classifyBiome,
    deserializeHardened,
    hardenCell,
    sampleField,
    sampleRawField,
    serializeHardened,
} from '../../../../public/bundled-mods/worldmap/field.js';
import { solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';

function location(id, name) {
    return { id, name, aliases: '', connections: [] };
}

function transect(overrides = {}) {
    return {
        locationId: 'f',
        locationName: 'Frosthold',
        noiseResumeDistance: 5,
        controlPoints: [
            { kind: 'terrain', terrain: 'mountain', target: { elev: 0.8, temp: -0.3, moist: null }, x: 500, y: 500, distance: 0 },
        ],
        ...overrides,
    };
}

describe('World Map field — determinism', () => {
    it('biome(x, y, seed) is byte-identical across 10,000 calls', () => {
        const seen = new Map();
        for (let i = 0; i < 10000; i += 1) {
            const key = `${300},${400}\u241fseed-determinism`;
            if (!seen.has(key)) seen.set(key, biomeAt(300, 400, 'seed-determinism', 0.65).biome);
            const now = seen.get(key);
            const again = biomeAt(300, 400, 'seed-determinism', 0.65).biome;
            expect(again).toBe(now);
        }
        expect(seen.size).toBe(1);
    });

    it('biome(x, y, seed) is byte-identical across a fresh module re-import', async () => {
        const before = biomeAt(123, 456, 'fresh-seed', 0.65).biome;
        const fresh = await import('../../../../public/bundled-mods/worldmap/field.js?fresh=' + Date.now());
        const after = fresh.biomeAt(123, 456, 'fresh-seed', 0.65).biome;
        expect(after).toBe(before);
    });

    it('different seeds usually produce different biomes somewhere', () => {
        let differences = 0;
        for (let y = 0; y < 20; y += 1) {
            for (let x = 0; x < 20; x += 1) {
                const a = biomeAt(x, y, 'seed-A', 0.65).biome;
                const b = biomeAt(x, y, 'seed-B', 0.65).biome;
                if (a !== b) differences += 1;
            }
        }
        expect(differences).toBeGreaterThan(0);
    });
});

describe('World Map field — coherence', () => {
    it('walk a 200-cell transect: no adjacent pair crosses more than one Whittaker bucket in either axis', () => {
        const seed = 'coherence-seed';
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

    it('every classified biome is a known id', () => {
        for (let y = 100; y < 120; y += 1) {
            for (let x = 100; x < 120; x += 1) {
                const sample = sampleRawField(x, y, 'known-ids', 0.65);
                const biome = classifyBiome(sample);
                expect(BIOME_IDS).toContain(biome);
            }
        }
    });

    it('below sea level is always ocean', () => {
        for (let i = 0; i < 50; i += 1) {
            const sample = sampleRawField(200 + i, 200 + i, 'ocean-seed', 0.65);
            if (sample.elev < 0) expect(classifyBiome(sample)).toBe('ocean');
        }
    });
});

describe('World Map field — anchor warping', () => {
    it('a mountain transect raises elevation at the anchor and decays beyond the falloff radius', () => {
        const controls = buildWarpField([transect()]);
        const atAnchor = sampleField(500, 500, 'warp-seed', 0.65, controls);
        const rawAtAnchor = sampleRawField(500, 500, 'warp-seed', 0.65);
        expect(atAnchor.elev).toBeGreaterThan(rawAtAnchor.elev + 0.1);

        const beyondRadius = 5 + 1;
        const beyond = sampleField(500 + beyondRadius, 500, 'warp-seed', 0.65, controls);
        const rawBeyond = sampleRawField(500 + beyondRadius, 500, 'warp-seed', 0.65);
        expect(Math.abs(beyond.elev - rawBeyond.elev)).toBeLessThan(0.05);
    });

    it('warping respects the max-radius falloff: weight is zero at and beyond the radius', () => {
        const controls = buildWarpField([transect({ noiseResumeDistance: 8 })]);
        const raw = sampleRawField(508, 500, 'falloff-seed', 0.65);
        const warped = sampleField(508, 500, 'falloff-seed', 0.65, controls);
        expect(Math.abs(warped.elev - raw.elev)).toBeLessThan(0.05);
    });

    it('biome still comes off the Whittaker table after warping — the classifier is never overridden', () => {
        const controls = buildWarpField([transect({ controlPoints: [
            { kind: 'terrain', terrain: 'ocean', target: { elev: -0.6, temp: null, moist: null }, x: 510, y: 510, distance: 0 },
        ] })]);
        const result = sampleField(510, 510, 'override-seed', 0.65, controls);
        expect(result.biome).toBe('ocean');
    });
});

describe('World Map field — no storage', () => {
    it('a full render followed by a campaign save writes no cell data (only mod-table rows for hardened cells)', () => {
        const written = [];
        const hardened = new Map();
        for (let y = 490; y < 520; y += 1) {
            for (let x = 490; x < 520; x += 1) {
                const result = biomeAt(x, y, 'no-storage-seed', 0.65, [], hardened);
                written.push(result.biome);
            }
        }
        expect(written.length).toBe(30 * 30);
        expect(written.every(b => typeof b === 'string')).toBe(true);
        expect(hardened.size).toBe(0);
    });

    it('sampleField returns the same values whether or not a save happens in between', () => {
        const controls = buildWarpField([]);
        const a = sampleField(400, 400, 'idempotent-seed', 0.65, controls);
        const b = sampleField(400, 400, 'idempotent-seed', 0.65, controls);
        expect(a).toEqual(b);
    });
});

describe('World Map field — hardening', () => {
    it('a hardened cell is unchanged after adding a new anchor adjacent to it and re-solving', () => {
        const locations = [location('a', 'Ashfen'), location('b', 'Briarwatch')];
        const base = solveWorldMap({ locations, loreChunks: [], worldSeed: 'harden-seed' });
        const anchorA = base.anchors.find(x => x.locationId === 'a');
        const controls = buildWarpField(base.transects);
        const before = biomeAt(anchorA.x, anchorA.y, 'harden-seed', 0.65, controls, new Map());
        const hardened = hardenCell(anchorA.x, anchorA.y, before.biome, new Map());

        const after = solveWorldMap({
            locations: [...locations, location('c', 'Cinderkeep')],
            loreChunks: [],
            existingAnchors: base.anchors,
            worldSeed: 'harden-seed',
            hardenedCells: hardened,
        });
        const afterControls = buildWarpField(after.transects);
        const afterResult = biomeAt(anchorA.x, anchorA.y, 'harden-seed', 0.65, afterControls, hardened);
        expect(afterResult.biome).toBe(before.biome);
        expect(afterResult.hardened).toBe(true);
    });

    it('hardenCell is idempotent and serialize/deserialize round-trips', () => {
        let hardened = new Map();
        hardened = hardenCell(100, 200, 'forest', hardened);
        hardened = hardenCell(100, 200, 'plains', hardened);
        expect(hardened.size).toBe(1);
        expect(hardened.get('100\u241f200')).toBe('forest');

        const rows = serializeHardened(hardened);
        expect(rows).toEqual([{ x: 100, y: 200, biome: 'forest' }]);
        const restored = deserializeHardened(rows);
        expect(restored.get('100\u241f200')).toBe('forest');
    });

    it('a field clause targeting a hardened cell is relaxed and reported, not silently applied', () => {
        const hardened = new Map([['500\u241f500', 'plains']]);
        const result = solveWorldMap({
            locations: [location('f', 'Frosthold')],
            loreChunks: [{
                id: 'lore-f',
                header: 'LOCATION -- Frosthold',
                content: '**Neighbors:** E mountain close',
                category: 'location',
            }],
            worldSeed: 'hardened-cell-seed',
            hardenedCells: hardened,
        });
        const relaxed = result.report.relaxations.some(r => r.message.includes('hardened'));
        expect(relaxed).toBe(true);
    });
});

describe('World Map field — acceptance (reprise)', () => {
    it('a solved campaign renders a map with coastlines, mountain ranges and plausible biome bands', () => {
        const result = solveWorldMap({
            locations: [location('a', 'Aethelgard'), location('b', 'Briarwatch')],
            loreChunks: [],
            worldSeed: 'acceptance-seed',
        });
        const controls = buildWarpField(result.transects);
        const biomes = new Set();
        let ocean = 0;
        let mountain = 0;
        for (let y = 0; y < 100; y += 3) {
            for (let x = 0; x < 100; x += 3) {
                const b = biomeAt(x, y, 'acceptance-seed', 0.65, controls, new Map()).biome;
                biomes.add(b);
                if (b === 'ocean') ocean += 1;
                if (b === 'mountain') mountain += 1;
            }
        }
        expect(biomes.size).toBeGreaterThan(1);
        expect(ocean).toBeGreaterThan(0);
        expect(mountain).toBeGreaterThan(0);
    });

    it('panning to an unexplored quadrant renders identically every time', () => {
        const controls = buildWarpField([]);
        const first = biomeAt(800, 800, 'unexplored-seed', 0.65, controls, new Map()).biome;
        const second = biomeAt(800, 800, 'unexplored-seed', 0.65, controls, new Map()).biome;
        expect(second).toBe(first);
    });
});