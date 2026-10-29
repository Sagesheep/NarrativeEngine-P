import type { NPCEntry } from '../../types';
import { extractJsonRobust } from '../infrastructure/jsonExtract';
import { AI_CALL_TIMEOUT_MS } from '../llm/timeouts';
import type { ModelRequest, ModelResponse } from '../turn/hostFacade';
import { npcIdentityKeys } from './relationResolve';
import { createWitnessResolver } from './witnessResolve';
import { parsePresentHeader, resolvePresentNpcs } from './presentHeader';

/**
 * Who witnessed a scene — the desktop port of mobile's witness stage
 * (`mobileApp/src/services/turn/postTurn/witnessStage.ts`). Archive witness lists
 * decide what each NPC may know (knowledge limits) and label recalled scenes.
 *
 * At append the server lists only who SPOKE or was addressed
 * (`extractWitnessesHeuristic`), so a silent bystander is missing. The fix,
 * in mobile's order:
 *   1. the GM's own `👥` field, when the reply has one (free, every tier);
 *   2. otherwise, on Max, a model reads the reply and names who was physically
 *      present (`witnessAux`);
 *   3. otherwise the server's list stands.
 * Steps 1 and 2 replace the server's list rather than add to it (see witnessesFromHeader).
 */

/** The `👥` field's witnesses (ledger NPCs it names), or `null` when the reply has no
 *  `👥` field. The field is trusted as written, as mobile does. The server's list is not
 *  merged in: it counts any `[**Name**]` followed by text as a speaker, and GMs that bold
 *  every name in brackets turn that into "everyone mentioned" (scene 577 listed Therese,
 *  who only signed a letter lying on the table). */
export function witnessesFromHeader(gmText: string, ledger: readonly NPCEntry[]): string[] | null {
    const names = parsePresentHeader(gmText);
    if (names === null) return null;
    return resolvePresentNpcs(names, ledger).map(npc => npc.name);
}

// Name words that say nothing about who someone is ("The Broker", "Lady Soll").
const NON_NAME_WORDS = new Set(['the', 'lady', 'lord', 'sir', 'master', 'mistress', 'captain', 'old', 'young', 'madam', 'mister', 'doctor', 'dr', 'mr', 'mrs', 'ms']);
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Ledger NPCs the reply names in any form (full name, alias, or a capitalised name
 *  word such as "Rin" for "Rin Holmes"); only they can be on the model's list.
 *  Over-inclusion is harmless — the model decides who was present. */
export function mentionedNpcs(gmText: string, ledger: readonly NPCEntry[]): NPCEntry[] {
    const text = gmText.toLowerCase();
    return ledger.filter(npc => {
        if (typeof npc.name !== 'string' || npc.name.trim() === '') return false;
        if (npcIdentityKeys(npc).some(key => key.length >= 3 && text.includes(key))) return true;
        return npc.name.split(/\s+/).some(word => word.length >= 3 && /^\p{Lu}/u.test(word)
            && !NON_NAME_WORDS.has(word.toLowerCase())
            && new RegExp(`(?<![\\p{L}])${escapeRegex(word)}(?![\\p{L}])`, 'u').test(gmText));
    });
}

/** Ask a model which of the named NPCs were physically present. Thinking off: a short JSON answer. */
export async function witnessesFromModel(
    gmText: string,
    ledger: readonly NPCEntry[],
    modelCall: (request: ModelRequest) => Promise<ModelResponse>,
): Promise<NPCEntry[]> {
    const candidates = mentionedNpcs(gmText, ledger);
    if (candidates.length === 0) return [];
    const roster = candidates.map(npc => `- ${npc.name}${npc.aliases ? ` (aka ${npc.aliases})` : ''}`).join('\n');
    const prompt = `You are a TTRPG campaign archivist. Read the GM narration and decide which of the listed characters were PHYSICALLY PRESENT in the scene: there in person, able to see or hear what happened. Someone only mentioned, remembered, talked about, or heard of is NOT present.

CHARACTERS NAMED IN THE SCENE:
${roster}

GM NARRATION:
"""
${gmText.slice(0, 4000)}
"""

Respond with a JSON array of the present characters' names exactly as listed, e.g. ["Rin Holmes"]. If none of them were present, respond with []. JSON only, no prose.`;
    try {
        const response = await modelCall({
            prompt,
            temperature: 0.1,
            priority: 'low',
            maxTokens: 300,
            thinkingEffort: 'off',
            trackingLabel: 'witness-capture',
            timeoutMs: AI_CALL_TIMEOUT_MS,
        });
        const { value, parseOk } = extractJsonRobust<unknown[]>(response.content, []);
        if (!parseOk || !Array.isArray(value)) return [];
        const resolve = createWitnessResolver(candidates);
        const present: NPCEntry[] = [];
        for (const item of value) {
            if (typeof item !== 'string') continue;
            for (const npc of resolve(item)) if (!present.includes(npc)) present.push(npc);
        }
        return present;
    } catch (err) {
        console.warn('[WitnessCapture] Model call failed:', err);
        return [];
    }
}
