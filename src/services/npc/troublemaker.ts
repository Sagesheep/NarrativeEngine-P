import type { EndpointConfig, ProviderConfig, ChatMessage, ArchiveIndexEntry, ArchiveChapter, NPCEntry } from '../../types';
import { llmCall } from '../../utils/llmCall';
import { renderPrompt } from '../prompts/promptRegistry';

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

    const prompt = renderPrompt('npc.trouble-arcs', {
        currentScene: currentScene || '(unknown — infer from recent conversation below)',
        sceneNote: sceneNote && sceneNote.trim() ? `\n[SCENE NOTE (player-set location/context)]\n${sceneNote.trim()}\n` : '',
        conversation: conversationSnippet,
        recentScenes: recentScenes || '(none)',
        threads: unresolvedThreads.length > 0 ? unresolvedThreads.map((t, i) => `${i + 1}. ${t}`).join('\n') : '(none)',
        npcs: activeNPCs.length > 0 ? activeNPCs.map(n => `- ${n.name} (${n.role}): ignored=${n.ignoredPressure}, engaged=${n.engagedPressure}`).join('\n') : '(none)',
    });

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
