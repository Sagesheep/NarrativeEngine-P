import type { EndpointConfig, ProviderConfig, SceneEvent, SceneEventType, SceneHook, SceneTags } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';
import { parseSceneHooks, parseSceneTags, renderSceneTagList } from './sceneTags';
import { renderPrompt } from '../prompts/promptRegistry';

export type SceneAnalysis = {
    events: SceneEvent[];
    tags: SceneTags;
    hooks: SceneHook[];
    resolvedHookIds: string[];
    /** Undefined when the model gave none or one too short to use. */
    definition?: string;
};

const MAX_OPEN_HOOKS_SHOWN = 12;
const DEFINITION_MIN_WORDS = 5;
const DEFINITION_MAX_WORDS = 60;

/** A definition the search and the recall block can use: one line, 5-60 words. */
export function parseSceneDefinition(raw: unknown): string | undefined {
    if (typeof raw !== 'string') return undefined;
    const words = raw.replace(/^["'\s]+|["'\s]+$/g, '').split(/\s+/).filter(Boolean);
    if (words.length < DEFINITION_MIN_WORDS) return undefined;
    return words.slice(0, DEFINITION_MAX_WORDS).join(' ');
}

const VALID_EVENT_TYPES = new Set<string>([
    'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
    'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
]);

function parseSceneEvents(raw: unknown): SceneEvent[] {
    if (!Array.isArray(raw)) return [];
    const validEvents: SceneEvent[] = [];
    for (const rawEv of raw) {
        if (!rawEv || typeof rawEv !== 'object') continue;
        const ev = rawEv as Record<string, unknown>;
        if (typeof ev.text !== 'string' || !ev.text.trim()) continue;
        if (typeof ev.importance !== 'number') continue;

        const eventType: SceneEventType = VALID_EVENT_TYPES.has(ev.eventType as string)
            ? (ev.eventType as SceneEventType)
            : 'other';
        const importance = Math.min(10, Math.max(1, Math.round(ev.importance)));
        const event: SceneEvent = { eventType, importance, text: ev.text.trim() };

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
        if (typeof ev.cause === 'string' && ev.cause.trim()) event.cause = ev.cause.trim();
        if (typeof ev.result === 'string' && ev.result.trim()) event.result = ev.result.trim();

        validEvents.push(event);
    }
    return validEvents;
}

function buildPrompt(sceneText: string, shownHooks: readonly SceneHook[]): string {
    const hookList = shownHooks.length > 0
        ? `\nOPEN STORY HOOKS FROM EARLIER SCENES:\n${shownHooks.map(h => `- ${h.id} [${h.type}] with ${h.with.join(', ') || 'no one named'}: ${h.what}`).join('\n')}\n`
        : '';
    return renderPrompt('memory.scene-events', { sceneText, openHooks: hookList, tagList: renderSceneTagList() });
}

/**
 * Definition, events, tags and hooks for one scene, in one call. Returns null when the call or
 * its answer failed, so callers can tell "nothing to record" from "try again later".
 * `modelCall` is the host-facade path the post-turn pipeline uses; `provider` is the
 * direct path. With neither, there is nothing to call.
 */
export async function analyzeScene(
    provider: EndpointConfig | ProviderConfig | undefined,
    sceneText: string,
    sceneId: string,
    options: { signal?: AbortSignal; modelCall?: (request: ModelRequest) => Promise<ModelResponse>; openHooks?: readonly SceneHook[] } = {},
): Promise<SceneAnalysis | null> {
    const { signal, modelCall } = options;
    if (!provider && !modelCall) return null;
    const shownHooks = (options.openHooks ?? []).slice(-MAX_OPEN_HOOKS_SHOWN);
    const prompt = buildPrompt(sceneText, shownHooks);

    // Thinking off: a short JSON answer. A thinking endpoint left at its own effort
    // can spend the whole token budget reasoning and return nothing.
    const request = {
        temperature: 0.1,
        priority: 'low' as const,
        // Room for five longer events in a language that costs more tokens per word.
        maxTokens: 2000,
        thinkingEffort: 'off' as const,
        signal,
        trackingLabel: 'scene-event-extract',
        timeoutMs: AI_CALL_TIMEOUT_MS,
    };
    try {
        const raw = modelCall
            ? (await modelCall({ prompt, ...request })).content
            : await llmCall(provider!, prompt, request);

        const { value: parsed, parseOk } = extractJsonRobust<unknown>(raw, null);
        if (!parseOk || !parsed || typeof parsed !== 'object') return null;

        // A model may still answer with the events array alone.
        if (Array.isArray(parsed)) return { events: parseSceneEvents(parsed), tags: {}, hooks: [], resolvedHookIds: [] };

        const answer = parsed as Record<string, unknown>;
        const shownIds = new Set(shownHooks.map(h => h.id));
        return {
            events: parseSceneEvents(answer.events),
            tags: parseSceneTags(answer.tags),
            hooks: parseSceneHooks(answer.hooks, sceneId),
            resolvedHookIds: Array.isArray(answer.resolvedHooks)
                ? answer.resolvedHooks.filter((id): id is string => typeof id === 'string' && shownIds.has(id))
                : [],
            definition: parseSceneDefinition(answer.definition),
        };
    } catch (err) {
        console.warn('[SceneEventExtractor] Scene analysis failed:', err);
        return null;
    }
}
