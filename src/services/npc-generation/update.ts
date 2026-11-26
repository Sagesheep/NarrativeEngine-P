import type { EndpointConfig, ProviderConfig, ChatMessage, NPCEntry, PersonalityHex, HexAxis, RelationGraph } from '../../types';
import type { OpenAIMessage } from '../llm/llmService';
import { sendMessageAndParseJson, sanitizeSignatureKit, type JsonModelCall } from './shared';
import { relationBand, describeHex } from '../npc/agency/agencyBands';
import { hexDelta } from '../npc/agency/agencyDrift';
import { applyRelationTone, isRelationTone } from '../npc/relationMeter';
import { normalizeRelations } from '../npc/relationDedupe';
import { readPcAffinity } from '../npc/affinityAccess';
import type { LegacyNpcFields } from '../npc/retireLegacyFields';
import { renderPrompt } from '../prompts/promptRegistry';

const HEX_AXES: readonly HexAxis[] = ['drive', 'diligence', 'boldness', 'warmth', 'empathy', 'composure'];

/**
 * Background auto-update for existing NPCs that were mentioned in the chat.
 * Phase-4 schema: the LLM is shown the new fields (wants / personalityHex / pcRelation / traits /
 * region / relations) and may propose DRIFTS for them. The retired `drives` / `affinity` /
 * `disposition` / `goals` are never shown, and are stripped if the model sends them anyway.
 *
 * Delta-only fields (pcRelation, personalityHex) are clamped on parse: a "+5" still moves +1.
 * `relations` is a sparse shallow-merge, never a wholesale replace. `wants.short` is engine-only
 * and always preserved.
 *
 * Resolves false when the model call or the JSON parse failed, so the caller can leave the
 * NPCs' update cooldown unspent and try again next time they appear.
 */
export async function updateExistingNPCs(
    provider: EndpointConfig | ProviderConfig | undefined,
    history: ChatMessage[],
    npcsToCheck: NPCEntry[],
    updateNPCStore: (id: string, updates: Partial<NPCEntry>) => void,
    modelCall?: JsonModelCall,
    options?: { relationshipMemoryEnabled?: boolean },
): Promise<boolean> {
    if (!npcsToCheck.length) return true;

    console.log(`[NPC Updater] Checking for attribute shifts on ${npcsToCheck.length} existing NPC(s)...`);

    const recentContext = history.slice(-5).map(m => `${m.role.toUpperCase()}: ${m.content}`).join('\n\n');

    const npcDatas = npcsToCheck.map(npc => {
        // WO-05 §A — send the Phase-4 truth, NOT legacy. No raw 0–100 affinity; no drives.
        const affinityRead = readPcAffinity(npc, options?.relationshipMemoryEnabled);
        const pcRelationBand = affinityRead.kind === 'stance'
            ? 'Relationship memory is the source of truth; do not infer a scalar relationship.'
            : affinityRead.kind === 'pcRelation'
                ? `${relationBand(affinityRead.value)} (${affinityRead.value >= 0 ? '+' : ''}${affinityRead.value})`
                : 'Neutral (0)';

        let data = `[NPC: ${npc.name}] (ID: ${npc.id})\n` +
            `Status: ${npc.status || 'Alive'}\n` +
            `Appearance: ${npc.appearance || 'Unknown'}\n` +
            `Feeling toward PC: ${pcRelationBand}\n` +
            `Personality: ${npc.personality || 'Unknown'}\n` +
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

        return data;
    }).join('\n\n');

    const prompt = renderPrompt('npc.update', { recentContext, npcStates: npcDatas });

    const messages: OpenAIMessage[] = [{
        role: 'user',
        content: prompt,
    }];

    try {
        const { parsed } = await sendMessageAndParseJson(provider, messages, 'NPC Updater', 'npc-update', modelCall);

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
                const patch = applyRelationTone(target, t.tone, Math.random, options?.relationshipMemoryEnabled);
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
                    // write a superseded or engine-owned field from the model. `drives`/`affinity`/
                    // `disposition`/`goals`/`visualProfile` are retired; `pcRelation` is engine-owned
                    // (moves only via the tone meter below), so any band the model sends is discarded.
                    // `artStyle` is the user's pick and never the model's.
                    const legacy = changes as Partial<NPCEntry> & LegacyNpcFields;
                    delete legacy.drives;
                    delete legacy.affinity;
                    delete legacy.disposition;
                    delete legacy.goals;
                    delete legacy.visualProfile;
                    delete legacy.artStyle;
                    delete legacy.pcRelation;

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
                            personality: targetNpc.personality || '',
                            voice: targetNpc.voice || '',
                            personalityHex: targetNpc.personalityHex,
                            pcRelation: targetNpc.pcRelation,
                            skillRung: targetNpc.skillRung,
                        };
                        changes.shiftTurnCount = 0;
                    } else if (targetNpc.shiftTurnCount !== undefined && targetNpc.shiftTurnCount < 3) {
                        changes.shiftTurnCount = (targetNpc.shiftTurnCount || 0) + 1;
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

                    // WO-05 §B — relations: sparse edge add/update, normalized to canonical IDs and shallow-merged into existing.
                    if (changes.relations !== undefined && changes.relations !== null
                        && typeof changes.relations === 'object') {
                        const existing = targetNpc.relations ?? {};
                        const incoming = changes.relations as RelationGraph;
                        const normalizedIncoming = normalizeRelations(incoming, npcsToCheck);
                        const merged = { ...existing, ...normalizedIncoming };
                        changes.relations = normalizeRelations(merged, npcsToCheck);
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
                    personality: target.personality || '',
                    voice: target.voice || '',
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
        return false;
    }
    return true;
}
