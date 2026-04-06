/**
 * semanticMemory.ts
 *
 * Semantic Memory Layer — queries the server-side fact store and returns
 * matching facts for injection into the LLM payload.
 *
 * Facts are extracted server-side during archive append (Phase 2).
 * This service queries them by entity matching against current context.
 */

import type { SemanticFact, NPCEntry } from '../types';

export async function fetchFacts(campaignId: string): Promise<SemanticFact[]> {
    try {
        const res = await fetch(`/api/campaigns/${campaignId}/facts`);
        if (res.ok) return await res.json();
    } catch (err) {
        console.warn('[SemanticMemory] Failed to fetch facts:', err);
    }
    return [];
}

function extractContextEntities(
    userMessage: string,
    recentMessages: { content: string; role: string }[],
    npcLedger?: NPCEntry[]
): Set<string> {
    const entities = new Set<string>();

    if (npcLedger) {
        for (const npc of npcLedger) {
            entities.add(npc.name.toLowerCase());
            if (npc.aliases) {
                for (const alias of npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)) {
                    entities.add(alias);
                }
            }
        }
    }

    const allText = [userMessage, ...recentMessages.slice(-5).map(m => m.content || '')].join(' ');
    const properNouns = allText.match(/[A-Z][A-Za-z]{2,}(?:\s[A-Z][A-Za-z]{2,})*/g) || [];
    for (const noun of properNouns) entities.add(noun.toLowerCase());

    return entities;
}

export function queryFacts(
    facts: SemanticFact[],
    userMessage: string,
    recentMessages: { content: string; role: string }[],
    npcLedger?: NPCEntry[],
    tokenBudget = 500
): SemanticFact[] {
    if (!facts || facts.length === 0) return [];

    const entities = extractContextEntities(userMessage, recentMessages, npcLedger);

    const scored = facts.map(fact => {
        let score = 0;
        const sLower = fact.subject.toLowerCase();
        const oLower = fact.object.toLowerCase();
        if (entities.has(sLower)) score += fact.importance;
        if (entities.has(oLower)) score += fact.importance * 0.8;
        for (const entity of entities) {
            if (sLower.includes(entity) || entity.includes(sLower)) score += 2;
            if (oLower.includes(entity) || entity.includes(oLower)) score += 1.5;
        }
        return { fact, score };
    });

    const matched = scored.filter(s => s.score > 0).sort((a, b) => b.score - a.score);
    const selected: SemanticFact[] = [];
    let usedTokens = 0;

    for (const { fact } of matched) {
        if (usedTokens + 12 > tokenBudget) break;
        selected.push(fact);
        usedTokens += 12;
    }

    if (selected.length > 0) {
        console.log(`[SemanticMemory] Matched ${selected.length}/${facts.length} facts (~${usedTokens} tokens)`);
    }
    return selected;
}

export function formatFactsForContext(facts: SemanticFact[]): string {
    if (facts.length === 0) return '';
    const lines = facts
        .sort((a, b) => b.importance - a.importance)
        .map(f => `▸ ${f.subject} —${f.predicate}→ ${f.object} [${f.importance}]`);
    return `[SEMANTIC MEMORY]\n${lines.join('\n')}\n[END SEMANTIC MEMORY]`;
}
