import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { DISTANCE_BANDS as CORE_DISTANCE_BANDS } from '../../location/distance';
import {
    DISTANCE_BANDS,
    parseLocationHeaderName,
    parseNeighborClause,
    solveWorldMap,
} from '../../../../public/bundled-mods/worldmap/solver.js';

function location(id, name, connections = []) {
    return { id, name, aliases: '', connections };
}

function lore(locationName, content) {
    return {
        id: `lore-${locationName}`,
        header: `LOCATION -- ${locationName}`,
        content,
        category: 'location',
    };
}

function anchorById(result, id) {
    return result.anchors.find(anchor => anchor.locationId === id);
}

function gridDistance(left, right) {
    return Math.hypot(right.x - left.x, right.y - left.y);
}

describe('World Map bundled mod — closed grammar', () => {
    it('keeps its runtime distance rows locked to the core vocabulary', () => {
        expect(DISTANCE_BANDS).toEqual(CORE_DISTANCE_BANDS.map(({ id, minGrids, maxGrids }) => ({ id, minGrids, maxGrids })));
    });

    it('keeps terrain, slope, and road shapes distinct and compiles compounds as transects', () => {
        const terrain = parseNeighborClause('S: tundra close').clause;
        const slopeCompound = parseNeighborClause('W: mountain cliff to ocean, 0').clause;
        const road = parseNeighborClause('E: road to Ravenhold far').clause;

        expect(terrain.kind).toBe('transect');
        expect(terrain.parts).toEqual([{ kind: 'terrain', terrain: 'tundra' }]);
        expect(slopeCompound.parts).toEqual([
            { kind: 'terrain', terrain: 'mountain' },
            { kind: 'slope', slope: 'cliff' },
            { kind: 'terrain', terrain: 'ocean' },
        ]);
        expect(slopeCompound.controlPoints).toHaveLength(3);
        expect(slopeCompound.controlPoints.map(point => point.kind)).toEqual(['terrain', 'slope', 'terrain']);
        expect(road).toMatchObject({ kind: 'road', targetName: 'Ravenhold', band: 'far' });
        expect(road.controlPoints).toBeUndefined();
    });

    it('drops and reports an unknown token without guessing', () => {
        const parsed = parseNeighborClause('N: ashfall close', { locationId: 'v', locationName: 'Veythar' });
        expect(parsed.clause).toBeNull();
        expect(parsed.warnings).toHaveLength(1);
        expect(parsed.warnings[0].message).toBe('unknown terrain token "ashfall" — clause dropped');
    });
});

