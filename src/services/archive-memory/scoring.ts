import type { ArchiveIndexEntry, ChatMessage, NPCEntry } from '../../types';
import { safeSceneNum } from '../../utils/helpers';

/**
 * archive-memory/scoring.ts
 *
 * The keyword ranker's scoring layer: per-entry relevance scoring with mainApp's
 * POV signal folded in, plus the context-activation extraction and fact-expansion
 * that feed it, plus the structured-event boost. `scoreEntry` returns
 * { keywordRelevance, recency, importance } — only keywordRelevance drives the
 * keyword rank that feeds RRF; recency/importance are small tiebreakers (a flat
 * importance term added to every scene would make the keyword list importance-
 * sorted and the fusion meaningless).
 */

export type ScoreResult = {
    keywordRelevance: number;
    recency: number;
    importance: number;
};

export function scoreEntry(
    entry: ArchiveIndexEntry,
    contextText: string,
    contextActivations: Record<string, number>,
    totalScenes: number,
    idf: Record<string, number>,
    npcPerspective?: string,
): ScoreResult {
    // Recency (always positive, logarithmic — never zero). Tiebreak only.
    const sceneNum = safeSceneNum(entry.sceneId);
    const turnsSince = totalScenes - sceneNum;
    const recency = 1 / (1 + Math.log(1 + Math.max(0, turnsSince)));

    // Intrinsic importance (permanent, no decay). Tiebreak only.
    const importance = entry.importance ?? 5;

    // Activation strength: IDF-weighted keyword-strength-matrix dot product.
    let activation = 0;
    const kwStrengths = entry.keywordStrengths ?? {};
    for (const [keyword, strength] of Object.entries(kwStrengths)) {
        const a = contextActivations[keyword];
        if (a) activation += a * strength * (idf[keyword] ?? 1);
    }
    const npcStrengths = entry.npcStrengths ?? {};
    for (const [npc, strength] of Object.entries(npcStrengths)) {
        const a = contextActivations[npc];
        if (a) activation += a * strength * 1.5 * (idf[npc] ?? 1);
    }

    // Fallback: legacy keyword matching for old entries without strength matrices.
    if (Object.keys(kwStrengths).length === 0 && Object.keys(npcStrengths).length === 0) {
        for (const kw of entry.keywords) {
            const k = kw.toLowerCase();
            if (contextText.includes(k)) {
                const exactMatch = new RegExp(`\\b${kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
                activation += (exactMatch.test(contextText) ? 2 : 0.5) * (idf[k] ?? 1);
            }
        }
        for (const npc of entry.npcsMentioned) {
            const k = npc.toLowerCase();
            if (contextText.includes(k)) activation += 3 * (idf[k] ?? 1);
        }
    }

    let keywordRelevance = 2.0 * activation;

    // POV-aware boost/penalty (mainApp-specific signal, folded into relevance).
    if (npcPerspective && keywordRelevance > 0) {
        const witnesses = entry.witnesses ?? [];
        const wasWitness = witnesses.some(w => w.toLowerCase() === npcPerspective.toLowerCase());
        const wasMentioned = entry.npcsMentioned.some(m => m.toLowerCase() === npcPerspective.toLowerCase());

        if (wasWitness) keywordRelevance *= 1.5;
        else if (wasMentioned) keywordRelevance *= 0.8;
        else if (witnesses.length > 0) keywordRelevance *= 0.3;
    }

    // Divergence is intentionally NOT boosted here — it is force-surfaced post-fusion in
    // retrieveArchiveMemory. Boosting it here too would double-count it.
    return { keywordRelevance, recency, importance };
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

    // 1-hop expansion
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

    // 2-hop expansion: entities connected via an intermediate entity
    const hop2Activations: Record<string, number> = {};
    for (const [entity, weight] of Object.entries(expanded)) {
        if (weight < 0.3) continue;
        const hop1Facts = facts.filter(f =>
            f.subject.toLowerCase() === entity || f.object.toLowerCase() === entity
        );
        for (const hop1Fact of hop1Facts) {
            const hop1Entity = hop1Fact.subject.toLowerCase() === entity
                ? hop1Fact.object.toLowerCase() : hop1Fact.subject.toLowerCase();
            const hop2Facts = facts.filter(f =>
                f.subject.toLowerCase() === hop1Entity || f.object.toLowerCase() === hop1Entity
            );
            for (const h2f of hop2Facts) {
                const hop2Entity = h2f.subject.toLowerCase() === hop1Entity
                    ? h2f.object.toLowerCase() : h2f.subject.toLowerCase();
                if (!expanded[hop2Entity] && hop2Entity !== entity) {
                    hop2Activations[hop2Entity] = (hop2Activations[hop2Entity] || 0) + weight * 0.25;
                }
            }
        }
    }
    for (const [entity, weight] of Object.entries(hop2Activations)) {
        if (!expanded[entity]) {
            expanded[entity] = weight;
        }
    }

    return expanded;
}

export function applyEventBoost(
    candidates: ArchiveIndexEntry[],
    query: string,
    recentMessages: ChatMessage[],
): Map<string, number> {
    const boostMap = new Map<string, number>();
    const contextText = [
        query,
        ...recentMessages.slice(-3).map(m => m.content || '')
    ].join('\n').toLowerCase();

    for (const entry of candidates) {
        if (!entry.events || entry.events.length === 0) continue;
        let bonus = 0;
        for (const event of entry.events) {
            if (event.importance >= 7) {
                bonus += 1.5;
            }
            if (event.characters) {
                for (const char of event.characters) {
                    if (char && contextText.includes(char.toLowerCase())) {
                        bonus += 1.0;
                    }
                }
            }
            if (event.locations) {
                for (const loc of event.locations) {
                    if (loc && contextText.includes(loc.toLowerCase())) {
                        bonus += 1.0;
                    }
                }
            }
        }
        if (bonus > 0) {
            boostMap.set(entry.sceneId, bonus);
        }
    }
    return boostMap;
}
