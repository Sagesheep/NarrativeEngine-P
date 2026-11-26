/**
 * characterTraitParser.ts — WO-G scene-aware structured PC trait parser.
 *
 * Replaces the legacy flat-string profile with a bounded, supersession-aware
 * trait list. Reviews recent chat + current structured profile, emits an updated
 * CharacterProfileState as JSON. Sibling to characterProfileParser.ts (the sheet
 * parser) — this one owns the narrative-trait view.
 *
 * Key contracts:
 * 1. REPLACE, don't append. Contradictory facts with the same subject+category
 *    → mark the old one superseded, add the new one.
 * 2. Bounded: activeTraits capped at 10 (excluding superseded).
 * 3. Scene-tagged: each trait carries eventTags for retrieval filtering.
 * 4. Merge-by-id backstop (60ae996): traits missing from this turn's output are
 *    preserved unchanged (anti-drop). Protects against silent data loss.
 *
 * Fault tolerance: on any parse failure, returns currentProfile unchanged.
 */

import type { ChatMessage, ProviderConfig, EndpointConfig, CharacterProfileState, CharacterTrait, CharacterIdentity, DivergenceCategory, SceneEventType } from '../types';
import { uid } from '../utils/uid';
import { llmCall } from '../utils/llmCall';
import { AI_CALL_TIMEOUT_MS } from './llm/timeouts';
import type { ModelRequest, ModelResponse } from './turn/hostFacade';
import { guardStatPatch } from './combat/combatSheet';
import { renderPrompt } from './prompts/promptRegistry';

export type TraitScanOptions = { combatStatLock?: boolean };

const VALID_CATEGORIES: ReadonlySet<DivergenceCategory> = new Set([
    'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc',
]);
const VALID_TAGS: ReadonlySet<SceneEventType> = new Set([
    'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
    'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
]);
const TRAIT_CAP = 10;

export async function scanCharacterTraits(
    provider: ProviderConfig | EndpointConfig | undefined,
    messages: ChatMessage[],
    currentProfile: CharacterProfileState,
    modelCall?: (request: ModelRequest) => Promise<ModelResponse>,
    options: TraitScanOptions = {},
): Promise<CharacterProfileState> {
    const recentMessages = messages.slice(-15);
    if (recentMessages.length === 0) return currentProfile;

    const turns = recentMessages
        .map((m) => `[${m.role.toUpperCase()}]: ${m.content}`)
        .join('\n\n');

    const currentProfileJson = JSON.stringify({
        identity: currentProfile.identity,
        stats: currentProfile.stats,
        activeTraits: currentProfile.activeTraits.map(t => ({
            ...t,
            sceneEstablished: undefined,
            source: undefined,
        })),
    }, null, 2);

    const eventTagList: SceneEventType[] = [
        'combat', 'discovery', 'item_acquired', 'item_lost', 'relationship_shift',
        'travel', 'promise', 'betrayal', 'death', 'revelation', 'quest_milestone', 'other',
    ];
    const categoryList: DivergenceCategory[] = [
        'locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc',
    ];

    const prompt = renderPrompt('character.trait-scan', {
        traitCap: TRAIT_CAP,
        eventTags: eventTagList.join(', '),
        categories: categoryList.join(', '),
        profile: currentProfileJson,
        chat: turns,
    });

    try {
        const result = modelCall
            ? (await modelCall({ prompt, priority: 'low', maxTokens: 4096, trackingLabel: 'trait-scan', timeoutMs: AI_CALL_TIMEOUT_MS })).content
            : provider
                ? await llmCall(provider, prompt, { priority: 'low', maxTokens: 4096, trackingLabel: 'trait-scan', timeoutMs: AI_CALL_TIMEOUT_MS })
                : '';
        let clean = result.replace(/<think[\s\S]*?<\/think>/gi, '');
        const mdMatch = clean.match(/```(?:json)?\s*([\s\S]*?)```/i);
        if (mdMatch) clean = mdMatch[1];
        const braceStart = clean.indexOf('{');
        const braceEnd = clean.lastIndexOf('}');
        if (braceStart === -1 || braceEnd === -1) {
            console.warn('[CharacterTraitParser] No JSON object found — returning current profile unchanged');
            return currentProfile;
        }
        const parsed = JSON.parse(clean.substring(braceStart, braceEnd + 1));
        return normalizeParsedProfile(parsed, currentProfile, options.combatStatLock === true);
    } catch (e) {
        console.warn('[CharacterTraitParser] Parse failed — returning current profile unchanged:', e);
        return currentProfile;
    }
}

