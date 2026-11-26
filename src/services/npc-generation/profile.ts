import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry, SceneEventType } from '../../types';
import { uid } from '../../utils/uid';
import { sendMessageAndParseJson, sanitizeSignatureKit } from './shared';
import { TRAIT_VOCAB, TRAIT_NAMES } from '../npc/agency/agencyPools';
import { describeHex } from '../npc/agency/agencyBands';
import { drawShortWants, drawMediumWants } from '../npc/agency/agencyWantDraw';
import { buildGoalsFromWants } from '../npc/agency/agencyGoals';
import { GROUP_KEYS } from '../npc/dispositionGroups';
import { rollHex, pickGroups, drawConsistentTraits, rollLooksTier } from '../npc/hexRoll';
import { buildVoiceDirective } from '../npc/hexVoiceGuide';
import { visualProfileToProse } from '../npc/retireLegacyFields';
import { renderPrompt } from '../prompts/promptRegistry';

// NPC Generation Refit (Phase 1): propose → roll → render.
//
// The model PROPOSES scene-appropriate abstract groups + 2 anchor traits (semantics); the engine
// ROLLS the hexagon inside the proposed envelope (variety + refusal to converge); the model
// RENDERS the fixed skeleton into world flavour. The model never emits the personality hexagon —
// hex comes from the ROLL (00_SPEC §4).

const KNOWN_TRAITS = new Set<string>(TRAIT_NAMES);

/** The trait names offered to the model, filtered by maturity tier. */
function offeredTraitNames(matureMode: boolean): string[] {
    return TRAIT_VOCAB.filter(t => matureMode || t.tier !== 'mature').map(t => t.text);
}

/**
 * Coerce an LLM-returned scalar field to a string. The render prompt asks the
 * model for string values (e.g. `"aliases": "String (Comma separated...)"`),
 * but models frequently return arrays (e.g. `["Scholar", "Caretaker..."]`) or
 * other non-string shapes for multi-valued fields. Assigning those verbatim
 * into a `string`-typed NPCEntry field silently corrupts the ledger and later
 * throws `TypeError: x.split is not a function` from downstream `.split(',')`
 * call sites. This normalizes any value to a string: arrays are joined with
 * ", " (preserving all values, matching the prompt's comma-separated contract),
 * other non-strings are stringified, null/undefined falls back to the default.
 */
function coerceStringField(v: unknown, fallback = ''): string {
    if (typeof v === 'string') return v;
    if (Array.isArray(v)) return v.map(String).filter(Boolean).join(', ');
    if (v === null || v === undefined) return fallback;
    return String(v);
}

/** Faction-appropriate fallback long want when the model omits or returns an empty one. */
function defaultLongWant(faction: string): string {
    const f = (faction && faction.trim() && faction !== 'Unknown') ? faction.trim() : 'a name of their own';
    return `rise to a position of lasting power within ${f}`;
}

/**
 * Scene-type tags per profile field for smart context injection. Fields not listed here (or NPCs
 * without fieldTags) always inject — backward compatible. The tags are deliberately broad: a
 * field tagged [social] injects in any social-flavored scene, not just pure "relationship_shift"
 * scenes. (Main's NPCEntry has no combat fields; combat tags are omitted — desktop combat is
 * bespoke per Upgrade doc 07.)
 */
function buildDefaultFieldTags(npc: NPCEntry): Partial<Record<string, SceneEventType[]>> {
    void npc;
    const tags: Partial<Record<string, SceneEventType[]>> = {
        voice: ['relationship_shift', 'revelation', 'other'],
        hardBoundaries: ['relationship_shift', 'promise', 'betrayal'],
        softBoundaries: ['relationship_shift', 'betrayal'],
        behavioralTriggers: ['combat', 'relationship_shift', 'revelation'],
        exampleOutput: ['relationship_shift', 'other'],
        drift: ['relationship_shift', 'revelation'],
        innerState: ['relationship_shift', 'revelation', 'discovery'],
    };
    return tags;
}

