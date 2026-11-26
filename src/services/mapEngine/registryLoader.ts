import type { BiomeDefinition } from '../../types';
import { REGISTRIES } from './registries';

export function loadRegistries(names: string[]): BiomeDefinition[] {
    const merged: BiomeDefinition[] = [];
    const seen = new Set<string>();

    for (const name of names) {
        const biomes = REGISTRIES[name];
        if (!biomes) {
            console.warn(`[RegistryLoader] Unknown registry: "${name}", skipping`);
            continue;
        }
        for (const b of biomes) {
            if (seen.has(b.id)) {
                throw new Error(`[RegistryLoader] Duplicate biome ID "${b.id}" across registries`);
            }
            seen.add(b.id);
            merged.push(b);
        }
    }

    return merged;
}

export function getBiomeColorMap(biomes: BiomeDefinition[]): Record<string, string> {
    const map: Record<string, string> = {};
    for (const b of biomes) {
        map[b.id] = b.color;
    }
    return map;
}

export function getBiomeById(biomes: BiomeDefinition[], id: string): BiomeDefinition | undefined {
    return biomes.find(b => b.id === id);
}
