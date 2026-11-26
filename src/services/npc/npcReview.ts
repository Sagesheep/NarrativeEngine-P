import type { NPCEntry, EndpointConfig, ProviderConfig } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { extractJsonRobust } from '../infrastructure/jsonExtract';

export type NPCReviewCandidate = {
    id: string;
    name: string;
    reason: string;
};

export type NPCReviewCancelled = { cancelled: boolean };

export type NPCReviewResult = {
    candidates: NPCReviewCandidate[];
    failedBatches: number;
};

const BATCH_SIZE = 40;

function shorten(s: string | undefined, max = 80): string {
    if (!s) return '';
    const t = s.replace(/\s+/g, ' ').trim();
    return t.length > max ? t.slice(0, max) + '…' : t;
}

const INPUT_DELIMITER = '----- INPUT -----';
const JSON_ONLY_FOOTER = 'Respond with ONE JSON object only. No prose, no markdown fences.';
const ANCHOR_BEFORE_INPUT = 'Now produce the JSON described above for the INPUT below.';
const TTRPG_PERSONA_ARCHIVIST = 'You are a TTRPG campaign archivist.';

function joinPromptSections(...sections: Array<string | null | undefined>): string {
    return sections
        .filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        .map(s => s.trim())
        .join('\n\n');
}

/**
 * AI triage pass over an NPC ledger. Flags entries that are NOT distinct named
 * characters — generic roles/crowds ("a guard", "townsfolk"), objects, places,
 * concepts, or garbled fragments that were mis-captured as NPCs. Never deletes
 * or mutates anything: it only returns candidates for the user to review and
 * decide on. Mirrors the runFactDedup orchestration (batched, cancellable,
 * progress-reporting) so it can drive a review modal the same way.
 */
export async function runNPCReview(
    npcs: NPCEntry[],
    utilityProvider: EndpointConfig | ProviderConfig,
    cancel: NPCReviewCancelled,
    onProgress: (msg: string, done: number, total: number) => void,
): Promise<NPCReviewResult> {
    const eligible = npcs.filter(n => n.name?.trim() && !n.isPC);
    if (eligible.length === 0) return { candidates: [], failedBatches: 0 };

    const batches: NPCEntry[][] = [];
    for (let i = 0; i < eligible.length; i += BATCH_SIZE) {
        batches.push(eligible.slice(i, i + BATCH_SIZE));
    }

    const candidates: NPCReviewCandidate[] = [];
    let failedBatches = 0;

    for (let b = 0; b < batches.length; b++) {
        if (cancel.cancelled) throw new Error('NPC review cancelled.');

        const batch = batches[b];
        onProgress(`Reviewing ${b * BATCH_SIZE + 1}–${b * BATCH_SIZE + batch.length} / ${eligible.length} NPCs`, b, batches.length);

        const idSet = new Set(batch.map(n => n.id));
        const lines = batch
            .map(n => `${n.id} | ${n.name}${n.faction ? ` | ${n.faction}` : ''}${n.storyRelevance ? ` | ${shorten(n.storyRelevance)}` : ''}`)
            .join('\n');

        const prompt = joinPromptSections(
            TTRPG_PERSONA_ARCHIVIST,

            `You are auditing an NPC ledger from a tabletop RPG campaign. Some rows are NOT real, distinct named characters — they were mistakenly captured by the auto-detector. Flag rows that are clearly one of:
- Generic roles or crowds with no proper name ("a guard", "the bartender", "townsfolk", "soldiers", "a voice")
- Objects, locations, factions, or concepts ("the gate", "Ironwall Keep", "the prophecy")
- Garbled fragments, pronouns, or partial text ("he", "the man who", "...")

DO NOT flag anything that is or plausibly could be a specific named individual, even if minor. When unsure, leave it unflagged.

Schema (do not copy example values):
{"notNpc":[{"id":"<row_id>","reason":"<3-6 words why>"}]}

If every row is a valid character, return {"notNpc":[]} exactly.`,

            JSON_ONLY_FOOTER,
            ANCHOR_BEFORE_INPUT,
            INPUT_DELIMITER,

            `NPC LEDGER ROWS (id | name | faction | relevance):\n${lines}`,
        );

        let raw: string;
        try {
            raw = await llmCall(utilityProvider, prompt, {
                temperature: 0.1,
                maxTokens: 2048,
                trackingLabel: 'npc-review',
                timeoutMs: 24 * 60 * 60 * 1000,
            });
        } catch (err) {
            console.warn(`[NPCReview] LLM call failed for batch ${b + 1}:`, err);
            failedBatches++;
            continue;
        }

        if (cancel.cancelled) throw new Error('NPC review cancelled.');

        const { value: parsed, parseOk } = extractJsonRobust<{ notNpc: Array<{ id: string; reason?: string }> }>(
            raw,
            { notNpc: [] },
        );

        if (!parseOk || !Array.isArray(parsed.notNpc)) {
            console.warn('[NPCReview] Bad response for batch', b + 1, raw);
            failedBatches++;
            continue;
        }

        for (const flag of parsed.notNpc) {
            if (!flag || typeof flag.id !== 'string' || !idSet.has(flag.id)) continue;
            const npc = batch.find(n => n.id === flag.id);
            if (!npc) continue;
            candidates.push({
                id: npc.id,
                name: npc.name,
                reason: shorten(flag.reason, 60) || 'not a named character',
            });
        }
    }

    onProgress(`Done — ${candidates.length} flagged`, batches.length, batches.length);
    return { candidates, failedBatches };
}
