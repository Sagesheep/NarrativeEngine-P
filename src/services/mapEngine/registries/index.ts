import type { BiomeDefinition } from '../../../types';
import { NATURE_BIOMES } from './nature';
import { MEDIEVAL_BIOMES } from './medieval';
import { FANTASY_BIOMES } from './fantasy';
import { URBAN_BIOMES } from './urban';
import { CYBERPUNK_BIOMES } from './cyberpunk';
import { POST_APOC_BIOMES } from './post_apoc';

export const REGISTRIES: Record<string, BiomeDefinition[]> = {
    nature: NATURE_BIOMES,
    medieval: MEDIEVAL_BIOMES,
    fantasy: FANTASY_BIOMES,
    urban: URBAN_BIOMES,
    cyberpunk: CYBERPUNK_BIOMES,
    post_apoc: POST_APOC_BIOMES,
};

export const REGISTRY_NAMES = Object.keys(REGISTRIES);
