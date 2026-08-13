import { readRelationshipMemoryState, writeRelationshipMemoryState } from '../../../../store/relationshipMemoryState';
import { saveRelationshipMemories } from '../../../../store/relationshipMemoryStore';
import { getRelationshipMemoryParticipants, mergeRelationshipMemoryCollections, rateRelationshipMemory } from '../../../archive-memory/relationshipMemory';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { hasHostModelRole } from '../../hostFacade';
import type { PostTurnTrack, PostCommitTrackContext } from '../types';
import { assertStillActive } from '../guarded';

export const relationshipMemoryTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.relationship-memory',
    name: 'Relationship Memory',
    description: 'Records sparse directed memories from committed scenes.',
    toggleable: false,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => Boolean(
        ctx.freshContext.relationshipMemory === true &&
        ctx.facade &&
        hasHostModelRole(ctx.facade, 'utility') &&
        ctx.activeCampaignId &&
        ctx.lastAssistantContent,
    ),
    async run(ctx) {
        if (!ctx.facade || !ctx.activeCampaignId) return;
        const participants = getRelationshipMemoryParticipants(
            ctx.lastAssistantContent,
            ctx.state.npcLedger,
            ctx.freshContext.playerCharacter,
        );
        if (participants.onStageNpcs.length === 0) return;

        const sceneText = ctx.displayInput + '\n\n' + ctx.lastAssistantContent;
        backgroundQueue.push('Relationship-Memory:' + ctx.sceneId, async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'Relationship-Memory')) return;
            const result = await rateRelationshipMemory(
                ctx.sceneId,
                sceneText,
                participants,
                request => ctx.facade!.model.call('utility', { ...request, timeoutMs: 15000 }),
            );
            if (!assertStillActive(ctx.activeCampaignId, 'Relationship-Memory')) return;

            if (result.faults.length > 0) {
                const current = readRelationshipMemoryState();
                writeRelationshipMemoryState({
                    relationshipMemoryFaults: [...current.relationshipMemoryFaults, ...result.faults],
                });
            }
            if (result.npcToMc.length === 0 && result.npcToNpc.length === 0) return;

            const state = readRelationshipMemoryState();
            const merged = mergeRelationshipMemoryCollections(
                state.relationshipMemoriesNpcToMc,
                state.relationshipMemoriesNpcToNpc,
                result,
            );
            await saveRelationshipMemories(ctx.activeCampaignId, merged);
            if (!assertStillActive(ctx.activeCampaignId, 'Relationship-Memory')) return;
            writeRelationshipMemoryState({
                relationshipMemoriesNpcToMc: merged.npcToMc,
                relationshipMemoriesNpcToNpc: merged.npcToNpc,
            });
        }).catch(error => {
            console.warn('[PostTurn] Background relationship memory failed:', error);
            if (assertStillActive(ctx.activeCampaignId, 'Relationship-Memory')) {
                const current = readRelationshipMemoryState();
                writeRelationshipMemoryState({
                    relationshipMemoryFaults: [
                        ...current.relationshipMemoryFaults,
                        { sceneId: ctx.sceneId, message: 'Relationship memory storage failed.' },
                    ],
                });
            }
        });
    },
};
