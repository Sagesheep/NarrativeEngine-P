import type { WorldMap, WorldAnchor, BiomeZone } from '../../types';
import { loadRegistries } from './registryLoader';
import { generateWorld } from './worldGenerator';
import { API_BASE as API } from '../../lib/apiBase';

const REGISTRY_KEYWORDS: Record<string, string[]> = {
    nature: ['nature', 'forest', 'river', 'mountain', 'plains'],
    medieval: ['medieval', 'middle ages', 'feudal', 'kingdom', 'knight', 'sword'],
    fantasy: ['fantasy', 'magic', 'dragon', 'elf', 'dwarf', 'wizard', 'sorcery', 'd&d', 'dnd'],
    urban: ['urban', 'modern', 'city', 'contemporary', 'street'],
    cyberpunk: ['cyberpunk', 'cyber', 'neon', 'mega', 'corp', 'netrunner', 'shadowrun'],
    post_apoc: ['post-apoc', 'apocalypse', 'wasteland', 'mutant', 'fallout', 'nuclear', 'zombie'],
};

export function determineRegistries(lore: string): string[] {
    const lower = lore.toLowerCase();
    const matched = new Set<string>(['nature']);

    for (const [registry, keywords] of Object.entries(REGISTRY_KEYWORDS)) {
        if (keywords.some(kw => lower.includes(kw))) {
            matched.add(registry);
        }
    }

    if (matched.size === 1) {
        matched.add('medieval');
    }

    return Array.from(matched);
}

export async function generateWorldMap(
    campaignId: string,
    lore: string,
    llmConfig: { endpoint: string; apiKey: string; model: string },
): Promise<WorldMap> {
    const registries = determineRegistries(lore);
    const biomes = loadRegistries(registries);
    const seed = Date.now();

    const biomeList = biomes.map(b => `${b.id}: ${b.label} (${b.registry})`).join('\n');

    const res = await fetch(`${API}/campaigns/${campaignId}/overworld/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            lore,
            biomeList,
            llmConfig: {
                endpoint: llmConfig.endpoint,
                apiKey: llmConfig.apiKey,
                model: llmConfig.model,
            },
        }),
    });

    if (!res.ok) {
        const err = await res.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error(err.error || `Generate failed (${res.status})`);
    }

    const data = await res.json() as { worldType: WorldMap['worldType']; anchors: WorldAnchor[]; biomeZones: BiomeZone[] };

    const map = generateWorld(data.anchors, data.biomeZones, seed, data.worldType);

    await fetch(`${API}/campaigns/${campaignId}/overworld`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(map),
    });

    return map;
}

export async function loadWorld(campaignId: string): Promise<WorldMap | null> {
    const res = await fetch(`${API}/campaigns/${campaignId}/overworld`);
    if (!res.ok) return null;

    const map: WorldMap = await res.json();
    return map;
}