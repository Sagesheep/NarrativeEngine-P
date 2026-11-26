import { describe, expect, it } from 'vitest';
import { layoutOrigin, solveWorldMap } from '../../../../public/bundled-mods/worldmap/solver.js';
import { ChunkStore, buildWarpField } from '../../../../public/bundled-mods/worldmap/field.js';

// Free places used to spiral out from the world centre. For an ocean-centred
// seed they were snapped at most 8 cells or given an implicit islet, and the
// first save froze them there: a party with no foot route anywhere.

const CENTRE = { x: 500, y: 500 };
const place = (id, name, connections = []) => ({ id, name, aliases: '', connections, kind: 'place' });
const transit = (id, name, connections) => ({ id, name, aliases: '', connections, kind: 'transit' });
const anchorOf = (result, id) => result.anchors.find(anchor => anchor.locationId === id);
const store = seed => new ChunkStore(seed, 0.65, [], new Map());
const banded = () => [
    place('a', 'Ashford', [{ toId: 'b', band: 'local' }, { toId: 'c', band: 'regional' }]),
    place('b', 'Bramble', [{ toId: 'a', band: 'local' }, { toId: 'c', band: 'local' }]),
    place('c', 'Cinder', [{ toId: 'a', band: 'regional' }, { toId: 'b', band: 'local' }]),
];

// 4-connected non-ocean flood fill on the field the party actually walks: the
// region holding `from` must reach every target and be more than an islet.
function walkable(walkStore, from, targets, minimum = 400, limit = 20000) {
    const key = (x, y) => (y * 1000) + x;
    if (walkStore.getCell(from.x, from.y).biome === 'ocean') return { size: 0, reached: [] };
    const wanted = new Set(targets.map(target => key(target.x, target.y)));
    const seen = new Set([key(from.x, from.y)]);
    const queue = [[from.x, from.y]];
    for (let head = 0; head < queue.length && seen.size < limit; head += 1) {
        if (seen.size >= minimum && [...wanted].every(cell => seen.has(cell))) break;
        const [x, y] = queue[head];
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= 1000 || ny >= 1000 || seen.has(key(nx, ny))) continue;
            if (walkStore.getCell(nx, ny).biome === 'ocean') continue;
            seen.add(key(nx, ny));
            queue.push([nx, ny]);
        }
    }
    return { size: seen.size, reached: targets.filter(target => seen.has(key(target.x, target.y))) };
}

// What solveAndPersist does: solve against the store, then walk the field the
// solve's own transects (implicit islets included) bend.
function firstLayout(seed, locations = banded()) {
    const result = solveWorldMap({ locations, loreChunks: [], worldSeed: seed, chunkStore: store(seed) });
    const walkStore = new ChunkStore(seed, 0.65, buildWarpField(result.transects), new Map());
    return { result, walkStore, anchors: locations.map(location => anchorOf(result, location.id)) };
}

