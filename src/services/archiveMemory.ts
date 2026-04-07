import type { ArchiveIndexEntry, ArchiveScene, ChatMessage, NPCEntry } from '../types';
import { countTokens } from './tokenizer';

/**
 * archiveMemory.ts
 *
 * T4 Memory — Index-based retrieval over lossless .archive.md content.
 *
 * Uses 3D scoring: recency bonus + intrinsic importance + keyword activation strength.
 */

// ─── 3D Scoring ───

function scoreEntry(
    entry: ArchiveIndexEntry,
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number
): number {
    // D1: Recency bonus (always positive, logarithmic — never zero)
    const sceneNum = parseInt(entry.sceneId, 10) || 0;
    const turnsSince = totalScenes - sceneNum;
    const recencyBonus = 1 / (1 + Math.log(1 + Math.max(0, turnsSince)));

    // D2: Intrinsic importance (permanent, no decay)
    const importance = entry.importance ?? 5;

    // D3: Activation strength (keyword strength matrix dot product)
    let activation = 0;
    const kwStrengths = entry.keywordStrengths ?? {};
    for (const [keyword, strength] of Object.entries(kwStrengths)) {
        if (contextActivations[keyword]) {
            activation += contextActivations[keyword] * strength;
        }
    }
    const npcStrengths = entry.npcStrengths ?? {};
    for (const [npc, strength] of Object.entries(npcStrengths)) {
        if (contextActivations[npc]) {
            activation += contextActivations[npc] * strength * 1.5;
        }
    }

    // Fallback: legacy keyword matching for old entries without strengths
    if (Object.keys(kwStrengths).length === 0 && Object.keys(npcStrengths).length === 0) {
        for (const kw of entry.keywords) {
            if (contextText.includes(kw)) {
                const exactMatch = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                activation += exactMatch.test(contextText) ? 2 : 0.5;
            }
        }
        for (const npc of entry.npcsMentioned) {
            if (contextText.includes(npc.toLowerCase())) activation += 3;
        }
    }

    // Weighted additive: (0.5 × recency) + (1.0 × importance) + (2.0 × activation)
    return (0.5 * recencyBonus) + (1.0 * importance) + (2.0 * activation);
}

/**
 * Extract graded context activations from the current conversation.
 * Returns a map of keyword -> activation weight (0-1).
 * User message = 1.0, last 3 assistant messages = 0.7, last 10 messages = 0.3.
 */
export function extractContextActivations(
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[]
): Record<string, number> {
    const activations: Record<string, number> = {};

    // 2-char minimum to capture short NPC names common in fantasy settings (e.g. "Xi", "Ka", "Al")
    const userWords = userMessage.toLowerCase().match(/[a-z]{2,}/g) || [];
    for (const word of userWords) activations[word] = 1.0;

    const userProperNouns = userMessage.match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
    for (const noun of userProperNouns) activations[noun.toLowerCase()] = 1.0;

    const last3 = recentMessages.filter(m => m.role === 'assistant').slice(-3);
    for (const msg of last3) {
        const words = (msg.content || '').toLowerCase().match(/[a-z]{2,}/g) || [];
        const properNouns = (msg.content || '').match(/[A-Z][A-Za-z]{1,}(?:\s[A-Z][A-Za-z]{1,})*/g) || [];
        for (const word of words) { if (!activations[word]) activations[word] = 0.7; }
        for (const noun of properNouns) { if (!activations[noun.toLowerCase()]) activations[noun.toLowerCase()] = 0.7; }
    }

    const last10 = recentMessages.slice(-10);
    for (const msg of last10) {
        const words = (msg.content || '').toLowerCase().match(/[a-z]{2,}/g) || [];
        for (const word of words) { if (!activations[word]) activations[word] = 0.3; }
    }

    if (npcLedger) {
        for (const npc of npcLedger) {
            activations[npc.name.toLowerCase()] = 1.0;
            if (npc.aliases) {
                for (const alias of npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
                    activations[alias] = 1.0;
                }
            }
        }
    }

    return activations;
}

/**
 * Expand context activations using semantic fact relationships.
 * If context mentions "Malachar" and a fact says "X killed_by Malachar",
 * then "x" also gets activated (weaker weight).
 */
export function expandActivationsWithFacts(
    activations: Record<string, number>,
    facts?: { subject: string; predicate: string; object: string; importance: number }[]
): Record<string, number> {
    if (!facts || facts.length === 0) return activations;

    const expanded = { ...activations };

    for (const fact of facts) {
        const sLower = fact.subject.toLowerCase();
        const oLower = fact.object.toLowerCase();
        if (expanded[sLower] && !expanded[oLower]) {
            expanded[oLower] = expanded[sLower] * 0.5;
        }
        if (expanded[oLower] && !expanded[sLower]) {
            expanded[sLower] = expanded[oLower] * 0.5;
        }
    }

    return expanded;
}