export async function generateNPCProfile(
    provider: EndpointConfig | ProviderConfig,
    history: ChatMessage[],
    npcName: string,
    addNPCToStore: (npc: NPCEntry) => void,
    existingLedger?: NPCEntry[],
    matureMode: boolean = false,
    rng: () => number = Math.random,
): Promise<void> {
    try {
        console.log(`[NPC Generator] Initiating background profile generation for: ${npcName}`);

        const recentHistory = history.slice(-15).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

        // ---- (A) PROPOSE — model proposes scene-appropriate SOCIAL groups + 2 anchor traits ----
        const proposal = await proposeGroupsAndTraits(provider, recentHistory, existingLedger, matureMode);
        const validGroups = proposal.candidateGroups.filter(k => (GROUP_KEYS as readonly string[]).includes(k));
        const candidateGroups = validGroups.length > 0 ? Array.from(new Set(validGroups)) : Array.from(GROUP_KEYS);
        const anchorTraits = proposal.anchorTraits.filter(t => KNOWN_TRAITS.has(t)).slice(0, 2);

        // ---- (engine) ROLL — pickGroups/rollHex/drawConsistentTraits/rollLooksTier (no LLM) ----
        const { primary, secondary } = pickGroups(candidateGroups, rng);
        const rolledHex = rollHex(primary, secondary, anchorTraits, rng);
        const drawnTraits = drawConsistentTraits(rolledHex, anchorTraits, rng, matureMode);
        const finalTraits = [...anchorTraits, ...drawnTraits].slice(0, 5);
        const looksTier = rollLooksTier(rng);
        const voiceDirective = buildVoiceDirective(rolledHex);
        const hexBandLine = describeHex(rolledHex);

        // ---- (B) RENDER — model renders the fixed skeleton into world flavour (no hex) ----
        const renderPrompt = buildRenderPrompt({
            npcName,
            recentHistory,
            existingLedger,
            matureMode,
            primaryGroup: primary,
            secondaryGroup: secondary,
            hexBandLine,
            looksTier,
            voiceDirective,
        });

        const { parsed } = await sendMessageAndParseJson(provider, [{ role: 'user', content: renderPrompt }], 'NPC Generator');

        const newEntry: NPCEntry = {
            id: uid(),
            name: coerceStringField(parsed.name) || npcName,
            aliases: coerceStringField(parsed.aliases),
            status: coerceStringField(parsed.status, 'Alive'),
            faction: coerceStringField(parsed.faction, 'Unknown'),
            storyRelevance: coerceStringField(parsed.storyRelevance, 'Unknown'),
            // One appearance paragraph. A model that still sends the retired structured
            // "visualProfile" only fills a blank appearance from it.
            appearance: coerceStringField(parsed.appearance) || visualProfileToProse(parsed.visualProfile),
            voice: coerceStringField(parsed.voice),
            personality: coerceStringField(parsed.personality, 'Unknown'),
            exampleOutput: coerceStringField(parsed.exampleOutput),
            // One motive system: agency wants below (short/medium pool draws + the model's
            // longWant). No drives/goals/disposition/affinity — retired 2026-11-01; any of
            // those keys the model still sends is ignored.
            behavioralTriggers: Array.isArray(parsed.behavioralTriggers)
                ? parsed.behavioralTriggers.filter((t: Record<string, unknown>) => t.keyword && t.shift).map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }))
                : undefined,
            hardBoundaries: Array.isArray(parsed.hardBoundaries)
                ? parsed.hardBoundaries.map(String).filter(Boolean)
                : undefined,
            softBoundaries: Array.isArray(parsed.softBoundaries)
                ? parsed.softBoundaries.map(String).filter(Boolean)
                : undefined,
        };

        // Phase-1 refit: hex comes from the ROLL (rolledHex), NOT the model. Traits come from
        // anchorTraits + engine-drawn consistent traits (finalTraits), NOT the model. The model's
        // traits/personalityHex in `parsed` are ignored on the new path.
        const longWantStr = coerceStringField(parsed.longWant).trim();
        const longWant = longWantStr
            ? longWantStr
            : defaultLongWant(newEntry.faction);
        newEntry.traits = finalTraits;
        newEntry.wants = {
            short: drawShortWants({ matureMode, traits: finalTraits, rng }),
            medium: drawMediumWants({ matureMode, traits: finalTraits, rng }),
            long: longWant,
        };
        newEntry.personalityHex = rolledHex;
        newEntry.primaryGroup = primary;
        newEntry.secondaryGroup = secondary;
        newEntry.region = coerceStringField(parsed.region);
        newEntry.populated = true;
        // B2 — Generated NPCs are born populated:true, and the lazy fill skips populated NPCs,
        // so home pcRelation at birth (Neutral). Never clobber an explicit value.
        if (newEntry.pcRelation === undefined) newEntry.pcRelation = 0;
        // Scene-type tags per profile field for smart context injection.
        newEntry.fieldTags = buildDefaultFieldTags(newEntry);
        // Phase-3: seed Goal records from the new medium/long wants (engine layer; hidden cols).
        newEntry.goalRecords = buildGoalsFromWants(newEntry.wants.medium, newEntry.wants.long, finalTraits, 0);
        // NPC Signature Kit (v1) — durable loadout seeded from the render call. `undefined`
        // (empty kit) is fine and expected for plain characters. Bounded by sanitizeSignatureKit.
        newEntry.signatureKit = sanitizeSignatureKit(parsed?.signatureKit);

        addNPCToStore(newEntry);
        console.log(`[NPC Generator] Successfully generated and added profile for: ${newEntry.name} (primaryGroup=${primary}, secondaryGroup=${secondary ?? 'none'})`);

    } catch (err) {
        console.error('[NPC Generator] Fatal error during generation:', err);
    }
}

