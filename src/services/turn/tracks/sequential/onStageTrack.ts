import type { PostTurnTrack, SequentialTrackContext } from '../types';
import { parsePresentHeader, resolvePresentNpcs } from '../../../npc/presentHeader';

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
        // The shared 👥 parser accepts every header shape the rulesets use; the old
        // exact `👥 [Present]` regex matched none of the owner's campaigns.
        const presentNames = parsePresentHeader(ctx.lastAssistantContent) ?? [];
        const onStageIds = resolvePresentNpcs(presentNames, ctx.npcLedger).map(npc => npc.id);
        ctx.onStageIds = onStageIds;
        ctx.callbacks.setOnStageNpcIds?.(onStageIds);
    },
};
