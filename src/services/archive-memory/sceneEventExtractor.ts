import type { EndpointConfig, ProviderConfig, SceneEvent, SceneEventType } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';

/**
 * `modelCall` is the host-facade path the post-turn pipeline uses; `provider`
 * is the direct path. With neither, there is nothing to call and no events.
 */
export async function extractSceneEvents(
    provider: EndpointConfig | ProviderConfig | undefined,
    sceneText: string,
    signal?: AbortSignal,
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<SceneEvent[]> {
    const prompt = `You are a TTRPG campaign archivist. Analyze the following scene text and extract structured events that occurred in this scene.

SCENE TEXT:
"""
${sceneText}
"""

OUTPUT FORMAT — respond with a single JSON array of scene event objects (max 3 events, or empty array [] if no significant events occurred):
[
  {
    "eventType": "combat", 
    "importance": 7,
    "text": "Evocative summary of the event in one short sentence.",
    "characters": ["Aldric", "Tav"],
    "locations": ["Baldur's Gate"],
    "items": ["Leather chestpiece"],
    "concepts": ["Betrayal", "Trade"],
    "cause": "Why this event happened (optional plain-text clause)",
    "result": "Immediate consequence of this event (optional plain-text clause)"
  }
]

RULES:
1. eventType MUST be exactly one of: 'combat' | 'discovery' | 'item_acquired' | 'item_lost' | 'relationship_shift' | 'travel' | 'promise' | 'betrayal' | 'death' | 'revelation' | 'quest_milestone' | 'other'
2. importance must be an integer from 1 to 10.
3. text must be a short, clean, descriptive sentence (max 15 words) of what happened.
4. characters, locations, items, concepts are optional string arrays listing specific entities present or involved.
5. cause and result are optional short plain-text consequence beats (one short clause each).
6. Cap at MAXIMUM 3 events for the scene. If nothing highly meaningful occurred, return an empty array [].

Respond with a JSON array only. No markdown formatting, no prose, no reasoning tags, no backticks.`;

    // Thinking off: a short JSON answer. A thinking endpoint left at its own effort
    // can spend the whole 1000-token budget reasoning and return nothing.
    const request = {
        temperature: 0.1,
        priority: 'low' as const,
        maxTokens: 1000,
        thinkingEffort: 'off' as const,
        signal,
        trackingLabel: 'scene-event-extract',
        timeoutMs: AI_CALL_TIMEOUT_MS,
    };
    try {
        const raw = modelCall
            ? (await modelCall({ prompt, ...request })).content
            : provider
                ? await llmCall(provider, prompt, request)
                : '';

        const { value: parsed, parseOk } = extractJsonRobust<unknown[]>(raw, []);
        if (!parseOk || !Array.isArray(parsed)) return [];

        const VALID_EVENT_TYPES = new Set<string>([
            'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
            'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other'
        ]);

        const validEvents: SceneEvent[] = [];
        for (const rawEv of parsed) {
            if (!rawEv || typeof rawEv !== 'object') continue;
            const ev = rawEv as Record<string, unknown>;
            if (typeof ev.text !== 'string' || !ev.text.trim()) continue;
            if (typeof ev.importance !== 'number') continue;

            const eventType: SceneEventType = VALID_EVENT_TYPES.has(ev.eventType as string)
                ? (ev.eventType as SceneEventType)
                : 'other';

            const importance = Math.min(10, Math.max(1, Math.round(ev.importance)));

            const event: SceneEvent = {
                eventType,
                importance,
                text: ev.text.trim(),
            };

            if (Array.isArray(ev.characters) && ev.characters.length > 0) {
                event.characters = ev.characters.filter((v: unknown): v is string => typeof v === 'string');
            }
            if (Array.isArray(ev.locations) && ev.locations.length > 0) {
                event.locations = ev.locations.filter((v: unknown): v is string => typeof v === 'string');
            }
            if (Array.isArray(ev.items) && ev.items.length > 0) {
                event.items = ev.items.filter((v: unknown): v is string => typeof v === 'string');
            }
            if (Array.isArray(ev.concepts) && ev.concepts.length > 0) {
                event.concepts = ev.concepts.filter((v: unknown): v is string => typeof v === 'string');
            }
            if (typeof ev.cause === 'string' && ev.cause.trim()) {
                event.cause = ev.cause.trim();
            }
            if (typeof ev.result === 'string' && ev.result.trim()) {
                event.result = ev.result.trim();
            }

            validEvents.push(event);
        }

        return validEvents;
    } catch (err) {
        console.warn('[SceneEventExtractor] Event extraction failed:', err);
        return [];
    }
}
