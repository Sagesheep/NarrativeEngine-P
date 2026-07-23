import type { NPCEntry } from '../../../types';
import { HEARTBEAT_DC } from './agencyConstants';
import { isAgencyEligible } from './agencyLifecycle';
import { parseFactions } from '../../campaign-state/knowledgeScope';

export function rollHeartbeat(
    state: { dc: number },
    rng: () => number = Math.random,
): { fired: boolean; nextDc: number } {
    const roll = Math.floor(rng() * 100) + 1;
    if (roll >= state.dc) {
        return { fired: true, nextDc: HEARTBEAT_DC.initial };
    }
    return {
        fired: false,
        nextDc: Math.max(HEARTBEAT_DC.floor, state.dc - HEARTBEAT_DC.reduction),
    };
}

export function buildProximityRoster(
    npcs: NPCEntry[],
    pc: NPCEntry | undefined,
): NPCEntry[] {
    const eligible = npcs.filter(npc => {
        if (!isAgencyEligible(npc)) return false;
        if (npc.tier === 'walkon') return false;
        // WO-04: only populated NPCs tick off-screen. Without the background sweep, an un-mentioned
        // proximate NPC could enter the roster unpopulated and the tick would no-op on it. An NPC
        // only starts living off-screen after you've met them on-stage (populateAgencyFields runs).
        if (!npc.populated) return false;
        return true;
    });

    const pcRegion = pc?.region;
    const pcFactions = parseFactions(pc?.faction);

    const presentIds = new Set<string>();
    if (pc) presentIds.add(pc.id);
    for (const npc of eligible) {
        if (pcRegion && npc.region === pcRegion) {
            presentIds.add(npc.id);
        }
    }

    const npcById = new Map<string, NPCEntry>();
    for (const npc of eligible) npcById.set(npc.id, npc);
    if (pc) npcById.set(pc.id, pc);

    const isProximate = (npc: NPCEntry): boolean => {
        if (pc && npc.id === pc.id) return false;

        if (pcRegion && npc.region === pcRegion) return true;

        if (pcFactions.length > 0 && npc.faction) {
            const npcFactions = parseFactions(npc.faction);
            if (npcFactions.some(f => pcFactions.includes(f))) return true;
        }

        if (npc.relations) {
            for (const targetId of Object.keys(npc.relations)) {
                if (presentIds.has(targetId)) return true;
            }
        }

        for (const presentId of presentIds) {
            const member = npcById.get(presentId);
            if (member?.relations && npc.id in member.relations) return true;
        }

        return false;
    };

    return eligible.filter(isProximate);
}