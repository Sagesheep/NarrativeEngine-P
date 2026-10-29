import type { LLMProvider, SceneStakes, EndpointConfig, ProviderConfig, SamplingConfig } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessage } from '../chatEngine';
import { sanitizePayloadForApi } from '../lib/payloadSanitizer';
import { extractAndStripSceneStakes } from './sceneStakesTag';
import { getToolDefinitions } from './toolHandlers';
import { resolveToolHandler } from './toolRegistry';

// ── Constants ──────────────────────────────────────────────────────────
export const MAX_CONTINUE_TOOL_CALLS = 3;
export const SCENE_CONTINUE_DIVIDER = '\n\n---\n\n';

// ── Types ──────────────────────────────────────────────────────────────

export interface SceneContinueOptions {
    provider: LLMProvider | EndpointConfig | ProviderConfig;
    /** Snapshot path: getCachedSwipePayload(). Fallback path: freshly built payload (§6). */
    basePayload: OpenAIMessage[];
    /** Current merged text of the visible variant — read from pendingMsg.content LIVE at click time.
     *  Null in fallback mode (reply already inside basePayload history). */
    assistantText: string | null;
    directive: string;
    modelName?: string;
    temperature: number;             // active preset base temperature — NO swipe offset
    allowDiceTool: boolean;          // context.diceFairnessActive === false (same gate as normal turns)
    combatModeActive: boolean;       // passed through to getToolDefinitions
    abortSignal?: AbortSignal;
}

export interface SceneContinueResult {
    /** Continuation text only (NOT merged): scene header stripped, stakes tag stripped. */
    text: string;
    /** Stakes parsed from the continuation, null if no tag was present. */
    stakes: SceneStakes | null;
}

// ── stripLLMSceneHeader (mirror of turnOrchestrator's inline helper) ────
const stripLLMSceneHeader = (text: string): string =>
    text.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

// ── Directive builder ───────────────────────────────────────────────────
// VERBATIM per §7 of the workorder. Do not rewrite, do not "improve".
export function buildSceneContinueDirective(opts: {
    pcName: string;          // context.characterProfileData?.name ?? '' — empty is a NORMAL case
    targetWords: number;     // word count of the LAST segment only (§4 rule R6)
    allowDiceTool: boolean;
}): string {
    const { pcName, targetWords, allowDiceTool } = opts;

    // Target 70–100% of the last segment's length — no ceiling; the continuation
    // should match the passage it extends. The 120-word floor guards the death
    // spiral where a short (or meta-junk) segment begets an even shorter target.
    const upper = Math.max(120, targetWords);
    const lower = Math.max(120, Math.round(targetWords * 0.7));
    const lengthLine = lower >= upper
        ? `- Write roughly ${upper} words of new story.`
        : `- Write between ${lower} and ${upper} words of new story — comparable to the passage you are extending.`;

    const pcLine = pcName.trim()
        ? `- The player character is ${pcName}. Do not act, speak, or decide for ${pcName} beyond what their last input already committed to. End your reply at the point where ${pcName} would next need to choose or respond — a story beat that invites a response, never an explicit prompt for input.`
        : `- Do not act, speak, or decide for the player's character beyond what their last input already committed to. End your reply at the point where the player would next need to choose or respond — a story beat that invites a response, never an explicit prompt for input.`;

    const diceLine = allowDiceTool
        ? `- If the action already in motion genuinely requires a roll, you may call roll_dice; otherwise do not roll. Never invent dice results.`
        : `- Do not initiate or invent dice rolls; narrate only from results already in history.`;

    return [
        '[SCENE CONTINUE — the player pressed Continue: they want MORE of the current scene. This is not a new turn and not a new scene.',
        '- Write the next passage of the story: new in-fiction narrative prose that moves the current beat forward.',
        '- Pick up exactly where your previous reply ended — same scene, same moment, mid-beat. Do not restart, re-describe, or summarize anything that already happened.',
        '- NEVER write meta commentary. Nothing about the story being paused, frozen, or awaiting input; no "your move", "your call", or "what happens next" prompts. If your previous reply ended in meta text like that, ignore that ending entirely and resume the fiction from the last in-fiction moment.',
        '- Everyone and everything EXCEPT the player character may act: NPCs speak and move, the environment shifts, tension builds — the moment keeps unfolding in real time.',
        '- Do not open a new scene, skip time, change location, or introduce new arrivals, random events, or encounters. Deepen and extend only what is already present in the scene.',
        pcLine,
        lengthLine,
        '- Do not emit a Scene header.',
        diceLine,
        '- Reply with story prose only — do not acknowledge, mention, or answer this instruction.]',
    ].join('\n');
}