describe('World Map solver — land-aware layout origin', () => {
    it.each(['milestone-one', 'midway'])('lays a banded 3-place ledger out on walkable land for the ocean-centred seed %s', seed => {
        expect(store(seed).getBaseCell(CENTRE.x, CENTRE.y).biome).toBe('ocean');
        const { walkStore, anchors } = firstLayout(seed);
        for (const anchor of anchors) {
            // Base-field land: the place stands on real ground, not an islet the solve raised under it.
            expect(store(seed).getBaseCell(anchor.x, anchor.y).biome, `${seed} ${anchor.locationId}`).not.toBe('ocean');
            const others = anchors.filter(other => other !== anchor);
            const region = walkable(walkStore, anchor, others);
            expect(region.reached, `${seed} ${anchor.locationId} reaches the others on foot`).toEqual(others);
            expect(region.size, `${seed} ${anchor.locationId} region`).toBeGreaterThanOrEqual(400);
        }
    });

    it('leaves no banded 3-place first layout on an islet across a 24-seed sweep', () => {
        let oceanCentred = 0;
        const marooned = [];
        for (let index = 0; index < 24; index += 1) {
            const seed = `origin-sweep-${index}`;
            if (store(seed).getBaseCell(CENTRE.x, CENTRE.y).biome === 'ocean') oceanCentred += 1;
            const { walkStore, anchors } = firstLayout(seed);
            for (const anchor of anchors) {
                const region = walkable(walkStore, anchor, anchors.filter(other => other !== anchor));
                if (region.size < 400 || region.reached.length !== anchors.length - 1) marooned.push(`${seed}/${anchor.locationId}@${anchor.x},${anchor.y}`);
            }
        }
        expect(oceanCentred).toBeGreaterThanOrEqual(5);
        expect(marooned).toEqual([]);
    });

    it('keeps the world centre, and the exact pre-origin layout, when the centre is already land', () => {
        const seed = 'land-centred';
        expect(layoutOrigin(store(seed))).toEqual(CENTRE);
        const locations = [
            place('a', 'Ashford', [{ toId: 'b', band: 'local' }, { toId: 'c', band: 'regional' }, { toId: 'road', band: 'local' }]),
            place('b', 'Bramble', [{ toId: 'a', band: 'local' }, { toId: 'c', band: 'local' }]),
            place('c', 'Cinder', [{ toId: 'a', band: 'regional' }, { toId: 'b', band: 'local' }, { toId: 'road', band: 'local' }]),
            place('d', 'Dunmere'),
            transit('road', 'Ashford Road', [{ toId: 'a', band: 'local' }, { toId: 'c', band: 'local' }]),
            transit('lost', 'Lost Track', [{ toId: 'a', band: 'local' }]),
        ];
        // Anchors the solver produced for this input before the layout origin existed.
        const before = 'a:499,500 b:505,499 c:505,504 d:482,496 road:502,502 lost:500,500';
        const solved = result => result.anchors.map(anchor => `${anchor.locationId}:${anchor.x},${anchor.y}`).join(' ');
        expect(solved(solveWorldMap({ locations, loreChunks: [], worldSeed: seed, chunkStore: store(seed) }))).toBe(before);
        expect(solved(solveWorldMap({ locations, loreChunks: [], worldSeed: seed }))).toBe(before);
    });

    it('keeps the world centre without a chunk store, or when nothing within the cap is land', () => {
        expect(layoutOrigin(null)).toEqual(CENTRE);
        expect(layoutOrigin({ getCell: () => ({ biome: 'ocean', elevation: -0.5 }) })).toEqual(CENTRE);
        // A lone ocean cell at the centre still leaves its neighbourhood land.
        expect(layoutOrigin({ getCell: (x, y) => ({ biome: x === 500 && y === 500 ? 'ocean' : 'plains' }) })).toEqual(CENTRE);
    });

    it('moves the origin to the nearest land neighbourhood, on the lattice, for an ocean-centred stub', () => {
        // Ocean west of x = 560; land from there east.
        const origin = layoutOrigin({ getCell: x => ({ biome: x < 560 ? 'ocean' : 'plains' }) });
        expect(origin).toEqual({ x: 568, y: 500 });
    });

    it('sends an under-connected transit fallback to the origin, not the ocean centre', () => {
        const seed = 'milestone-one';
        const origin = layoutOrigin(store(seed));
        expect(origin).not.toEqual(CENTRE);
        const result = solveWorldMap({
            locations: [...banded(), transit('lost', 'Lost Track', [{ toId: 'a', band: 'local' }])],
            loreChunks: [], worldSeed: seed, chunkStore: store(seed),
        });
        const lost = result.waypoints.find(waypoint => waypoint.locationId === 'lost');
        expect(lost.fallback).toBe(true);
        expect({ x: lost.x, y: lost.y }).toEqual(origin);
    });

    it('holds the origin across re-solves: islets, placement warps and hardened cells never move it', () => {
        const seed = 'milestone-one';
        const origin = layoutOrigin(store(seed));
        const { result } = firstLayout(seed);
        // What solveAndPersist hands the next solve: saved coordinates pin the
        // first places, the previous transects bend the field, the party has
        // hardened cells, and a placement has raised land over the centre.
        const saved = banded().map(entry => ({ ...entry, coordinates: { x: anchorOf(result, entry.id).x, y: anchorOf(result, entry.id).y } }));
        const hardened = new Map();
        for (let dy = -8; dy <= 8; dy += 1) for (let dx = -8; dx <= 8; dx += 1) hardened.set(`${500 + dx}␟${500 + dy}`, 'plains');
        const centreLand = { locationId: 'poi', source: 'Point of interest biome', noiseResumeDistance: 24, coreRadius: 3,
            controlPoints: [{ kind: 'terrain', x: 500, y: 500, target: { elev: 0.2, temp: 0, moist: -0.2, geology: 0 } }] };
        const later = new ChunkStore(seed, 0.65, buildWarpField([...result.transects, centreLand]), hardened);
        const warpedView = { getCell: (x, y) => later.getCell(x, y) };
        // The test has teeth: reading the warped field would put the origin back at the centre.
        expect(layoutOrigin(warpedView)).toEqual(CENTRE);
        expect(layoutOrigin(later)).toEqual(origin);

        const newcomer = place('e', 'Eastwatch', [{ toId: 'a', band: 'local' }]);
        const locations = [...saved, newcomer];
        const again = solveWorldMap({ locations, loreChunks: [], worldSeed: seed, hardenedCells: hardened, chunkStore: later });
        const fresh = solveWorldMap({ locations, loreChunks: [], worldSeed: seed, chunkStore: store(seed) });
        const misread = solveWorldMap({ locations, loreChunks: [], worldSeed: seed, hardenedCells: hardened, chunkStore: warpedView });
        for (const entry of saved) expect(anchorOf(again, entry.id)).toMatchObject({ ...entry.coordinates, source: 'saved' });
        expect(anchorOf(again, 'e')).toEqual(anchorOf(fresh, 'e'));
        expect(anchorOf(misread, 'e')).not.toEqual(anchorOf(again, 'e'));
    });
});
