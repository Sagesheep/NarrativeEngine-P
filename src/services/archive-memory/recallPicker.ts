import type { EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';

/**
 * The recall picker: a small model reads the one-line definitions of the engine's
 * best candidates and picks which scenes the GM needs now. Its picks go first, so
 * its top pick is the one recalled in full. It replaces the Archive Planner, which
 * read event logs for the whole archive and only nudged the keyword score: on the
 * Turn Prep probes its picks never changed which scenes reached the writer.
 */

/** How many engine candidates the picker reads (about 1,200 words of definitions). */
export const PICKER_CANDIDATES = 30;
export const PICKER_MAX_PICKS = 5;
/** The turn waits for the picker; past this it goes ahead in the engine's order. */
export const PICKER_TIMEOUT_MS = 5000;
/** How much of the GM's last reply the picker sees, from its end. */
const LAST_REPLY_CHARS = 1200;

export type PickerCandidate = { sceneId: string; line: string };

export function buildRecallPickerPrompt(userMessage: string, lastReply: string, candidates: readonly PickerCandidate[]): string {
    const reply = lastReply.length > LAST_REPLY_CHARS ? `…${lastReply.slice(-LAST_REPLY_CHARS)}` : lastReply;
    return `You choose which past scenes a game master should be reminded of before writing the next turn of a roleplay story.

THE GM'S LAST REPLY (end of it):
"""
${reply || '(none)'}
"""

WHAT THE PLAYER DOES NOW:
"""
${userMessage}
"""

PAST SCENES:
${candidates.map((c, i) => `[${i + 1}] ${c.line}`).join('\n')}

Pick the scenes the GM needs to write the next reply well: a scene the player refers to, earlier dealings with the people involved now, and promises, debts, secrets or facts that matter in this moment. Ignore scenes that only share a word or a place.
Put the most needed scene first. Pick at most ${PICKER_MAX_PICKS}. If none are needed, answer [].

Respond with a JSON array of scene numbers only, for example [4, 1]. No prose, no backticks.`;
}

/** Scene ids for the numbers the model gave: valid, unique, best first, capped. */
export function parseRecallPicks(raw: unknown, candidates: readonly PickerCandidate[]): string[] | null {
    if (!Array.isArray(raw)) return null;
    const picks: string[] = [];
    for (const value of raw) {
        const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value.replace(/[^\d]/g, '')) : NaN;
        const candidate = Number.isInteger(n) ? candidates[n - 1] : undefined;
        if (candidate && !picks.includes(candidate.sceneId)) picks.push(candidate.sceneId);
        if (picks.length === PICKER_MAX_PICKS) break;
    }
    return picks;
}

/**
 * Returns the picked scene ids, best first; [] when the model says none are needed;
 * null when the call failed, timed out or answered nonsense (the caller then keeps
 * the engine's order).
 */
export async function runRecallPicker(params: {
    userMessage: string;
    lastReply: string;
    candidates: readonly PickerCandidate[];
    provider?: EndpointConfig | ProviderConfig;
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>;
    timeoutMs?: number;
}): Promise<string[] | null> {
    const { userMessage, lastReply, candidates, provider, modelCall } = params;
    if (candidates.length === 0 || (!provider && !modelCall)) return null;
    const timeoutMs = params.timeoutMs ?? PICKER_TIMEOUT_MS;
    const prompt = buildRecallPickerPrompt(userMessage, lastReply, candidates);
    const controller = new AbortController();
    // Thinking off: a short list of numbers. A thinking endpoint left at its own effort
    // can spend the whole budget reasoning and return nothing.
    const request = { temperature: 0, priority: 'high' as const, maxTokens: 60, thinkingEffort: 'off' as const, signal: controller.signal, trackingLabel: 'recall-picker', timeoutMs };

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            console.warn(`[RecallPicker] No answer within ${timeoutMs} ms; keeping the engine's order.`);
            resolve(null);
        }, timeoutMs);
    });
    const call = (async () => {
        try {
            const raw = modelCall ? (await modelCall({ prompt, ...request })).content : await llmCall(provider!, prompt, request);
            const { value, parseOk } = extractJsonRobust<unknown>(raw, null);
            const picks = parseOk ? parseRecallPicks(value, candidates) : null;
            if (picks) console.log(`[RecallPicker] Picked [${picks.join(', ')}] from ${candidates.length} candidates.`);
            return picks;
        } catch (err) {
            if (!controller.signal.aborted) console.warn('[RecallPicker] Picker failed:', err);
            return null;
        }
    })();
    try {
        return await Promise.race([call, timeout]);
    } finally {
        clearTimeout(timer);
    }
}

/**
 * The final recall order: the picker's picks first, then everything the engine
 * recalled on its own. Picks are added, never swapped in: a pick pushing out an
 * engine hit lost a right scene on the Turn Prep probes (P5s), and an extra
 * scene costs only a ~45-token brief line.
 */
export function applyRecallPicks(engineIds: readonly string[], picks: readonly string[]): string[] {
    const picked = new Set(picks);
    return [...picks, ...engineIds.filter(id => !picked.has(id))];
}
