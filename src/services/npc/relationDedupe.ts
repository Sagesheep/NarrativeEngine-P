import type { NPCEntry, RelationGraph } from '../../types';

/**
 * Normalizes an NPC or PC relationship graph so all target keys are canonical character IDs.
 *
 * Incoming edges from LLMs or raw inputs may be keyed by NPC name (e.g. "Captain Vorin"),
 * alias, or player character label ("Player Character"). This function resolves all keys to
 * target IDs (`NPCEntry.id` or `pcId`), dropping unresolvable edges and deduplicating values.
 */
export function normalizeRelations(
    relations: RelationGraph | undefined | null,
    npcLedger: NPCEntry[],
    pcId?: string
): RelationGraph {
    if (!relations || typeof relations !== 'object') return {};

    const normalized: RelationGraph = {};

    const nameMap = new Map<string, string>();
    for (const npc of npcLedger) {
        if (!npc.id) continue;
        if (npc.name) {
            nameMap.set(npc.name.trim().toLowerCase(), npc.id);
        }
        if (npc.aliases) {
            const aliasList = npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean);
            for (const alias of aliasList) {
                if (!nameMap.has(alias)) {
                    nameMap.set(alias, npc.id);
                }
            }
        }
    }

    for (const [key, val] of Object.entries(relations)) {
        if (typeof val !== 'number' || !Number.isFinite(val)) continue;

        const trimmedKey = key.trim();
        const lowerKey = trimmedKey.toLowerCase();
        let canonicalId: string | undefined;

        // 1. Exact match on PC ID or NPC ID
        if (pcId && (trimmedKey === pcId || lowerKey === 'player' || lowerKey === 'player character' || lowerKey === 'player character (player)')) {
            canonicalId = pcId;
        } else if (npcLedger.some(n => n.id === trimmedKey)) {
            canonicalId = trimmedKey;
        } else {
            // 2. Name or Alias lookup
            canonicalId = nameMap.get(lowerKey);
            if (!canonicalId) {
                // Try fuzzy/substring match on first name
                const firstName = lowerKey.split(/\s+/)[0];
                if (firstName && firstName.length > 2) {
                    for (const [name, id] of nameMap.entries()) {
                        if (name.startsWith(firstName)) {
                            canonicalId = id;
                            break;
                        }
                    }
                }
            }
        }

        if (canonicalId) {
            // Clamp relation integer between -3 and +3
            const clampedVal = Math.max(-3, Math.min(3, Math.round(val)));
            normalized[canonicalId] = clampedVal;
        }
    }

    return normalized;
}
