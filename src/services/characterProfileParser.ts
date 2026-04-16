import type { ChatMessage, ProviderConfig, EndpointConfig } from '../types';
import { callLLM } from './callLLM';

export async function scanCharacterProfile(
    provider: ProviderConfig | EndpointConfig,
    messages: ChatMessage[],
    currentProfile: string
): Promise<string> {
    // Take the last 15 messages for context
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentProfile;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const prompt = `You are an AI game engine parser responsible for maintaining the player's character profile and sheet.
Review the recent chat history and the current character profile below. Identify any updates to the character's name, race/species, class/role, level, key abilities, powers, notable traits, or core stats (like HP/Mana) based on the recent narrative.

=== CURRENT CHARACTER PROFILE ===
${currentProfile || '(Empty)'}

=== RECENT CHAT HISTORY ===
${turns}

=== INSTRUCTIONS ===
1. Analyze the chat history for explicit reveals, level-ups, or changes to the player's core character definition.
2. Update the "CURRENT CHARACTER PROFILE" accordingly.
3. Output ONLY the updated, comprehensive profile. 
4. Format cleanly (e.g., Name/Class at the top, bullet points for Traits/Abilities/Powers).
5. DO NOT include any conversational text, explanations, or markdown formatting outside of the text itself. If nothing changed, return the current profile exactly as is.`;

    try {
        const result = await callLLM(provider, prompt, { priority: 'low' });
        // Strip out any surrounding markdown code blocks if the LLM adds them
        return result.replace(/^```[\s\S]*?\n/, '').replace(/\n```$/, '').trim();
    } catch (e) {
        console.error('[CharacterProfileParser]', e);
        throw e;
    }
}
