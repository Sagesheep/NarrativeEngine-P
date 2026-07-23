import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry, PersonalityHex, HexAxis, RelationGraph } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessageAndParseJson, sanitizeSignatureKit } from './shared';
import { relationBand, describeHex } from '../npc/agency/agencyBands';
import { hexDelta } from '../npc/agency/agencyDrift';
import { applyRelationTone, isRelationTone } from '../npc/relationMeter';

// Mirrors the private descriptor in mobile npcGeneration.ts. Used only for read-only legacy
// display in the LLM context block (so the model understands pre-migration NPCs without us
// ever asking it to write a raw 0-100 affinity number).
function legacyAffinityDescriptor(v: number): string {
    if (v <= 15) return 'Nemesis';
    if (v <= 30) return 'Distrustful';
    if (v <= 45) return 'Wary';
    if (v <= 55) return 'Neutral';
    if (v <= 70) return 'Warm';
    if (v <= 85) return 'Trusted';
    return 'Devoted';
}

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Phase-4 schema: the LLM is shown the new fields (wants / personalityHex / pcRelation / traits /
 * region / relations) and may propose DRIFTS for them. Legacy `drives` and raw `affinity` are
 * read-only — they are shown to the model only so pre-migration NPCs make sense, but never written.
 *
 * Delta-only fields (pcRelation, personalityHex) are clamped on parse: a "+5" still moves +1.
 * `relations` is a sparse shallow-merge, never a wholesale replace. `wants.short` is engine-only
 * and always preserved.
 */
