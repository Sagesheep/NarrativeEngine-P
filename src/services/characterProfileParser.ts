/**
 * characterProfileParser.ts
 * -------------------------
 * Delta-patch parser for structured character profile.
 * Sends recent history + current profile JSON to the LLM.
 * Expects back a JSON object of partial changes applied locally.
 */

import type { ChatMessage, ProviderConfig, EndpointConfig, CharacterProfile } from '../types';
import { callLLM } from './callLLM';

export type ProfileOp = Partial<CharacterProfile> & { op?: 'set' | 'add_to_list' | 'remove_from_list' | 'update_list_item' };

export async function scanCharacterProfile(
    provider: ProviderConfig | EndpointConfig,
    messages: ChatMessage[],
    currentProfile: CharacterProfile
): Promise<CharacterProfile> {
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentProfile;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const profileJson = JSON.stringify(currentProfile, null, 0);

    const prompt = `You are an AI character profile manager for an RPG. Review the recent chat and character profile below.\nIdentify any changes to HP, MP, stats, skills, abilities, traits, name, race, class, or level.\n\n=== CURRENT PROFILE ===\n${profileJson}\n\n=== RECENT CHAT HISTORY ===\n${turns}\n\n=== INSTRUCTIONS ===\nReturn ONLY a valid JSON object containing changed fields and their new values. No other text.\nUse top-level keys matching the profile fields.\n\nTo increment/decrement a numeric value, return the NEW absolute value (not delta).\n\nExample response when HP drops by 5:\n{"hp":{"current":15,"max":20}}\n\nExample response when a new skill is gained:\n{"skills":["Stealth","Persuasion","Arcana","Lockpicking"]}\n\nExample response when nothing changes:\n{}\n\nOnly include keys that changed. Return {} if nothing changed.`;

    try {
        const result = await callLLM(provider, prompt, { priority: 'low' });
        let text = result;
        const md = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (md) text = md[1];
        const objMatch = text.match(/\{[\s\S]*\}/);
        const patch = objMatch ? JSON.parse(objMatch[0]) : {};
        if (!patch || typeof patch !== 'object') return currentProfile;
        return applyPatch(currentProfile, patch);
    } catch (e) {
        console.error('[CharacterProfileParser]', e);
        return currentProfile;
    }
}

function applyPatch(profile: CharacterProfile, patch: Record<string, unknown>): CharacterProfile {
    const next: CharacterProfile = JSON.parse(JSON.stringify(profile));
    if ('name' in patch && typeof patch.name === 'string') next.name = patch.name;
    if ('race' in patch && typeof patch.race === 'string') next.race = patch.race;
    if ('class' in patch && typeof patch.class === 'string') next.class = patch.class;
    if ('level' in patch && typeof patch.level === 'number') next.level = patch.level;
    if ('hp' in patch && patch.hp && typeof patch.hp === 'object') {
        const p = patch.hp as any;
        next.hp = { current: p.current ?? next.hp.current, max: p.max ?? next.hp.max };
    }
    if ('mp' in patch && patch.mp && typeof patch.mp === 'object') {
        const p = patch.mp as any;
        next.mp = { current: p.current ?? (next.mp?.current || 0), max: p.max ?? (next.mp?.max || 0) };
    }
    if ('stats' in patch && patch.stats && typeof patch.stats === 'object') {
        next.stats = { ...next.stats, ...(patch.stats as Record<string, number>) };
    }
    if ('skills' in patch && Array.isArray(patch.skills)) next.skills = patch.skills as string[];
    if ('abilities' in patch && Array.isArray(patch.abilities)) next.abilities = patch.abilities as string[];
    if ('traits' in patch && Array.isArray(patch.traits)) next.traits = patch.traits as string[];
    if ('notes' in patch && typeof patch.notes === 'string') next.notes = patch.notes;
    return next;
}