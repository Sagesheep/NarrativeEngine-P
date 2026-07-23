import type { NPCEntry } from '../../types';

/**
 * Bonds selector (WO-A §6.3) — pure helper. Returns non-archived, non-PC NPCs
 * with non-zero `pcRelation`, sorted by |pcRelation| desc. Engine-owned values
 * are read-only in the panel.
 */
export function selectPcBonds(npcs: NPCEntry[]): NPCEntry[] {
    return npcs
        .filter(n => !n.isPC && !n.archived && n.pcRelation !== undefined && n.pcRelation !== 0)
        .sort((a, b) => Math.abs(b.pcRelation!) - Math.abs(a.pcRelation!));
}