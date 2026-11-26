import type { EndpointConfig, ProviderConfig, ChatMessage, ArchiveIndexEntry, ArchiveChapter, NPCEntry } from '../../types';
import { llmCall } from '../../utils/llmCall';

export async function generateTroubleOptions(
    provider: EndpointConfig | ProviderConfig,
    messages: ChatMessage[],
    archiveIndex: ArchiveIndexEntry[],
    chapters: ArchiveChapter[],
    npcLedger: NPCEntry[],
    sceneNote?: string,
): Promise<string[]> {
    const conversationMessages = messages.filter(m => m.role === 'user' || m.role === 'assistant');
    const recentMessages = conversationMessages.slice(-15);
    const conversationSnippet = recentMessages
        .map(m => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : ''}`)
        .join('\n');

    // The most recent assistant narration IS the player's current scene.
    const lastAssistant = [...conversationMessages].reverse().find(m => m.role === 'assistant');
    const currentScene = typeof lastAssistant?.content === 'string'
        ? lastAssistant.content.slice(0, 1500)
        : '';

    const recentScenes = archiveIndex.slice(-5).map(s => `Scene ${s.sceneId}: ${s.userSnippet}`).join('\n');

    const sealedChapters = chapters.filter(c => c.sealedAt != null && !c.invalidated);
    const unresolvedThreads = sealedChapters
        .flatMap(c => c.unresolvedThreads ?? [])
        .slice(0, 10);

    const activeNPCs = npcLedger
        .filter(npc => {
            const pressure = npc.pressure;
            return pressure && (pressure.ignored > 1 || pressure.engaged > 1);
        })
        .map(npc => ({
            name: npc.name,
            role: npc.storyRelevance || 'unknown',
            ignoredPressure: npc.pressure?.ignored ?? 0,
            engagedPressure: npc.pressure?.engaged ?? 0,
        }));

    const prompt = `You are a narrative director for a tabletop RPG. Analyze the recent campaign activity and identify what the player has been repeatedly doing (their loop or grind pattern).

[CURRENT SCENE — WHERE THE PLAYER IS RIGHT NOW]
${currentScene || '(unknown — infer from recent conversation below)'}
${sceneNote && sceneNote.trim() ? `\n[SCENE NOTE (player-set location/context)]\n${sceneNote.trim()}\n` : ''}
Recent conversation:
${conversationSnippet}

Recent scene summaries:
${recentScenes || '(none)'}

Unresolved story threads from past chapters:
${unresolvedThreads.length > 0 ? unresolvedThreads.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)'}

Active NPCs with pressure:
${activeNPCs.length > 0 ? activeNPCs.map(n => `- ${n.name} (${n.role}): ignored=${n.ignoredPressure}, engaged=${n.engagedPressure}`).join('\n') : '(none)'}

Generate 4 distinct TROUBLE ARC SEEDS — each one is an ongoing storyline of conflict, danger, or pressure that unfolds over multiple scenes as a natural consequence of the player's behavior. Not a one-scene event. A new thread that will keep developing and demand a response.

CRITICAL — LOCATION RULE: Each arc's opening hook MUST happen at the player's CURRENT location (see [CURRENT SCENE] above). The hook is something that comes TO the player right now — a stranger enters, a messenger arrives, a fight breaks out nearby, the player overhears something, an object is noticed. The hook must NEVER require the player to travel somewhere else first. The arc may LEAD toward distant places over later scenes — that is fine and expected — but it must START here, where the player already is.

Each arc must:
- Be TROUBLE — a threat, conflict, complication, rivalry, ticking-clock, accusation, betrayal, hunt, debt-come-due, or escalation of past sins. NEVER a gift, reward, free opportunity, or "good thing happens" hook.
- Pick a DIFFERENT flavor of trouble per arc (vary across: external threat/violence, social/political fallout, rivalry/grudge, consequence of past action, supernatural/unknown pressure, hidden betrayal, etc.) — but every one of them is trouble.
- Open with a concrete hook that happens AT the player's current location, right now
- Hint at where it leads over time (not resolved immediately — distant developments are OK in the direction, not the hook)
- Be grounded in established world details (character names, places, factions already present)
- Carry a stated or implied STAKE — what gets worse if the player ignores it. The reason this trouble exists should feel earned by what the player has been doing or ignoring, not random.

Return ONLY a JSON array of 4 strings. Each string = 2 sentences: the local hook + the direction.
["...", "...", "...", "..."]`;

    const raw = await llmCall(provider, prompt, { maxTokens: 4000, thinkingEffort: 'low' });

    try {
        const match = raw.match(/\[[\s\S]*\]/);
        if (!match) throw new Error('No JSON array found in response');
        const parsed = JSON.parse(match[0]);
        if (!Array.isArray(parsed) || parsed.length < 4) {
            throw new Error('Expected 4 options, got ' + (Array.isArray(parsed) ? parsed.length : 'non-array'));
        }
        return parsed.slice(0, 4).map(String);
    } catch {
        const lines = raw.split('\n')
            .map(l => l.replace(/^\d+[.)]\s*/, '').trim())
            .filter(l => l.length > 10 && !l.startsWith('Here') && !l.startsWith('Options') && !l.startsWith('<think') && !l.startsWith('#'));
        if (lines.length >= 4) return lines.slice(0, 4);
        throw new Error('Could not parse trouble options from LLM response');
    }
}
