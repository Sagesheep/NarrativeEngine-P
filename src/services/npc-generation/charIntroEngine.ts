import type { GameContext, CharacterIntroEntry, ChatMessage, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';

export type CharIntroResult = {
    tag: string;
    newDC: number;
};

const LOCATION_PROMPT = `Based on the following scene, what is the party's current location? Reply with only the location name, nothing else.`;

function extractLocationFromResponse(response: string): string {
    const cleaned = response.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
    return cleaned;
}

async function resolveLocation(
    messages: ChatMessage[],
    provider: EndpointConfig | ProviderConfig | undefined,
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<string> {
    const recent = messages.slice(-10);
    const excerpt = recent.map(m => {
        const role = m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
        return `[${role}]: ${(m.content || '').slice(0, 400)}`;
    }).join('\n\n');

    try {
        const prompt = `${LOCATION_PROMPT}\n\n${excerpt}`;
        const raw = modelCall
            ? (await modelCall({ prompt, temperature: 0.1, priority: 'high', maxTokens: 60, thinkingEffort: 'off' })).content
            : provider
                ? await llmCall(provider, prompt, { temperature: 0.1, priority: 'high', maxTokens: 60, thinkingEffort: 'off' })
                : '';
        return extractLocationFromResponse(raw);
    } catch (err) {
        console.warn('[CharIntroEngine] Location AI call failed:', err);
        return '';
    }
}

function scanBoostKeywords(
    characters: CharacterIntroEntry[],
    messages: ChatMessage[]
): Map<string, number> {
    const weights = new Map<string, number>();
    const recentAssistant = messages
        .filter(m => m.role === 'assistant')
        .slice(-3)
        .map(m => (m.content || '').toLowerCase());

    for (const entry of characters) {
        if (!entry.boostKeywords || entry.boostKeywords.length === 0) {
            weights.set(entry.name, 1);
            continue;
        }
        let boosted = false;
        for (const kw of entry.boostKeywords) {
            const kwLower = kw.toLowerCase();
            for (const text of recentAssistant) {
                if (text.includes(kwLower)) {
                    boosted = true;
                    break;
                }
            }
            if (boosted) break;
        }
        weights.set(entry.name, boosted ? 3 : 1);
    }
    return weights;
}

function weightedRandomPick(entries: CharacterIntroEntry[], weights: Map<string, number>): CharacterIntroEntry | null {
    const totalWeight = entries.reduce((sum, e) => sum + (weights.get(e.name) ?? 1), 0);
    let roll = Math.random() * totalWeight;
    for (const entry of entries) {
        const w = weights.get(entry.name) ?? 1;
        roll -= w;
        if (roll <= 0) return entry;
    }
    return entries[entries.length - 1] ?? null;
}

export async function rollCharacterIntroEngine(
    context: GameContext,
    seenNpcNames: Set<string>,
    messages: ChatMessage[],
    utilityProvider?: EndpointConfig | ProviderConfig,
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<CharIntroResult> {
    const config = context.npcIntroConfig;
    if (!config || config.characters.length === 0 || context.npcIntroEngineActive === false) {
        return { tag: '', newDC: context.npcIntroDC ?? config?.initialDC ?? 20 };
    }

    const currentDC = context.npcIntroDC ?? config.initialDC;
    const roll = Math.floor(Math.random() * 20) + 1;
    
    if (roll < currentDC) {
        const decayed = Math.max(5, currentDC - config.dcReduction);
        return { tag: '', newDC: decayed };
    }

    const candidates = config.characters.filter(c => !seenNpcNames.has(c.name.toLowerCase()));
    if (candidates.length === 0) {
        return { tag: '', newDC: currentDC };
    }

    const wanderingPool = candidates.filter(c => c.type === 'wandering');
    let locationPool = candidates.filter(c => c.type === 'location');

    if (locationPool.length > 0 && (utilityProvider || modelCall)) {
        const aiLocation = await resolveLocation(messages, utilityProvider, modelCall);
        if (aiLocation) {
            const aiLocLower = aiLocation.toLowerCase();
            locationPool = locationPool.filter(c =>
                c.location && aiLocLower.includes(c.location.toLowerCase())
            );
        } else {
            locationPool = [];
        }
    } else if (locationPool.length > 0 && !utilityProvider && !modelCall) {
        locationPool = [];
    }

    const pool = [...wanderingPool, ...locationPool];
    if (pool.length === 0) {
        return { tag: '', newDC: currentDC };
    }

    const weights = scanBoostKeywords(pool, messages);
    const picked = weightedRandomPick(pool, weights);
    if (!picked) {
        return { tag: '', newDC: currentDC };
    }

    const tag = `[INTRODUCE CHARACTER: ${picked.name}]`;
    const resetDC = config.initialDC;

    return { tag, newDC: resetDC };
}