/**
 * Normalize a parsed JSON object into a valid CharacterProfileState.
 * Defensive: fills missing fields, generates IDs for new traits, clamps
 * importance, validates category/eventTags, enforces the 10-trait cap, and
 * merges-by-id with the prior profile (anti-drop backstop).
 */
export function normalizeParsedProfile(
    parsed: unknown,
    fallback: CharacterProfileState,
    combatStatLock = false,
): CharacterProfileState {
    if (!parsed || typeof parsed !== 'object') return fallback;
    const obj = parsed as Record<string, unknown>;

    const identityRaw = obj.identity && typeof obj.identity === 'object' ? obj.identity as Record<string, unknown> : {};
    const identity: CharacterIdentity = {
        name: typeof identityRaw.name === 'string' ? identityRaw.name : fallback.identity.name,
        race: typeof identityRaw.race === 'string' ? identityRaw.race : fallback.identity.race,
        class: typeof identityRaw.class === 'string' ? identityRaw.class : fallback.identity.class,
        archetype: typeof identityRaw.archetype === 'string' ? identityRaw.archetype : fallback.identity.archetype,
        level: typeof identityRaw.level === 'number' ? identityRaw.level : fallback.identity.level,
    };

    let stats: Record<string, number> | undefined;
    if (obj.stats && typeof obj.stats === 'object') {
        const s = obj.stats as Record<string, unknown>;
        const incoming: Record<string, number> = {};
        for (const [k, v] of Object.entries(s)) {
            if (typeof v === 'number') incoming[k] = v;
        }
        stats = { ...(fallback.stats ?? {}), ...guardStatPatch(incoming, combatStatLock) };
    } else {
        stats = fallback.stats;
    }

    const traitsRaw = Array.isArray(obj.activeTraits) ? obj.activeTraits : [];
    const seenIds = new Set<string>();
    const traits: CharacterTrait[] = traitsRaw
        .filter((t): t is Record<string, unknown> => !!t && typeof t === 'object')
        .map((t) => {
            const category = typeof t.category === 'string' && VALID_CATEGORIES.has(t.category as DivergenceCategory)
                ? t.category as DivergenceCategory
                : 'misc';
            const tags = Array.isArray(t.eventTags)
                ? t.eventTags.filter((tag): tag is SceneEventType => typeof tag === 'string' && VALID_TAGS.has(tag as SceneEventType))
                : [];
            const id = typeof t.id === 'string' && !seenIds.has(t.id) ? t.id : uid();
            seenIds.add(id);
            const importance = typeof t.importance === 'number' ? Math.max(1, Math.min(10, Math.round(t.importance))) : 5;
            return {
                id,
                subject: typeof t.subject === 'string' ? t.subject : (identity.name || 'PC'),
                category,
                text: typeof t.text === 'string' ? t.text : '',
                importance,
                eventTags: tags,
                sceneEstablished: typeof t.sceneEstablished === 'string' ? t.sceneEstablished : '',
                superseded: t.superseded === true,
                source: (t.source === 'manual' || t.source === 'seed') ? t.source : 'llm',
            } as CharacterTrait;
        })
        .filter(t => t.text.length > 0);

    // Merge-by-id backstop (anti-drop): traits missing from this turn's output
    // are preserved unchanged. Protects against silent data loss.
    const parsedIds = new Set(traits.map(t => t.id));
    const preserved = fallback.activeTraits.filter(t => !parsedIds.has(t.id));
    const merged = [...traits, ...preserved];

    // Enforce the 10-trait cap on non-superseded entries (after merge).
    const active = merged.filter(t => !t.superseded);
    const superseded = merged.filter(t => t.superseded);
    if (active.length > TRAIT_CAP) {
        active.sort((a, b) => b.importance - a.importance);
        for (const t of active.slice(TRAIT_CAP)) t.superseded = true;
    }

    const finalTraits = [...active, ...superseded];

    return {
        identity,
        stats,
        activeTraits: finalTraits,
        legacyNotes: fallback.legacyNotes,
    };
}