export async function updateExistingNPCs(
    provider: EndpointConfig | ProviderConfig,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void
) {
    if (!npcsToCheck.length) return;

    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        // WO-05 §A — send the Phase-4 truth, NOT legacy. No raw 0–100 affinity; no drives.
        const pcRelationBand = npc.pcRelation !== undefined
            ? `${relationBand(npc.pcRelation)} (${npc.pcRelation >= 0 ? '+' : ''}${npc.pcRelation})`
            : (npc.affinity !== undefined ? `${legacyAffinityDescriptor(npc.affinity)} (${npc.affinity}/100 legacy)` : 'Neutral (0)');

        let data = `[NPC: ${npc.name}]\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Disposition: ${npc.disposition || 'Unknown'}\n` +
            `Goals: ${npc.goals || 'Unknown'}\n` +
            `Feeling toward PC: ${pcRelationBand}\n` +
            `Personality: ${npc.personality || npc.disposition || 'Unknown'}\n` +
            `Voice: ${npc.voice || 'not defined'}\n` +
            `Faction: ${npc.faction || 'Unknown'}\n` +
            `Story Relevance: ${npc.storyRelevance || 'Unknown'}\n`;

        // WO-05 §A — wants (Phase-4 source of truth), NOT drives. Send medium/long only; `short`
        // is no-LLM and is preserved on the parse side. Legacy drives are read-only fallback.
        if (npc.wants && (npc.wants.long || npc.wants.medium?.length)) {
            data += `LongWant: ${npc.wants.long || 'Unknown'}\n` +
                `MediumWants: ${npc.wants.medium?.join(' | ') || 'none'}\n`;
        }

        if (npc.personalityHex) {
            data += `PersonalityHex: ${describeHex(npc.personalityHex)}\n`;
        }

        // NPC Signature Kit (v1) — show the current durable loadout so the model can
        // decide if a narrated event changed it. Absent = no kit (plain character).
        if (npc.signatureKit) {
            const k = npc.signatureKit;
            data += `SignatureKit: gear=[${k.equipment.join(', ') || 'none'}] powers=[${k.abilities.join(', ') || 'none'}]${k.element ? ` element=${k.element}` : ''}\n`;
        }

        if (npc.traits && npc.traits.length > 0) {
            data += `Traits: ${npc.traits.join(', ')}\n`;
        }

        if (npc.region) {
            data += `Region: ${npc.region}\n`;
        }

        if (npc.behavioralTriggers && npc.behavioralTriggers.length > 0) {
            data += `Triggers: ${npc.behavioralTriggers.map(t => `"${t.keyword}" → ${t.shift}`).join('; ')}\n`;
        }

        // Visual profile fill (unchanged from legacy behaviour).
        const vp = npc.visualProfile || { race: '', gender: '', ageRange: '', build: '', symmetry: '', hairStyle: '', eyeColor: '', skinTone: '', gait: '', distinctMarks: '', clothing: '' };
        const missingFields = Object.entries(vp)
            .filter(([key, val]) => key !== 'artStyle' && (!val || val === 'Unknown' || val === 'None'))
            .map(([key]) => key);
        if (missingFields.length > 0) {
            data += `NOTE: This NPC has missing or generic "visualProfile" fields: ${missingFields.join(', ')}. You MUST attempt to determine specific values for these based on their "Appearance" and recent context.\n`;
        }

        return data;
    }).join('\n\n');

    const prompt = `You are a background game state analyzer. Your job is to read the RECENT CONTEXT of an RPG session and determine if any of the provided NPCs have undergone a shift in their status, personality, goals, disposition, faction, or relevance.

OUTPUT FORMAT — a single JSON object with TWO channels: "updates" (rare) and "tones" (always):
{"updates": [ ... ], "tones": [ ... ]}

CHANNEL 1 — "updates" (only when something fundamentally changed; usually empty []):
{"updates": [{"name": "<NPC name>", "changes": { ...only the fields that changed... }}]}
Each update MUST include "name" and only the fields that fundamentally changed. Allowed changes keys:
  status, disposition, goals, storyRelevance, personality (flavor text), voice, appearance,
  wants (medium/long text only — NEVER include "short"; short is engine-managed),
  personalityHex, traits, region, faction (can list multiple comma-separated factions), relations, behavioralTriggers, hardBoundaries, softBoundaries, visualProfile, signatureKit.
DO NOT include attributes that stayed the same. If nothing fundamental changed, "updates" is [].

CHANNEL 2 — "tones" (MANDATORY: one entry for EVERY NPC listed below, every time):
{"tones": [{"name": "<NPC name>", "tone": "<friendly|tense|neutral|bonding|betrayal>"}]}
Judge how THIS scene felt for each NPC toward the player. This is your ONLY job re: relationship —
the engine owns the actual standing; you just read the room:
  - friendly : player was warm/helpful/pleasant (ordinary positive interaction)
  - tense    : friction, rudeness, a slight, a minor argument
  - neutral  : no social charge — logistics, passing by, all business (USE THIS WHEN UNSURE)
  - bonding  : a BIG shared-adversity / deep-trust moment (fought side by side, saved their life)
  - betrayal : player broke trust — deceived, harmed, or abandoned them in a serious way
Most scenes are "neutral", "friendly", or "tense". Reserve "bonding"/"betrayal" for genuinely big
moments — they move the needle hard.

**FORBIDDEN keys** in "changes" (data-model errors):
  - "drives" — superseded by "wants". Never send drives.
  - "affinity" / "pcRelation" — the relationship standing is ENGINE-OWNED. NEVER send either; use
    the "tones" channel instead. Any affinity/pcRelation you put in "changes" is discarded.

PERSONALITY HEX DRIFT (the headline of "updates"):
  - "personalityHex" is a DELTA MAP, not a full overwrite. Send ONLY the axes that drifted, as
    small integers: e.g. {"personalityHex": {"boldness": +1, "composure": -1}}.
  - Each axis delta is clamped to ±1 by the engine; a "+5" still moves only +1. Drift is rare and
    small — only send a hex delta when the scene contains a genuinely transformative event.
  - NEVER re-emit the full 6-axis hexagon. NEVER send absolute axis values as if setting them.

RELATIONS:
  - "relations" is a sparse NPC→character edge map (target NPC or Player Character id → -3..+3). Shallow-merge only;
    never wholesale replace. Add or adjust specific edges that shifted this scene.

WANTS UPDATE RULES:
  - "wants" is an object with "short" (string[]), "medium" (string[]), and "long" (string).
  - You may ONLY revise "medium" and "long". NEVER include "short" — it is engine-managed and
    always preserved. If you include "short", it will be discarded.
  - "long" is a single overarching life goal — update only if a transformative event reshaped it.
  - "medium" is arc-level goal templates — update if the story moved to a new arc.
  - If the NPC has no "wants" yet, you MUST provide "medium" and "long".

SIGNATURE KIT RULES:
  - "signatureKit" is this NPC's durable loadout: {"equipment": string[], "abilities": string[], "element": string}. It keeps gear and powers CONSISTENT across the campaign.
  - Only send it when the scene NARRATES a real change: the NPC gains/loses/breaks a signature item, learns or loses a power, or is transformed. An NPC merely *using* gear they already have is NOT a change — send nothing.
  - Send ONLY the channel that changed. To update gear, send just "equipment" (the full new signature list, max 8); to update powers, send just "abilities". Never re-emit an unchanged channel.
  - Default is NO change. Most turns have no signatureKit update.

GENERAL RULES:
- Valid statuses: Alive, Deceased, Missing, Unknown.
- Do NOT change personality or voice unless the scene contains a genuinely transformative event for this character.

EXAMPLES:

GOOD — NPC who died with a transformative emotional arc:
{"updates": [{"name": "Captain Vorin", "changes": {"status": "Deceased", "personality": "consumed by rage in final moments, betrayed and broken", "storyRelevance": "His death sparked a rebellion"}}]}

GOOD — NPC whose mid/long-term ambition shifted after a major scene (only revise "wants" medium/long; NEVER include "short"):
{"updates": [{"name": "Kael", "changes": {"wants": {"long": "seize the Ironwall garrison and rule the pass himself", "medium": ["turn the captain's lieutenants against her", "stockpile blackpowder"]}}}]}

GOOD — NPC who grew bolder after a crit-success on a bold goal (hex DRIFT, delta-only):
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"boldness": +1}}}]}

GOOD — ordinary scene, nothing fundamental changed, but two NPCs were on stage (note: "updates" empty, "tones" still lists EVERYONE):
{"updates": [], "tones": [{"name": "Alden", "tone": "friendly"}, {"name": "Senna", "tone": "neutral"}]}

GOOD — the player saved Kael's life in a desperate fight (a bonding moment) while snubbing Vorin:
{"updates": [], "tones": [{"name": "Kael", "tone": "bonding"}, {"name": "Vorin", "tone": "tense"}]}

BAD — re-emitting unchanged attributes (status/personality/voice/appearance all unchanged here):
{"updates": [{"name": "Senna", "changes": {"status": "Alive", "personality": "warm and curious", "voice": "soft alto", "appearance": "tall, dark hair"}}]}
Corrected: include ONLY the field that changed —
{"updates": [{"name": "Senna", "changes": {"personality": "warm but watchful after the ambush"}}]}

BAD — sending a FORBIDDEN/engine-owned key (drives / affinity / pcRelation):
{"updates": [{"name": "Senna", "changes": {"drives": {"sceneWant": "investigate the tracks at dawn"}, "affinity": 65, "pcRelation": +1}}]}
Corrected — use "wants" for ambition, and put the relationship read in the "tones" channel (NOT changes):
{"updates": [{"name": "Senna", "changes": {"wants": {"medium": ["investigate the tracks at dawn"]}}}], "tones": [{"name": "Senna", "tone": "friendly"}]}

BAD — re-emitting the full hexagon as absolute values (this is a full-overwrite attempt; the engine will clamp it to ±1 anyway, but it signals a misunderstanding):
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"drive": 2, "diligence": 1, "boldness": 3, "warmth": 0, "empathy": 1, "composure": 2}}]}
Corrected — send ONLY the axis that drifted, as a small delta:
{"updates": [{"name": "Alden", "changes": {"personalityHex": {"boldness": +1}}}]}

GOOD — NPC's signature weapon changed on-screen (only the gear channel; powers untouched):
{"updates": [{"name": "Rick", "changes": {"signatureKit": {"equipment": ["iron spear"]}}}]}

BAD — re-emitting the unchanged kit because the NPC simply swung their existing sword:
{"updates": [{"name": "Rick", "changes": {"signatureKit": {"equipment": ["Excalibur (holy longsword)"], "abilities": ["fire magic"]}}}]}
Corrected: the loadout did not change — send no signatureKit at all.

[RECENT CONTEXT]
${recentContext}
[END CONTEXT]

[CURRENT NPC STATES]
${npcDatas}
[END STATES]

RESPOND ONLY WITH VALID JSON. NO MARKDOWN FORMATTING. NO EXPLANATIONS.`;

    const messages: OpenAIMessage[] = [{
        role: 'user',
        content: prompt,
    }];

    try {
        const { parsed } = await sendMessageAndParseJson(provider, messages, 'NPC Updater', 'npc-update');

        const findTarget = (name: string) => npcsToCheck.find(n =>
            n.name?.toLowerCase() === name.toLowerCase() ||
            (n.aliases && n.aliases.toLowerCase().includes(name.toLowerCase()))
        );

        // Relationship meter (engine-owned affinity): the AI only labels each NPC's scene TONE; the
        // engine rolls that into the hidden sub-band meter and flips pcRelation on threshold crossings.
        // Build the band/meter patches up front so they can fold into the matching `updates` entry
        // (shared previousSnapshot) and so tone-only NPCs (the common case) get applied below.
        const tonePatchById = new Map<string, Partial<NPCEntry>>();
        if (Array.isArray(parsed?.tones)) {
            for (const t of parsed.tones) {
                if (!t?.name || !isRelationTone(t.tone)) continue;
                const target = findTarget(t.name);
                if (!target || target.isPC) continue;
                const patch = applyRelationTone(target, t.tone);
                if (Object.keys(patch).length > 0) tonePatchById.set(target.id, patch);
            }
        }
        const handledToneIds = new Set<string>();

        if (parsed?.updates && Array.isArray(parsed.updates)) {
            for (const update of parsed.updates) {
                if (!update.name || !update.changes) continue;

                const targetNpc = findTarget(update.name);

                if (targetNpc) {
                    const changes = { ...update.changes } as Partial<NPCEntry>;

                    // WO-05 §B — defensively strip FORBIDDEN/engine-owned keys. The parse must never
                    // write a superseded or engine-owned field from the model. `drives`/`affinity` are
                    // legacy; `pcRelation` is now engine-owned (moves only via the tone meter below), so
                    // any band the model puts in `changes` is discarded.
                    delete (changes as Partial<NPCEntry>).drives;
                    delete (changes as Partial<NPCEntry>).affinity;
                    delete (changes as Partial<NPCEntry>).pcRelation;

                    // Fold this NPC's tone-driven band/meter move into the same patch so the snapshot
                    // logic below captures the pre-change band for the drift alert.
                    const tonePatch = tonePatchById.get(targetNpc.id);
                    if (tonePatch) {
                        Object.assign(changes, tonePatch);
                        handledToneIds.add(targetNpc.id);
                    }

                    // WO-05 §C — capture the pre-change state into `previousSnapshot` so the
                    // `buildDriftAlert` consumer can surface a SHIFT word-band on the next payload
                    // read. Capture personality/voice (legacy drift), personalityHex (hex drift),
                    // pcRelation (relation drift), and skillRung (rung drift). Only snapshot fields
                    // that are present and might change.
                    const hasPersonalityChange = changes.personality !== undefined || changes.voice !== undefined;
                    const hasHexChange = changes.personalityHex !== undefined;
                    const hasPcRelationChange = changes.pcRelation !== undefined;
                    const hasRungChange = changes.skillRung !== undefined;
                    if (hasPersonalityChange || hasHexChange || hasPcRelationChange || hasRungChange) {
                        changes.previousSnapshot = {
                            personality: targetNpc.personality || targetNpc.disposition || '',
                            voice: targetNpc.voice || '',
                            affinity: targetNpc.affinity,
                            personalityHex: targetNpc.personalityHex,
                            pcRelation: targetNpc.pcRelation,
                            skillRung: targetNpc.skillRung,
                        };
                        changes.shiftTurnCount = 0;
                    } else if (targetNpc.shiftTurnCount !== undefined && targetNpc.shiftTurnCount < 3) {
                        changes.shiftTurnCount = (targetNpc.shiftTurnCount || 0) + 1;
                    }

                    if (changes.visualProfile && typeof changes.visualProfile === 'object') {
                        changes.visualProfile = {
                            ...targetNpc.visualProfile,
                            ...changes.visualProfile,
                            artStyle: targetNpc.visualProfile?.artStyle || 'Anime'
                        };
                    }

                    // (pcRelation is engine-owned now — set above from the tone meter, already clamped;
                    // the model never supplies a band delta here.)

                    // WO-05 §A — personalityHex DELTA-ONLY. Each axis value is treated as a delta and
                    // applied via `hexDelta`, which clamps the step to ±HEX_DRIFT_MAX_STEP and the
                    // result to −3..+3. A full-overwrite attempt ("5" on every axis) is neutralized:
                    // hexDelta treats each value as a delta, so a "5" becomes +1. Only apply when
                    // the NPC already has a personalityHex.
                    if (changes.personalityHex !== undefined && changes.personalityHex !== null
                        && typeof changes.personalityHex === 'object' && targetNpc.personalityHex) {
                        const incoming = changes.personalityHex as Record<HexAxis, number>;
                        let merged: PersonalityHex = { ...targetNpc.personalityHex };
                        for (const axis of HEX_AXES) {
                            if (incoming[axis] !== undefined && typeof incoming[axis] === 'number' && Number.isFinite(incoming[axis])) {
                                merged = hexDelta(merged, axis, incoming[axis]);
                            }
                        }
                        changes.personalityHex = merged;
                    } else {
                        delete (changes as Partial<NPCEntry>).personalityHex;
                    }

                    // WO-05 §B — relations: sparse edge add/update, shallow-merge into existing.
                    if (changes.relations !== undefined && changes.relations !== null
                        && typeof changes.relations === 'object') {
                        const existing = targetNpc.relations ?? {};
                        const incoming = changes.relations as RelationGraph;
                        changes.relations = { ...existing, ...incoming };
                    }

                    // Wants — the model may revise medium/long ambition text only. `short` is
                    // no-LLM and is always preserved.
                    if (changes.wants && typeof changes.wants === 'object') {
                        const existingWants = targetNpc.wants || { short: [], medium: [], long: '' };
                        const incoming = changes.wants as Partial<NPCEntry['wants']>;
                        changes.wants = {
                            short: existingWants.short,
                            medium: Array.isArray(incoming?.medium)
                                ? incoming!.medium.map(String).filter(Boolean)
                                : existingWants.medium,
                            long: (typeof incoming?.long === 'string' && incoming.long.trim())
                                ? incoming.long.trim()
                                : existingWants.long,
                        };
                    }

                    // NPC Signature Kit (v1) — sanitize + per-channel supersession merge. The
                    // model only sends the channel that changed; the untouched channel is preserved
                    // by the merge. Empty result (kit fully cleared) deletes the field.
                    if (changes.signatureKit !== undefined) {
                        const merged = sanitizeSignatureKit(changes.signatureKit, targetNpc.signatureKit);
                        if (merged) changes.signatureKit = merged;
                        else delete (changes as Partial<NPCEntry>).signatureKit;
                    }

                    if (Array.isArray(changes.behavioralTriggers)) {
                        changes.behavioralTriggers = changes.behavioralTriggers
                            .filter((t: Record<string, unknown>) => t.keyword && t.shift)
                            .map((t: Record<string, unknown>) => ({ keyword: String(t.keyword), shift: String(t.shift) }));
                    }

                    if (Array.isArray(changes.hardBoundaries)) {
                        changes.hardBoundaries = changes.hardBoundaries.map(String).filter(Boolean);
                    }

                    if (Array.isArray(changes.softBoundaries)) {
                        changes.softBoundaries = changes.softBoundaries.map(String).filter(Boolean);
                    }

                    updateNPCStore(targetNpc.id, changes);
                    console.log(`[NPC Updater] Applied changes to ${targetNpc.name}:`, changes);
                }
            }
        } else {
            console.log(`[NPC Updater] No updates required.`);
        }

        // Tone-only NPCs: the common case — an ordinary scene with no fundamental change, so the NPC
        // had no `updates` entry, but its tone still moved the relationship meter. Apply those band/
        // meter patches here, mirroring the band-drift snapshot so buildDriftAlert can surface a
        // "feeling toward PC X → Y" shift.
        for (const [id, patch] of tonePatchById) {
            if (handledToneIds.has(id)) continue;
            const target = npcsToCheck.find(n => n.id === id);
            if (!target) continue;
            const changes: Partial<NPCEntry> = { ...patch };
            if (changes.pcRelation !== undefined) {
                changes.previousSnapshot = {
                    personality: target.personality || target.disposition || '',
                    voice: target.voice || '',
                    affinity: target.affinity,
                    personalityHex: target.personalityHex,
                    pcRelation: target.pcRelation,
                    skillRung: target.skillRung,
                };
                changes.shiftTurnCount = 0;
            }
            updateNPCStore(id, changes);
            console.log(`[NPC Updater] Relationship meter moved ${target.name}:`, changes);
        }
    } catch (err) {
        console.error('[NPC Updater] Failed to parse generated JSON or fatal error:', err);
    }
}