import { Router } from 'express';
import { readJson, writeJson, overworldPath } from '../lib/fileStore.js';
import { callLLMWithRetry } from '../services/llmProxy.js';
import { wrapAsync } from '../lib/asyncHandler.js';

function stripMarkdownFences(raw) {
    let s = raw.trim();
    s = s.replace(/^```(?:json)?\s*\n?/i, '');
    s = s.replace(/\n?```\s*$/i, '');
    return s;
}

export function createOverworldRouter() {
    const router = Router();

    router.get('/api/campaigns/:id/overworld', wrapAsync((req, res) => {
        const data = readJson(overworldPath(req.params.id));
        if (!data) return res.status(404).json({ error: 'No overworld map found' });
        res.json(data);
    }));

    router.put('/api/campaigns/:id/overworld', wrapAsync((req, res) => {
        writeJson(overworldPath(req.params.id), req.body);
        res.json({ ok: true });
    }));

    router.post('/api/campaigns/:id/overworld/generate', wrapAsync(async (req, res) => {
        const { lore, biomeList, llmConfig } = req.body;

        if (!llmConfig?.endpoint || !llmConfig?.model) {
            return res.status(400).json({ error: 'LLM config (endpoint, model) required' });
        }

        const prompt = `You are a world-builder reading campaign lore to place locations on a fantasy map.

CAMPAIGN LORE:
${lore || 'A generic fantasy world with no specific details.'}

AVAILABLE BIOMES (use these IDs exactly):
${biomeList || 'forest: Forest, plains: Plains, mountain: Mountain, hills: Rolling Hills, coast: Coast, deep_ocean: Deep Ocean, shallow_sea: Shallow Sea, snow_tundra: Snow Tundra, desert_dunes: Desert Dunes, swamp: Swamp, dense_forest: Dense Forest, beach: Beach, river: River, lake: Lake'}

TASK:
Extract or invent 3-8 named locations for this world.

Rules:
- If lore mentions explicit geography, use it
- If lore mentions city names or relationships (capital, port, etc.), derive positions from those
- If lore is vague or empty, invent plausible locations that fit the setting
- Capital cities: type "capital", footprint 1, position "center" unless lore says otherwise
- Port/coastal cities: tags must include "coastal", biome should be "coast" or "beach"
- Mountain strongholds: tags include "highland", biome "mountain" or "hills"

Positions use 8 directions only: center, north, south, east, west, northeast, northwest, southeast, southwest

RESPOND WITH VALID JSON ONLY. No markdown, no explanation.
{
  "world_type": "single_continent",
  "biome_zones": [
    {"biome": "biome_id", "position": "north"}
  ],
  "anchors": [
    {
      "name": "string",
      "type": "capital|city|town|dungeon|landmark|natural",
      "biome": "biome_id",
      "position": "center",
      "tags": [],
      "footprint": 0
    }
  ]
}

biome_zones: always output 5-8 of these — they paint the background terrain of the world.
anchors: named locations that appear as markers on the map, max 8.`;

        console.log('[Overworld] Sending prompt to LLM, model:', llmConfig.model, 'endpoint:', llmConfig.endpoint);

        const raw = await callLLMWithRetry(prompt, {
            endpoint: llmConfig.endpoint,
            apiKey: llmConfig.apiKey || '',
            model: llmConfig.model,
        }, {
            maxAttempts: 2,
            timeoutMs: 120000,
            jsonPattern: /\{[\s\S]*\}/,
        });

        if (!raw) {
            console.error('[Overworld] LLM returned null after retries');
            return res.status(502).json({ error: 'LLM failed to generate world data' });
        }

        console.log('[Overworld] Raw LLM response (first 500 chars):', raw.slice(0, 500));

        const cleaned = stripMarkdownFences(raw);

        let parsed;
        try {
            parsed = JSON.parse(cleaned);
        } catch (parseErr) {
            console.error('[Overworld] JSON parse failed. Cleaned response (first 500 chars):', cleaned.slice(0, 500));
            console.error('[Overworld] Parse error:', parseErr.message);
            return res.status(502).json({ error: 'LLM returned invalid JSON', detail: parseErr.message });
        }

        const validWorldTypes = ['single_continent', 'two_continents', 'archipelago', 'coastal_kingdom'];
        const worldType = validWorldTypes.includes(parsed.world_type) ? parsed.world_type : 'single_continent';

        const anchors = Array.isArray(parsed.anchors) ? parsed.anchors : [];
        if (anchors.length === 0) {
            console.warn('[Overworld] No anchors parsed, using defaults');
            anchors.push({ name: 'Capital', type: 'capital', biome: 'plains', position: 'center', tags: [], footprint: 1 });
        }
        if (anchors.length > 8) anchors.length = 8;

        for (const a of anchors) {
            a.footprint = (a.type === 'capital') ? 1 : 0;
            if (!Array.isArray(a.tags)) a.tags = [];
        }

        const biomeZones = Array.isArray(parsed.biome_zones) ? parsed.biome_zones : [];
        if (biomeZones.length === 0) {
            biomeZones.push(
                { biome: 'snow_tundra', position: 'north' },
                { biome: 'desert_dunes', position: 'southeast' },
                { biome: 'dense_forest', position: 'west' },
                { biome: 'plains', position: 'center' },
                { biome: 'swamp', position: 'southwest' },
            );
        }

        console.log('[Overworld] Successfully parsed', anchors.length, 'anchors and', biomeZones.length, 'biome zones');

        res.json({ worldType, anchors, biomeZones });
    }));

    return router;
}