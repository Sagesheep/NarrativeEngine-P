import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessageAndParseJson, type JsonModelCall } from './shared';

export async function backfillNPCDrives(
    provider: EndpointConfig | ProviderConfig | undefined,
    history: ChatMessage[],
    npcsNeedingDrives: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
    modelCall?: JsonModelCall
): Promise<void> {
    if (!npcsNeedingDrives.length) return;

    console.log(`[NPC Drives Backfill] Populating drives for ${npcsNeedingDrives.length} legacy NPC(s)...`);

    const recentContext = history.slice(-10).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    for (const npc of npcsNeedingDrives) {
        const npcSummary = `Name: ${npc.name}\nPersonality: ${npc.personality || npc.disposition || 'Unknown'}\nVoice: ${npc.voice || 'Unknown'}\nGoals: ${npc.goals || 'Unknown'}\nFaction: ${npc.faction || 'Unknown'}\nAffinity: ${npc.affinity ?? 50}/100\nStory Relevance: ${npc.storyRelevance || 'Unknown'}`;

        const prompt = `You are a background GM assistant. An existing NPC in a TTRPG campaign needs their drives, behavioral triggers, and boundaries populated. Based on their profile and recent game context, generate these fields.

[NPC PROFILE]
${npcSummary}
[END PROFILE]

[RECENT GAME CONTEXT]
${recentContext}
[END CONTEXT]

RESPOND ONLY WITH VALID JSON. NO MARKDOWN FORMATTING. NO EXPLANATIONS.
{
  "coreWant": "String — one sentence: a deep character truth this NPC carries (NOT a goal). Example: 'to be seen as capable, not just loyal'",
  "sessionWant": "String — one sentence: what this NPC is working toward in the current arc based on context. If unclear, invent a plausible arc goal.",
  "sceneWant": "String — one sentence: what this NPC wants from the most recent scene. Base this on the recent context if possible.",
  "behavioralTriggers": [
    { "keyword": "String — a word/phrase that activates this trigger based on their personality", "shift": "String — PHYSICAL/VERBAL behavioral shift (NOT emotion). Good: 'crosses arms, single-syllable answers'. Bad: 'becomes angry'." }
  ],
  "hardBoundaries": ["String — something this NPC will never do"],
  "softBoundaries": ["String — something this NPC dislikes but may tolerate"]
}`;

        const messages: OpenAIMessage[] = [
            { role: 'user', content: prompt }
        ];

        try {
            const { parsed } = await sendMessageAndParseJson(provider, messages, `NPC Drives Backfill/${npc.name}`, 'npc-drives-backfill', modelCall);

            const patch: Partial<NPCEntry> = {
                drives: {
                    coreWant: parsed.coreWant || `${npc.name} wants to prove their worth`,
                    sessionWant: parsed.sessionWant || `${npc.name} is looking for opportunity`,
                    sceneWant: parsed.sceneWant || `${npc.name} is observing the situation`,
                },
                behavioralTriggers: Array.isArray(parsed.behavioralTriggers)
                    ? parsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
                    : [],
                hardBoundaries: Array.isArray(parsed.hardBoundaries)
                    ? parsed.hardBoundaries.map(String).filter(Boolean)
                    : [],
                softBoundaries: Array.isArray(parsed.softBoundaries)
                    ? parsed.softBoundaries.map(String).filter(Boolean)
                    : [],
            };

            updateNPCStore(npc.id, patch);
            console.log(`[NPC Drives Backfill] Populated drives for ${npc.name}:`, patch.drives);
        } catch (err) {
            console.error(`[NPC Drives Backfill] Failed for ${npc.name}:`, err);
        }
    }
}
