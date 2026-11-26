import type { SceneStakes, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { recordSceneStakesFallback } from './sceneStakesTelemetry';
import { ENGINE_CALL_TIMEOUT_MS } from '../llm/timeouts';

// Phase 2 port: mobile used a shared infrastructure/utilityPrompts module for these constant
// sections; desktop has no equivalent shared module. Inlined here (small + only used by this
// helper) — a future refactor can lift them to a shared utilityPrompts module if more callers
// need them.
const TTRPG_PERSONA_STATE_ANALYZER = 'You are a background game state analyzer.';
const JSON_ONLY_FOOTER = 'Respond with ONE JSON object only. No prose, no markdown fences.';
const ANCHOR_BEFORE_INPUT = 'Now produce the JSON described above for the INPUT below.';
const INPUT_DELIMITER = '----- INPUT -----';

function joinPromptSections(...sections: Array<string | null | undefined>): string {
    return sections.filter(Boolean).join('\n\n');
}

const SCENE_STAKES_RE = /\[\[SCENE_STAKES:\s*(calm|tense|dangerous)\s*\]\]/i;
const SCENE_STAKES_ANY_RE = /\[\[SCENE_STAKES:\s*\S+\s*\]\]/i;
const VALID_STAKES: Set<string> = new Set(['calm', 'tense', 'dangerous']);

export function extractAndStripSceneStakes(text: string): { displayText: string; stakes: SceneStakes } {
    const match = text.match(SCENE_STAKES_RE);
    if (!match) {
        const garbled = text.match(SCENE_STAKES_ANY_RE);
        if (garbled) {
            const displayText = text.replace(SCENE_STAKES_ANY_RE, '').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
            return { displayText, stakes: 'calm' };
        }
        return { displayText: text, stakes: 'calm' };
    }
    const raw = match[1].toLowerCase();
    const stakes: SceneStakes = VALID_STAKES.has(raw) ? (raw as SceneStakes) : 'calm';
    const displayText = text.replace(SCENE_STAKES_RE, '').replace(/ +$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
    return { displayText, stakes };
}

export async function classifySceneStakes(
    provider: EndpointConfig | ProviderConfig | undefined,
    recentScene: string,
    modelCall?: (prompt: string, options: {
        priority: 'low';
        maxTokens: number;
        thinkingEffort: 'off';
        trackingLabel: string;
        timeoutMs: number;
    }) => Promise<string>,
): Promise<SceneStakes> {
    const prompt = joinPromptSections(
        TTRPG_PERSONA_STATE_ANALYZER,
        'TASK: Classify the scene stakes as one of: calm, tense, dangerous.\n' +
        'calm = no immediate threat; tense = physical OR social/political threat looming;\n' +
        'dangerous = active harm or imminent deadly/ruinous consequences.',
        JSON_ONLY_FOOTER,
        'Output ONLY: {"stakes":"calm"} or {"stakes":"tense"} or {"stakes":"dangerous"}',
        ANCHOR_BEFORE_INPUT,
        INPUT_DELIMITER,
        recentScene.slice(0, 3000),
    );

    recordSceneStakesFallback();

    try {
        const raw = modelCall
            ? await modelCall(prompt, { priority: 'low', maxTokens: 20, thinkingEffort: 'off', trackingLabel: 'scene-stakes-classify', timeoutMs: ENGINE_CALL_TIMEOUT_MS })
            : provider
                ? await llmCall(provider, prompt, {
                    priority: 'low',
                    maxTokens: 20,
                    thinkingEffort: 'off',
                    trackingLabel: 'scene-stakes-classify',
                    timeoutMs: ENGINE_CALL_TIMEOUT_MS,
                })
                : null;
        if (raw === null) return 'calm';
        const cleaned = raw.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        const parsed = JSON.parse(cleaned);
        const s = String(parsed.stakes ?? '').toLowerCase();
        if (VALID_STAKES.has(s)) return s as SceneStakes;
    } catch { /* malformed → calm */ }
    return 'calm';
}