// ── Request assembly (exported for testing) ─────────────────────────────
// Sanitize the base payload, then append the assistant message (snapshot path
// only — null in fallback) and the directive as a USER message (skipped when
// empty). The directive must be user-role, not system: the Claude/Gemini format
// converters (llmApiHelper transformClaudeMessages/transformGeminiMessages)
// hoist EVERY system message into the top-level system block, which teleports
// a trailing system directive to the top of the payload — the model then sees
// the sequence ending user→assistant and re-answers the last user message.
// A user-role directive survives every converter and ends the sequence on the
// natural "respond to this" turn. NEVER mutates basePayload — always spreads.
export function buildSceneContinueRequest(opts: {
    basePayload: OpenAIMessage[];
    assistantText: string | null;
    directive: string;
    allowDiceTool: boolean;
    modelName?: string;
}): OpenAIMessage[] {
    const sanitized = sanitizePayloadForApi([...opts.basePayload], opts.allowDiceTool, opts.modelName);
    const request: OpenAIMessage[] = [...sanitized];
    if (opts.assistantText !== null) {
        request.push({ role: 'assistant', content: opts.assistantText });
    }
    if (opts.directive.trim() !== '') {
        request.push({ role: 'user', content: opts.directive });
    }
    return request;
}

// ── Last-segment word-count helper (exported for testing) ──────────────
// R6: target the LAST segment only, so repeated continues don't inflate each other.
export function computeLastSegmentWordCount(content: string): number {
    const parts = content.split(SCENE_CONTINUE_DIVIDER);
    const last = parts[parts.length - 1] ?? '';
    return last.trim().split(/\s+/).filter(Boolean).length;
}

// ── Continue-merged view helper (exported for testing) ─────────────────
export function buildMergedContinueView(preContinueContent: string, partial: string): string {
    if (!preContinueContent) return partial;
    return `${preContinueContent}${SCENE_CONTINUE_DIVIDER}${partial}`;
}

// ── Filter to only the roll_dice tool definition ───────────────────────
// The spec: when allowDiceTool, pass ONLY roll_dice (not lore/notebook/inventory).
function getRollDiceToolOnly(): unknown[] {
    return getToolDefinitions({ allowDiceTool: true })
        .filter((t): t is { type: 'function'; function: { name: string } } =>
            !!t && typeof t === 'object' && 'function' in (t as object) &&
            (t as { function: { name: string } }).function?.name === 'roll_dice');
}

// ── Post-process the final continuation text ───────────────────────────
// R7: strip scene header, then strip stakes. Stakes is null when no tag was present.
function postProcessContinuation(text: string): SceneContinueResult {
    const headerStripped = stripLLMSceneHeader(text);
    const { displayText, stakes } = extractAndStripSceneStakes(headerStripped);
    const tagPresent = headerStripped !== displayText || stakes !== 'calm';
    return { text: displayText, stakes: tagPresent ? stakes : null };
}