describe('World Map bundled mod — anchor solve', () => {
    it('places every Tier 0 ledger entry with finite, unique coordinates', () => {
        const locations = [
            location('a', 'Ashfen', [{ toId: 'b', band: 'local' }]),
            location('b', 'Briarwatch', [{ toId: 'a', band: 'local' }, { toId: 'c', band: 'far' }]),
            location('c', 'Cinderkeep', [{ toId: 'b', band: 'far' }]),
            location('d', 'Dunmere'),
        ];
        const result = solveWorldMap({ locations, loreChunks: [], worldSeed: 'tier-zero' });

        expect(result.anchors).toHaveLength(locations.length);
        expect(result.anchors.every(anchor => Number.isFinite(anchor.x) && Number.isFinite(anchor.y))).toBe(true);
        expect(new Set(result.anchors.map(anchor => `${anchor.x},${anchor.y}`)).size).toBe(locations.length);
        expect(result.report.placed).toBe(locations.length);
    });

    it('places every Aethelgard location from the shipped compendium at Tier 0', () => {
        const markdown = readFileSync(
            'Example_Setup/World_compendium/Original World/Aethelgard - Medieval Fire Emblem Fantasy/world_lore_aethelgard.md',
            'utf8',
        );
        const locations = [...markdown.matchAll(/^### LOCATION\s*(?:--|—|–)\s*(.+)$/gm)]
            .map((match, index) => {
                const name = parseLocationHeaderName(`LOCATION -- ${match[1]}`).name;
                return location(`aethelgard-${index}`, name);
            });
        const result = solveWorldMap({ locations, loreChunks: [], worldSeed: 'aethelgard-tier-zero' });

        expect(locations).toHaveLength(7);
        expect(result.anchors).toHaveLength(7);
        expect(new Set(result.anchors.map(anchor => `${anchor.x},${anchor.y}`)).size).toBe(7);
        expect(Math.max(...result.anchors.map(anchor => anchor.x)) - Math.min(...result.anchors.map(anchor => anchor.x))).toBeGreaterThan(10);
    });

    it('is byte-identical for the same lore and seed', () => {
        const input = {
            locations: [
                location('f', 'Frosthold', [{ toId: 't', band: 'regional' }]),
                location('t', 'Thornkeep', [{ toId: 'f', band: 'regional' }]),
            ],
            loreChunks: [lore('Frosthold', '**Neighbors:** W mountain-cliff-to-ocean 0 | S tundra-pasture close')],
            worldSeed: 'repeatable-seed',
        };
        const first = solveWorldMap(input);
        const second = solveWorldMap(input);
        expect(JSON.stringify(first.anchors)).toBe(JSON.stringify(second.anchors));
    });

    it('resolves a regional spring inside 7–15 grids', () => {
        const result = solveWorldMap({
            locations: [
                location('a', 'A', [{ toId: 'b', band: 'regional' }]),
                location('b', 'B', [{ toId: 'a', band: 'regional' }]),
            ],
            loreChunks: [],
            worldSeed: 'regional-band',
        });
        const distance = gridDistance(anchorById(result, 'a'), anchorById(result, 'b'));
        expect(distance).toBeGreaterThanOrEqual(7);
        expect(distance).toBeLessThanOrEqual(15);
        expect(result.report.relaxations).toHaveLength(0);
    });

    it('relaxes a soft spring against hard pins and reports the dropped spring', () => {
        const result = solveWorldMap({
            locations: [
                location('a', 'Ashfen', [{ toId: 'b', band: 'local' }]),
                location('b', 'Thornkeep', [{ toId: 'a', band: 'local' }]),
            ],
            loreChunks: [
                lore('Ashfen', '**Coords:** 100,100'),
                lore('Thornkeep', '**Coords:** 140,100'),
            ],
            worldSeed: 'soft-versus-hard',
        });
        expect(result.report.relaxations).toHaveLength(1);
        expect(result.report.relaxations[0].message).toContain('relaxed');
        expect(result.report.refusals).toHaveLength(0);
        expect(anchorById(result, 'a')).toMatchObject({ x: 100, y: 100, pinned: true, source: 'player' });
        expect(anchorById(result, 'b')).toMatchObject({ x: 140, y: 100, pinned: true, source: 'player' });
    });

    it('refuses a hard distance-zero road that conflicts with two hard pins', () => {
        const result = solveWorldMap({
            locations: [location('r', 'Ravenhold'), location('i', 'Ironhold')],
            loreChunks: [
                lore('Ravenhold', '**Coords:** 100,100\n**Neighbors:** E road to Ironhold 0'),
                lore('Ironhold', '**Coords:** 140,100'),
            ],
            worldSeed: 'hard-refusal',
        });
        expect(result.report.refusals).toHaveLength(1);
        expect(result.report.refusals[0].message).toContain('Accept it, or re-describe one?');
        expect(result.report.relaxations).toHaveLength(0);
        expect(result.report.text).toContain('✗ Ravenhold/Ironhold');
    });

    it('moves the anchor opposite an authored ray and emits absolute control points in that direction', () => {
        const base = solveWorldMap({ locations: [location('f', 'Frosthold')], loreChunks: [], worldSeed: 'ray' });
        const constrained = solveWorldMap({
            locations: [location('f', 'Frosthold')],
            loreChunks: [lore('Frosthold', '**Neighbors:** E mountain close')],
            worldSeed: 'ray',
        });
        expect(anchorById(constrained, 'f').x).toBeLessThan(anchorById(base, 'f').x);
        expect(constrained.transects[0].controlPoints[0].x).toBeGreaterThan(anchorById(constrained, 'f').x);
    });
});
