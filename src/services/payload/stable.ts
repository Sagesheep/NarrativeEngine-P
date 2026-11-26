import type { AppSettings, GameContext, LoreChunk } from '../../types';
import { countTokens } from '../infrastructure/tokenizer';
import { DEFAULT_RULES } from '../rules/defaultRules';
import type { TraceCollector } from './traceCollector';
import { renderPrompt } from '../prompts/promptRegistry';
import { defaultPromptText } from '../prompts/promptCatalog';

// Thinking-mode detector. Resolves the story level in the same order as the
// role getters (see store/slices/slotThinking.ts): the active preset's Story
// slot level first, then the story provider's deprecated provider-wide
// `thinkingEffort`, then the legacy inline `storyAI` field. Returns true when
// that level is anything other than 'off' (or unset). This replaces the
// previous brittle regex over model names (`/deepseek-r|qwq|qwen.*think|r1/i`)
// — every frontier model in 2026 (GPT-5.x, Claude 4.x, Gemini 2.5, DeepSeek-R)
// supports thinking via a request param, so the Story slot's Thinking picker in
// the Presets tab is the single source of truth. Reading the stored provider
// alone would desync from what the request actually sends, because that value
// no longer has a picker. Exported so payloadBuilder.ts can gate the per-turn
// CoT invocation line on the same test without re-implementing the resolution.
export function isThinkingEnabled(settings: AppSettings): boolean {
    const activePreset = settings.presets?.find((p) => p.id === settings.activePresetId);
    const storyProviderId: string | undefined = activePreset?.storyAIProviderId;
    const storyProvider = storyProviderId ? settings.providers?.find((p) => p.id === storyProviderId) : undefined;
    const effort = activePreset?.slotThinking?.story
        ?? storyProvider?.thinkingEffort
        ?? activePreset?.storyAI?.thinkingEffort;
    return effort !== undefined && effort !== 'off';
}

// [FABLE-AUTHORED] — block labels verified against world.ts / volatile.ts:
//   [ACTIVE NPC CONTEXT] (world.ts:387), [FACTS KNOWN TO ON-STAGE CHARACTERS] (world.ts:439),
//   [DICE OUTCOMES: ...] (engineRolls.ts:194 — emitted as a user-message prefix, stripped by history.ts),
//   [LOCATION] (volatile.ts:189). [DIRECTOR BRIEF] does not exist yet — left verbatim per spec
//   (Director Brief service lands in WO-04); the conditional "if present" wording keeps it forward-compatible.
//
// Phrasing is model-agnostic ("internal reasoning, not shown to the player")
// so the framework works for any provider: DeepSeek emits it in `reasoning_content`,
// Claude in `thinking` blocks, GPT-5 in `reasoning` tokens, Gemini in `thinking_config`
// parts, and legacy non-thinking models reason silently before the narrative.
export const SCENE_STAKES_INSTRUCTION = defaultPromptText('turn.scene-stakes-tag');


export function buildStable(opts: {
    settings: AppSettings;
    context: GameContext;
    relevantRules?: LoreChunk[];
    rulesManifest?: string;
    rulesBudget: number;
    budgetStable: number;
    collector: TraceCollector;
}): { stableContent: string; stableTokens: number; retrievedRulesContent?: string } {
    const { settings, context, relevantRules, rulesManifest, rulesBudget, budgetStable, collector } = opts;

    const stableParts: string[] = [];
    let retrievedRulesContent: string | undefined;

    // Inject either selected Rules RAG chunks or complete raw rules.
    // RAG-retrieved rules are DYNAMIC (re-selected per turn by semantic match to user input),
    // so they MUST ride in the volatile block below the cache boundary — putting them in
    // stable busts the prefix cache every turn. Only the verbatim full-rules fallback is
    // stable (it's byte-identical across turns). Mirrors mobileApp payloadStableContent.ts.
    //
    // The user's custom Action Resolution rules are NEVER overwritten — die-type guidance
    // lives in the roll_dice tool description (toolHandlers.ts). This fixes the issue where
    // enabling the dice tool silently nuked non-d20 campaign rules.
    const effectiveRules = context.rulesRaw || DEFAULT_RULES;

    const hasRulesRAG = (context.rulesChunks?.length ?? 0) > 0;
    if (hasRulesRAG && relevantRules && relevantRules.length > 0) {
        let rulesTokens = 0;
        const acceptedChunks: LoreChunk[] = [];
        for (const chunk of relevantRules) {
            if (rulesTokens + chunk.tokens <= rulesBudget) {
                acceptedChunks.push(chunk);
                rulesTokens += chunk.tokens;
            }
        }
        const chunksText = acceptedChunks.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
        let ragText = `## RULES\n\n${chunksText}`;
        if (rulesManifest) {
            ragText += `\n\n${rulesManifest}`;
        }
        retrievedRulesContent = ragText;
        collector.addTrace({ source: 'RAG Rules', classification: 'volatile_state', tokens: rulesTokens, reason: `RAG injected (${acceptedChunks.length} chunks) — volatile (per-turn selection)`, included: true, position: 'system_dynamic' });
    } else {
        const rulesText = effectiveRules;
        stableParts.push(rulesText);
        collector.addTrace({ source: 'Raw Rules', classification: 'stable_truth', tokens: countTokens(rulesText), reason: 'Complete rules list (RAG not loaded or below threshold)', included: true, position: 'system_static' });
    }

    if (context.canonStateActive && context.canonState) {
        stableParts.push(context.canonState);
    }
    if (context.headerIndexActive && context.headerIndex) stableParts.push(context.headerIndex);
    if (context.starterActive && context.starter) stableParts.push(context.starter);
    if (context.continuePromptActive && context.continuePrompt) stableParts.push(context.continuePrompt);

    // The scene-stakes tag (ported from mobile's stable content). The engine strips it and
    // stores it on the swipe variant (sceneStakesTag.ts); agency reads it. Desktop never asked
    // for it — 0 tags in ~1,200 archived scenes — so the fallback classifier ran before every
    // Send. The classifier stays as the fallback for a reply that omits the tag.
    stableParts.push(renderPrompt('turn.scene-stakes-tag'));

    // Only inject when the active preset's Story slot has thinking enabled (any
    // effort level except 'off'). The Story slot's Thinking picker is the single
    // source of truth — model-name guessing is gone.
    if (isThinkingEnabled(settings)) {
        stableParts.push(renderPrompt('turn.thinking-reminder'));
        stableParts.push(renderPrompt('turn.writer-reasoning'));
    }

    const stableContent = stableParts.join('\n\n');
    const stableTokens = countTokens(stableContent);
    // Stable holds essential, non-droppable campaign state (rules already capped by rulesBudget; canon,
    // header, starter cause amnesia if silently truncated mid-turn). Rather than drop it, surface a
    // budget-overrun warning in the trace so an oversized preamble is visible in debug mode.
    if (budgetStable > 0 && stableTokens > budgetStable) {
        collector.addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: `Over stable budget (${stableTokens} t > ${budgetStable} t) — kept (essential state, not trimmable)`, included: true, position: 'system_static', preview: stableContent });
    }
    collector.addTrace({ source: 'Stable Preamble', classification: 'stable_truth', tokens: stableTokens, reason: 'Preamble & Core state', included: true, position: 'system_static', preview: stableContent });
    collector.addSection({ label: 'Stable Preamble', role: 'system', tokens: stableTokens, content: stableContent, classification: 'stable_truth' });

    return { stableContent, stableTokens, retrievedRulesContent };
}