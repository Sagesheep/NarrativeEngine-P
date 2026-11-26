import type { NPCEntry, NPCWants } from '../../../types';

export function isAgencyEligible(npc: NPCEntry): boolean {
    if (npc.isPC) return false;
    if ((npc as Record<string, unknown>).agencyLocked === true) return false;
    if (npc.condition === 'dead') return false;
    return true;
}

export function filterUpdatableNPCs(
    npcs: NPCEntry[],
    opts: { onStageIds?: string[]; recentlyMentionedIds?: string[] }
): NPCEntry[] {
    const onStage = new Set(opts.onStageIds ?? []);
    const mentioned = new Set(opts.recentlyMentionedIds ?? []);
    return npcs.filter(npc => {
        if (!isAgencyEligible(npc)) return false;
        return onStage.has(npc.id) || mentioned.has(npc.id);
    });
}

export function completeShortWant(wants: NPCWants, satisfiedText: string): NPCWants {
    return {
        ...wants,
        short: wants.short.filter(w => w !== satisfiedText),
    };
}