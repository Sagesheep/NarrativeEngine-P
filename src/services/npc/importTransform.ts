import type { NPCEntry } from '../../types';

/**
 * Cross-campaign NPC import modes.
 *
 * An exported NPC carries fields bound to its *origin* campaign — plot hooks,
 * immediate goals, factions/regions, and NPC→NPC edges keyed by ids that don't
 * exist in the destination campaign. Injected verbatim into the GM prompt, the
 * narrative-text fields make the model reference people/places/events that
 * aren't in this world (hallucinated "past campaign" facts).
 *
 *  - `full`   — import verbatim. User accepts that origin-campaign details may surface.
 *  - `strip`  — clear the plot-bound / dangling fields → a clean local NPC that keeps
 *               only intrinsic identity (appearance, voice, personality, skills, ambitions).
 *  - `isekai` — full import + a framing note so the GM treats the foreign memories as the
 *               character's *past-life recollections* from another world. Turns the leak
 *               into intentional transmigration flavor instead of broken canon.
 */
export type NpcImportMode = 'full' | 'strip' | 'isekai';

/** Neutral NPC→PC stance (band is -3..+3, 0 = neutral). */
const NEUTRAL_PC_RELATION = 0;

const ISEKAI_FRAMING =
    '[TRANSMIGRATED] This character arrived from another world. Any people, places, ' +
    'organizations, or events referenced below are their memories from that other world — ' +
    'they do NOT exist in this campaign. Treat them as the character\'s subjective past-life ' +
    'recollections, never as established facts of the current story.';

/**
 * Normalize a raw imported entry into a complete NPCEntry with a fresh id and
 * all required scalar fields defaulted. Mirrors the historical inline import
 * mapping so `full` mode stays byte-for-byte identical to the old behavior.
 */
function normalize(entry: Partial<NPCEntry>, newId: string): NPCEntry {
    return {
        ...entry,
        id: newId,
        name: entry.name || 'Unknown',
        aliases: entry.aliases || '',
        appearance: entry.appearance || '',
        faction: entry.faction || '',
        storyRelevance: entry.storyRelevance || '',
        disposition: entry.disposition || '',
        status: entry.status || 'Alive',
        goals: entry.goals || '',
        voice: entry.voice ?? '',
        personality: entry.personality ?? entry.disposition ?? '',
        exampleOutput: entry.exampleOutput ?? '',
        affinity: entry.affinity ?? 50,
    } as NPCEntry;
}

/**
 * Remove the fields bound to the origin campaign. Keeps intrinsic identity:
 * appearance, visualProfile, voice, personality, disposition, faction, aliases,
 * signature *abilities*, personality machinery (drives/triggers/hex/traits), and
 * long-horizon `goalRecords` (the NPC's own ambitions, not this campaign's plot).
 */
function stripCampaignBoundFields(npc: NPCEntry): NPCEntry {
    const cleaned: NPCEntry = { ...npc };

    // Plot-bound narrative text — the primary hallucination vectors.
    cleaned.storyRelevance = '';   // e.g. "…the stolen Warder's Knot seal … Lord Vex's investigation"
    cleaned.goals = '';            // immediate objective, e.g. "Escape the manor with the seal"

    // Reset stance toward the (now different) player character.
    cleaned.pcRelation = NEUTRAL_PC_RELATION;

    // Dangling references into the origin campaign's world graph.
    delete cleaned.region;
    delete cleaned.haunt;
    delete cleaned.primaryGroup;
    delete cleaned.secondaryGroup;
    delete cleaned.relations;      // NPC→NPC edges keyed by origin-campaign ids

    // Signature kit: keep intrinsic abilities/element, drop equipment (often plot loot,
    // e.g. "Warder's Knot seal"). Drop the kit entirely if nothing intrinsic remains.
    if (cleaned.signatureKit) {
        const abilities = cleaned.signatureKit.abilities ?? [];
        if (abilities.length === 0) {
            delete cleaned.signatureKit;
        } else {
            cleaned.signatureKit = { ...cleaned.signatureKit, equipment: [] };
        }
    }

    return cleaned;
}

/**
 * Full import + transmigration framing. Prepends the isekai framing note to
 * `storyRelevance` (already injected into the GM prompt, so no new plumbing) and
 * stamps `transmigrated` for UI/badging. If the NPC had no storyRelevance, the
 * framing still lands so the GM knows the character is a world-crosser.
 */
function applyIsekaiFraming(npc: NPCEntry): NPCEntry {
    const existing = npc.storyRelevance?.trim();
    const storyRelevance = existing ? `${ISEKAI_FRAMING}\n\n${existing}` : ISEKAI_FRAMING;
    return { ...npc, transmigrated: true, storyRelevance };
}

/**
 * Prepare a parsed export array for insertion into the active campaign under the
 * chosen import mode. `makeId` mints a fresh id per NPC (old ids belong to the
 * origin campaign and must not collide here).
 */
export function prepareImportedNpcs(
    parsed: Partial<NPCEntry>[],
    mode: NpcImportMode,
    makeId: () => string,
): NPCEntry[] {
    return parsed.map((entry) => {
        const base = normalize(entry, makeId());
        if (mode === 'strip') return stripCampaignBoundFields(base);
        if (mode === 'isekai') return applyIsekaiFraming(base);
        return base; // 'full'
    });
}