/**
 * Search the archive index using 3D scoring, return matching scene IDs
 * ranked by score (best first).
 */
export function retrieveArchiveMemory(
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    npcLedger?: NPCEntry[],
    maxScenes?: number,
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[],
    sceneRanges?: [string, string][]
): string[] {
    if (!index || index.length === 0) {
        console.log('[Archive Retrieval] Index is empty — no recall.');
        return [];
    }

    const contextText = [
        userMessage,
        ...recentMessages.slice(-3).map(m => m.content || '')
    ].join('\n').toLowerCase();

    let contextActivations = extractContextActivations(userMessage, recentMessages, npcLedger);
    contextActivations = expandActivationsWithFacts(contextActivations, semanticFacts);

    // NEW: Filter index to only scenes within provided scene ranges (if any)
    let scopedIndex = index;
    if (sceneRanges && sceneRanges.length > 0) {
        scopedIndex = index.filter(entry => {
            const sceneNum = parseInt(entry.sceneId, 10);
            return sceneRanges.some(([start, end]) => {
                const s = parseInt(start, 10);
                const e = parseInt(end, 10);
                return sceneNum >= s && sceneNum <= e;
            });
        });
    }

    const totalScenes = scopedIndex.length;
    const scored = scopedIndex.map(entry => ({
        sceneId: entry.sceneId,
        score: scoreEntry(entry, contextText, contextActivations, totalScenes),
    }));

    const sorted = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    const topScore = sorted[0]?.score ?? 0;
    const dynamicMax = maxScenes ?? (topScore > 15 ? 5 : topScore > 8 ? 4 : 3);
    const candidates = sorted.slice(0, dynamicMax);

    console.log(
        `[Archive Retrieval] 3D scored ${index.length} entries. ` +
        `${candidates.length} matched (max ${dynamicMax}). ` +
        `Top: [${candidates.map(c => `${c.sceneId}:${c.score.toFixed(1)}`).join(', ')}]`
    );

    return candidates.map(c => c.sceneId);
}

/**
 * Fetch full verbatim scene content from the server for a set of scene IDs.
 * Returns scenes within the token budget, sorted chronologically.
 */
export async function fetchArchiveScenes(
    campaignId: string,
    sceneIds: string[],
    tokenBudget = 3000
): Promise<ArchiveScene[]> {
    if (sceneIds.length === 0) return [];

    try {
        const idsParam = sceneIds.join(',');
        const res = await fetch(`/api/campaigns/${campaignId}/archive/scenes?ids=${idsParam}`);
        if (!res.ok) {
            console.warn('[Archive Retrieval] Failed to fetch scenes:', res.status);
            return [];
        }

        const raw: { sceneId: string; content: string }[] = await res.json();

        const sorted = raw.sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));
        const selected: ArchiveScene[] = [];
        let usedTokens = 0;

        for (const scene of sorted) {
            const tokens = countTokens(scene.content);
            if (usedTokens + tokens > tokenBudget) {
                // Partially include the scene if there's a meaningful amount of budget remaining
                const remaining = tokenBudget - usedTokens;
                if (remaining > 150) {
                    // ~4 chars per token; truncate to fit remaining budget
                    const maxChars = Math.floor(remaining * 4);
                    const truncated = scene.content.slice(0, maxChars) + '\n[...scene truncated for context budget...]';
                    selected.push({ sceneId: scene.sceneId, content: truncated, tokens: remaining });
                }
                break;
            }
            selected.push({ sceneId: scene.sceneId, content: scene.content, tokens });
            usedTokens += tokens;
        }

        console.log(
            `[Archive Retrieval] Fetched ${selected.length}/${raw.length} scenes ` +
            `(${usedTokens} tokens used of ${tokenBudget} budget).`
        );

        return selected;
    } catch (err) {
        console.warn('[Archive Retrieval] Error fetching scenes:', err);
        return [];
    }
}

/**
 * Convenience: search + fetch in one call.
 * Used in ChatArea before buildPayload().
 */
export async function recallArchiveScenes(
    campaignId: string,
    index: ArchiveIndexEntry[],
    userMessage: string,
    recentMessages: ChatMessage[],
    tokenBudget = 3000,
    npcLedger?: NPCEntry[],
    semanticFacts?: { subject: string; predicate: string; object: string; importance: number }[]
): Promise<ArchiveScene[]> {
    const matchedIds = retrieveArchiveMemory(index, userMessage, recentMessages, npcLedger, undefined, semanticFacts);
    if (matchedIds.length === 0) return [];
    return fetchArchiveScenes(campaignId, matchedIds, tokenBudget);
}