type ProposeResult = { candidateGroups: string[]; anchorTraits: string[] };

/**
 * Call A (PROPOSE) — cheap/util provider. The model proposes a world-appropriate set of abstract
 * SOCIAL groups (keys from GROUP_KEYS) + up to 2 anchor traits (from the controlled vocab). Pure
 * semantics — what the NPC is good at / what groups plausibly appear here. Validates/whiteleists
 * both; on empty/garbage, falls back to all GROUP_KEYS + no anchors. Never throws; on any failure
 * returns the safe fallback.
 */
async function proposeGroupsAndTraits(
    provider: EndpointConfig | ProviderConfig,
    recentHistory: string,
    existingLedger: NPCEntry[] | undefined,
    matureMode: boolean,
): Promise<ProposeResult> {
    const fallback: ProposeResult = { candidateGroups: Array.from(GROUP_KEYS), anchorTraits: [] };
    const rosterLine = existingLedger && existingLedger.length > 0
        ? `EXISTING ROSTER (for contrast — propose groups that distinguish this NPC from these): ${existingLedger.map(n => n.name).join(', ')}`
        : '';

    const prompt = renderPrompt('npc.propose-archetypes', {
        groups: Array.from(GROUP_KEYS).join(', '),
        matureNote: matureMode ? ' (mature allowed)' : ' (mature tier NOT allowed)',
        traits: offeredTraitNames(matureMode).join(', '),
        roster: rosterLine ? `\n\n${rosterLine}` : '',
        scene: recentHistory,
    });

    try {
        const { parsed } = await sendMessageAndParseJson(provider, [{ role: 'user', content: prompt }], 'NPC Propose');
        const candidateGroups = Array.isArray(parsed.candidateGroups)
            ? (parsed.candidateGroups as unknown[]).map(g => String(g).toLowerCase().trim()).filter(Boolean)
            : [];
        const anchorTraits = Array.isArray(parsed.anchorTraits)
            ? (parsed.anchorTraits as unknown[]).map(g => String(g).toLowerCase().trim()).filter(Boolean)
            : [];
        return { candidateGroups, anchorTraits };
    } catch (err) {
        console.warn('[NPC Propose] Falling back to all GROUP_KEYS + no anchors:', err);
        return fallback;
    }
}

type RenderPromptOpts = {
    npcName: string;
    recentHistory: string;
    existingLedger: NPCEntry[] | undefined;
    matureMode: boolean;
    primaryGroup: string;
    secondaryGroup: string | undefined;
    hexBandLine: string;
    looksTier: 'attractive' | 'plain' | 'ugly';
    voiceDirective: string;
};

/**
 * Call B (RENDER) — build the profile-render prompt. The model renders the fixed skeleton into
 * world flavour: appearance, voice, personality, exampleOutput, storyRelevance, longWant. It
 * NEVER emits `personalityHex` or numeric axes — the hex comes from the engine roll. The rolled
 * hex band-words + looksTier + axis-keyed voice directive (WO-5) constrain voice/exampleOutput so
 * they're a function of the numbers, not a generic default.
 */
function buildRenderPrompt(opts: RenderPromptOpts): string {
    const { npcName, recentHistory, existingLedger, matureMode, primaryGroup, secondaryGroup, hexBandLine, looksTier, voiceDirective } = opts;

    const voiceSection = voiceDirective
        ? `VOICE DIRECTION (axis extremes — the exampleOutput/voice MUST express these):\n${voiceDirective}\n\n`
        : '';

    const reservedNames = (existingLedger ?? []).map(n => n.name?.trim()).filter(Boolean) as string[];
    const reservedNamesSection = reservedNames.length > 0
        ? `\nRESERVED NAMES — already used by existing characters. The profile's "name" and "aliases" must NOT collide with any of these (a shared family surname is acceptable only with an explicit in-story relation; never a first name): ${reservedNames.join(', ')}`
        : '';

    return renderPrompt('npc.render-profile', {
        primaryGroup,
        secondaryGroup: secondaryGroup ?? 'none',
        personality: hexBandLine,
        looksTier,
        voiceDirection: voiceSection,
        traits: offeredTraitNames(matureMode).join(', '),
        npcName,
        reservedNames: reservedNamesSection,
        chatHistory: recentHistory,
    });
}