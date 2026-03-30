/**
 * contextRecommender.ts
 * ---------------------
 * LLM-powered context selection — replaces substring matching when a utilityAI endpoint is configured.
 * Sends the NPC ledger headers + lore chunk headers + recent history excerpt to a cheap/local model,
 * which returns JSON arrays of relevant NPC names and lore IDs.
 *
 * Falls back silently on any error (caller handles fallback to substring scan).
 */

import type { EndpointConfig, NPCEntry, LoreChunk, ChatMessage } from '../types';

export type RecommenderResult = {
    relevantNPCNames: string[];   // NPC names the model considers relevant
    relevantLoreIds: string[];    // Lore chunk IDs the model considers relevant
};

/**
 * Build a compact roster string from the NPC ledger.
 * Only sends name + faction + status — enough for the model to judge relevance
 * without blowing up the prompt.
 */
function buildNPCRoster(ledger: NPCEntry[]): string {
    if (ledger.length === 0) return 'No NPCs in ledger.';
    return ledger.map(npc => {
        const parts = [npc.name];
        if (npc.aliases) parts.push(`(aka ${npc.aliases})`);
        if (npc.faction) parts.push(`[${npc.faction}]`);
        if (npc.status) parts.push(`— ${npc.status}`);
        return parts.join(' ');
    }).join('\n');
}

/**
 * Build a compact lore index from chunks.
 * Sends id + category + header + summary for relevance judgment.
 */
function buildLoreIndex(chunks: LoreChunk[]): string {
    if (chunks.length === 0) return 'No lore chunks available.';
    return chunks
        .filter(c => !c.alwaysInclude) // alwaysInclude chunks don't need recommendation
        .map(c => {
            const sum = c.summary ? ` — ${c.summary}` : '';
            return `- ID:${c.id} | ${c.category} | ${c.header}${sum}`;
        }).join('\n');
}

/**
 * Extract a concise conversation excerpt from recent messages.
 * Takes the last N messages and truncates long ones.
 */
function buildConversationExcerpt(messages: ChatMessage[], userMessage: string, depth: number = 6): string {
    const recent = messages.slice(-depth);
    const lines = recent.map(m => {
        const role = m.role === 'user' ? 'PLAYER' : m.role === 'assistant' ? 'GM' : m.role.toUpperCase();
        const text = (m.content || '').slice(0, 300); // Truncate long messages
        return `[${role}]: ${text}`;
    });
    lines.push(`[PLAYER]: ${userMessage.slice(0, 300)}`);
    return lines.join('\n\n');
}

const RECOMMENDER_PROMPT = `You are a context selector for a tabletop RPG game engine. Given a conversation excerpt, a roster of NPCs, and an index of lore entries, determine which NPCs and lore entries are RELEVANT to the current scene.

RULES:
1. An NPC is relevant if they are: mentioned by name/alias, physically present in the scene, directly referenced, or their faction/goals are materially involved.
2. A lore entry is relevant if: its subject matter relates to the current location, active quest, mentioned organizations, or ongoing conflict.
3. Be SELECTIVE — only include truly relevant entries, not everything tangentially related.
4. Return ONLY valid JSON in exactly this format, no other text:

{"npcs": ["Name1", "Name2"], "lore": ["id1", "id2"]}

If nothing is relevant, return: {"npcs": [], "lore": []}`;

/**
 * Calls the utility AI endpoint to determine which NPCs and lore chunks
 * are relevant to the current conversation context.
 *
 * @throws on network/API errors — caller MUST catch and fall back to substring scan.
 */
export async function recommendContext(
    utilityEndpoint: EndpointConfig,
    npcLedger: NPCEntry[],
    loreChunks: LoreChunk[],
    messages: ChatMessage[],
    userMessage: string
): Promise<RecommenderResult> {
    const npcRoster = buildNPCRoster(npcLedger);
    const loreIndex = buildLoreIndex(loreChunks);
    const conversation = buildConversationExcerpt(messages, userMessage);

    const userContent = `${RECOMMENDER_PROMPT}

[NPC ROSTER — ${npcLedger.length} characters]
${npcRoster}

[LORE INDEX — ${loreChunks.filter(c => !c.alwaysInclude).length} entries]
${loreIndex}

[RECENT CONVERSATION]
${conversation}

Respond with the JSON object now:`;

    const url = `${utilityEndpoint.endpoint.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (utilityEndpoint.apiKey) headers['Authorization'] = `Bearer ${utilityEndpoint.apiKey}`;

    console.log(`[ContextRecommender] Sending recommendation request to ${utilityEndpoint.modelName}...`);

    const res = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
            model: utilityEndpoint.modelName,
            messages: [{ role: 'user', content: userContent }],
            stream: false,
            temperature: 0.1, // Low temperature for consistent structured output
        }),
    });

    if (!res.ok) {
        const errBody = await res.text();
        throw new Error(`ContextRecommender API error ${res.status}: ${errBody}`);
    }

    const data = await res.json();
    const rawContent = data.choices?.[0]?.message?.content ?? '';

    // Parse the JSON response — handle <think> blocks and markdown wrapping
    let cleanContent = rawContent.replace(/<think>[\s\S]*?<\/think>/gi, '');
    const mdMatch = cleanContent.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (mdMatch) cleanContent = mdMatch[1];

    // Find JSON object in the response
    const jsonStart = cleanContent.indexOf('{');
    const jsonEnd = cleanContent.lastIndexOf('}');
    if (jsonStart === -1 || jsonEnd === -1 || jsonEnd <= jsonStart) {
        console.warn('[ContextRecommender] Failed to find JSON in response:', rawContent.slice(0, 200));
        throw new Error('No valid JSON in recommender response');
    }

    const parsed = JSON.parse(cleanContent.substring(jsonStart, jsonEnd + 1));

    const result: RecommenderResult = {
        relevantNPCNames: Array.isArray(parsed.npcs) ? parsed.npcs.filter((n: unknown) => typeof n === 'string') : [],
        relevantLoreIds: Array.isArray(parsed.lore) ? parsed.lore.filter((n: unknown) => typeof n === 'string') : [],
    };

    console.log(`[ContextRecommender] Recommended ${result.relevantNPCNames.length} NPCs, ${result.relevantLoreIds.length} lore entries.`);

    return result;
}
