import type { PostTurnTrack, SequentialTrackContext } from '../types';

const PRESENT_HEADER_RE = /👥\s*\[Present\]\s*(.+)/i;

function parsePresentHeader(content: string): string[] | null {
    const match = content.match(PRESENT_HEADER_RE);
    if (!match) return null;
    return match[1].split(/[,;]/).map(n => n.trim()).filter(Boolean);
}

function resolveNPCIds(
    names: string[],
    npcLedger: SequentialTrackContext['npcLedger'],
): string[] {
    const nameToId = new Map<string, string>();
    for (const npc of npcLedger) {
        const nameLower = npc.name.toLowerCase();
        nameToId.set(nameLower, npc.id);
        if (npc.aliases) {
            npc.aliases.split(',').map(a => a.trim().toLowerCase()).filter(Boolean)
                .forEach(a => nameToId.set(a, npc.id));
        }
    }
    return names
        .map(n => nameToId.get(n.toLowerCase()))
        .filter((id): id is string => !!id);
}

export const onStageTrack: PostTurnTrack<SequentialTrackContext> = {
    id: 'track.on-stage',
    name: 'On-Stage NPC Tracking',
    description: 'Tracks the NPCs named in the GM’s on-stage header for this turn.',
    toggleable: false,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: () => true,
    async run(ctx) {
        const presentNames = parsePresentHeader(ctx.lastAssistantContent);
        const onStageIds = presentNames && presentNames.length > 0
            ? resolveNPCIds(presentNames, ctx.npcLedger)
            : [];
        ctx.onStageIds = onStageIds;
        ctx.callbacks.setOnStageNpcIds?.(onStageIds);
    },
};
