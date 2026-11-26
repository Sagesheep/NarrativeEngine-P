import type { WorldAnchor, WorldCell, BiomeZone, WorldMap } from '../../types';
import { createNoiseGenerator } from '../../utils/noise';

const MAP_SIZE = 100;

const POSITION_COORDS: Record<string, [number, number]> = {
    center: [50, 50],
    north: [50, 15],
    south: [50, 85],
    east: [85, 50],
    west: [15, 50],
    northeast: [80, 20],
    northwest: [20, 20],
    southeast: [80, 80],
    southwest: [20, 80],
};

function isAdjacentToOcean(cells: WorldCell[], x: number, y: number, width: number): boolean {
    const neighbours = [
        [x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1],
    ];
    for (const [nx, ny] of neighbours) {
        if (nx < 0 || nx >= width || ny < 0 || ny >= MAP_SIZE) return true;
        const idx = ny * width + nx;
        if (cells[idx] && cells[idx].isOcean) return true;
    }
    return false;
}

function snapAnchorToValidLand(
    anchor: WorldAnchor,
    cells: WorldCell[],
    occupied: Set<number>,
): { x: number; y: number } {
    const [tx, ty] = POSITION_COORDS[anchor.position] || POSITION_COORDS.center;
    const maxWidth = MAP_SIZE;
    const maxHeight = MAP_SIZE;

    const isCoastal = anchor.tags.includes('coastal') || anchor.tags.includes('port');
    const isHighland = anchor.tags.includes('mountain_fortress') || anchor.tags.includes('highland');

    for (let radius = 0; radius <= 15; radius++) {
        for (let dy = -radius; dy <= radius; dy++) {
            for (let dx = -radius; dx <= radius; dx++) {
                if (Math.max(Math.abs(dx), Math.abs(dy)) !== radius && radius > 0) continue;
                const cx = tx + dx;
                const cy = ty + dy;
                if (cx < 0 || cx >= maxWidth || cy < 0 || cy >= maxHeight) continue;
                const idx = cy * maxWidth + cx;
                const cell = cells[idx];
                if (!cell || cell.isOcean) {
                    if (!isCoastal) continue;
                }
                if (occupied.has(idx)) continue;
                if (isCoastal && !isAdjacentToOcean(cells, cx, cy, maxWidth)) continue;
                if (isHighland && cell.elevation <= 0.65) continue;
                return { x: cx, y: cy };
            }
        }
    }

    return { x: tx, y: ty };
}

export function generateWorld(
    anchors: WorldAnchor[],
    biomeZones: BiomeZone[],
    seed: number,
    worldType: WorldMap['worldType'],
): WorldMap {
    const gen = createNoiseGenerator(seed);
    const gen2 = createNoiseGenerator(seed + 7777);

    const cells: WorldCell[] = [];
    const oceanThreshold = worldType === 'archipelago' ? 0.55 : 0.42;

    for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
            const nx = (x / MAP_SIZE) * 3.5;
            const ny = (y / MAP_SIZE) * 3.5;
            const e = gen.fbm(nx, ny, 4, 2.0, 0.5);
            let elevation = (e + 1) / 2;

            if (worldType === 'two_continents') {
                const bandDist = Math.abs(x - 50) / 50;
                if (bandDist < 0.15) {
                    elevation = Math.min(elevation, elevation * (bandDist / 0.15) * 0.5);
                }
                const e2 = gen2.fbm(nx + 5, ny + 5, 4, 2.0, 0.5);
                const elev2 = (e2 + 1) / 2;
                const blend = Math.exp(-0.5 * Math.pow((x - 75) / 20, 2));
                elevation = elevation * (1 - blend * 0.7) + elev2 * blend * 0.7;
            }

            if (worldType === 'coastal_kingdom') {
                if (y > 65) {
                    const oceanFactor = (y - 65) / 35;
                    elevation -= oceanFactor * 0.35;
                }
            }

            elevation = Math.max(0, Math.min(1, elevation));
            const isOcean = elevation < oceanThreshold;

            cells.push({
                x,
                y,
                biome: isOcean ? 'deep_ocean' : 'plains',
                elevation,
                isOcean,
                anchorName: null,
            });
        }
    }

    const sortedAnchors = [...anchors].sort((a, b) => b.footprint - a.footprint);
    const occupied = new Set<number>();
    const snappedAnchors: { anchor: WorldAnchor; x: number; y: number }[] = [];

    for (const anchor of sortedAnchors) {
        const pos = snapAnchorToValidLand(anchor, cells, occupied);
        const idx = pos.y * MAP_SIZE + pos.x;
        occupied.add(idx);
        snappedAnchors.push({ anchor, x: pos.x, y: pos.y });
    }

    type VoronoiSeed = { x: number; y: number; biome: string; isAnchor: boolean; anchorName?: string };
    const seeds: VoronoiSeed[] = [];

    for (const bz of biomeZones) {
        const coords = POSITION_COORDS[bz.position] || POSITION_COORDS.center;
        seeds.push({ x: coords[0], y: coords[1], biome: bz.biome, isAnchor: false });
    }

    for (const sa of snappedAnchors) {
        seeds.push({ x: sa.x, y: sa.y, biome: sa.anchor.biome, isAnchor: true, anchorName: sa.anchor.name });
    }

    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (cell.isOcean) continue;

        let nearestSeed: VoronoiSeed | null = null;
        let nearestDist = Infinity;

        for (const seed of seeds) {
            const dx = cell.x - seed.x;
            const dy = cell.y - seed.y;
            const dist = dx * dx + dy * dy;
            if (dist < nearestDist) {
                nearestDist = dist;
                nearestSeed = seed;
            }
        }

        if (nearestSeed) {
            cell.biome = nearestSeed.biome;
        }
    }

    for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (cell.isOcean) continue;

        if (cell.elevation > 0.82) {
            cell.biome = 'mountain';
        } else if (cell.elevation > 0.68) {
            const sa = snappedAnchors.find(a => a.x === cell.x && a.y === cell.y);
            if (!sa || sa.anchor.biome !== 'mountain') {
                cell.biome = 'hills';
            }
        }

        if (isAdjacentToOcean(cells, cell.x, cell.y, MAP_SIZE)) {
            cell.biome = 'coast';
        } else if (cell.elevation < 0.44 && !cell.isOcean) {
            cell.biome = cell.elevation < 0.38 ? 'swamp' : 'plains';
        }
    }

    for (const sa of snappedAnchors) {
        if (sa.anchor.footprint >= 1) {
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    const cx = sa.x + dx;
                    const cy = sa.y + dy;
                    if (cx < 0 || cx >= MAP_SIZE || cy < 0 || cy >= MAP_SIZE) continue;
                    const idx = cy * MAP_SIZE + cx;
                    if (cells[idx].isOcean) {
                        cells[idx].isOcean = false;
                        cells[idx].elevation = Math.max(cells[idx].elevation, 0.45);
                    }
                    cells[idx].biome = sa.anchor.biome;
                }
            }
        }
        const centerIdx = sa.y * MAP_SIZE + sa.x;
        cells[centerIdx].anchorName = sa.anchor.name;
    }

    return {
        width: MAP_SIZE,
        height: MAP_SIZE,
        cells,
        anchors: snappedAnchors.map(sa => sa.anchor),
        biomeZones,
        seed,
        worldType,
        generatedAt: Date.now(),
        pins: [],
    };
}