// ── generateSceneContinuation ──────────────────────────────────────────
// Mirrors generateSwipeVariant's structure (sanitize → sendMessage → strip → resolve),
// with the additions of: (1) assistant message + directive appended to the payload,
// (2) optional roll_dice mini tool loop (transient — nothing written to store/history),
// (3) reasoning_content discarded (R4).
export function generateSceneContinuation(
    opts: SceneContinueOptions,
    onChunk: (partialText: string) => void,   // continuation text only — caller does the merge
): Promise<SceneContinueResult> {
    const { provider, basePayload, assistantText, directive, modelName, temperature, allowDiceTool, abortSignal } = opts;

    const tools = allowDiceTool ? getRollDiceToolOnly() : undefined;
    const sampling: SamplingConfig = { temperature };

    // Build the initial request payload (snapshot path appends assistant + system; fallback skips).
    const requestPayload: OpenAIMessage[] = buildSceneContinueRequest({
        basePayload,
        assistantText,
        directive,
        allowDiceTool,
        modelName,
    });

    // Accumulated text across tool-call continuations (mirrors orchestrator's accumulatedContent).
    let accumulatedContent = '';

    const executeOnce = (currentPayload: OpenAIMessage[], toolCallCount: number): Promise<SceneContinueResult> => {
        if (abortSignal?.aborted) {
            return Promise.reject(new DOMException('Aborted', 'AbortError'));
        }

        return new Promise<SceneContinueResult>((resolve, reject) => {
            const controller = new AbortController();
            if (abortSignal) {
                if (abortSignal.aborted) {
                    reject(new DOMException('Aborted', 'AbortError'));
                    return;
                }
                abortSignal.addEventListener('abort', () => controller.abort(), { once: true });
            }

            // Only offer tools when allowed AND under the cap.
            const sendTools = allowDiceTool && toolCallCount < MAX_CONTINUE_TOOL_CALLS ? tools : undefined;

            sendMessage(
                provider,
                currentPayload,
                (chunk) => {
                    // chunk is cumulative FROM THIS SEND. Merge with prior accumulated content
                    // (tool-call preamble) so the caller's merged view shows the full continuation.
                    const merged = accumulatedContent
                        ? `${accumulatedContent}\n\n${chunk}`
                        : chunk;
                    onChunk(merged);
                },
                (finalText, toolCall) => {
                    // R4: discard reasoning_content on the continuation (param omitted).

                    // Cap reached OR no tool call OR unknown tool → treat as final.
                    const noTool = !toolCall;
                    const capReached = toolCallCount >= MAX_CONTINUE_TOOL_CALLS;
                    const handler = toolCall ? resolveToolHandler(toolCall.name) : null;
                    if (noTool || capReached || !handler) {
                        const finalAccumulated = accumulatedContent
                            ? `${accumulatedContent}\n\n${finalText}`
                            : finalText;
                        resolve(postProcessContinuation(finalAccumulated));
                        return;
                    }

                    // roll_dice handler is pure (dice + string). Continue has no lore/notebook
                    // context — pass empty/undefined. diceSystem is not surfaced here (the spec
                    // gates tools by diceFairnessActive only); the handler still returns a raw
                    // result, just without tier mapping.
                    try {
                        const dispatchResult = handler({
                            arguments: toolCall.arguments,
                            loreChunks: [],
                            notebook: [],
                            diceSystem: undefined,
                        });

                        // Accumulate the pre-tool-call text (mirrors orchestrator's append mode).
                        accumulatedContent = accumulatedContent
                            ? `${accumulatedContent}\n\n${finalText}`
                            : finalText;
                        onChunk(accumulatedContent);

                        // Append the assistant tool-call message + tool result message to the
                        // REQUEST payload (transient — nothing written to store/history).
                        // We're mutating currentPayload, which is our local requestPayload array
                        // (built fresh in this function) — basePayload is untouched.
                        currentPayload.push({
                            role: 'assistant',
                            content: finalText || '',
                            tool_calls: [{
                                id: toolCall.id,
                                type: 'function' as const,
                                function: { name: toolCall.name, arguments: toolCall.arguments },
                            }],
                        } as OpenAIMessage);
                        currentPayload.push({
                            role: 'tool',
                            content: dispatchResult.toolResult,
                            name: toolCall.name,
                            tool_call_id: toolCall.id,
                        } as OpenAIMessage);

                        // Re-send with the tool result folded in. Loop back to the same promise chain.
                        executeOnce(currentPayload, toolCallCount + 1).then(resolve, reject);
                    } catch {
                        // Handler threw — treat the current text as final.
                        const finalAccumulated = accumulatedContent
                            ? `${accumulatedContent}\n\n${finalText}`
                            : finalText;
                        resolve(postProcessContinuation(finalAccumulated));
                    }
                },
                (err) => {
                    if (err === '__ABORT__' || err === 'AbortError' || err === 'The user aborted a request.') {
                        reject(new DOMException('Aborted', 'AbortError'));
                        return;
                    }
                    reject(new Error(err));
                },
                sendTools,
                controller,
                sampling,
                undefined,                       // thinkingEffort — pass undefined (locked decision)
                'scene-continue',                // trackingLabel
            );
        });
    };

    return executeOnce(requestPayload, 0);
}