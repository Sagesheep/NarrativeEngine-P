import type { SceneStakes, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { recordSceneStakesFallback } from './sceneStakesTelemetry';
import { ENGINE_CALL_TIMEOUT_MS } from '../llm/timeouts';
import { renderPrompt } from '../prompts/promptRegistry';

// The classifier's instruction sections (persona, task, JSON footer, input delimiter) live in
// the prompt catalog as `turn.scene-stakes-classify`, so a campaign can rewrite them.
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
    // Instructions (persona through input delimiter) are the overridable prompt; the scene follows.
    const prompt = joinPromptSections(
        renderPrompt('turn.scene-stakes-classify'),
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