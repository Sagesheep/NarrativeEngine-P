import { readRelationshipMemoryState, writeRelationshipMemoryState } from '../../../../store/relationshipMemoryState';
import { updateRelationshipMemories } from '../../../../store/relationshipMemoryStore';
import { useAppStore } from '../../../../store/useAppStore';
import { getRelationshipMemoryParticipants, mergeRelationshipMemoryCollections, rateRelationshipMemory } from '../../../archive-memory/relationshipMemory';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { hasHostModelRole } from '../../hostFacade';
import type { PostTurnTrack, PostCommitTrackContext } from '../types';
import { assertStillActive } from '../guarded';

/**
 * Is the scene this rating describes still the one in the archive? The number alone is
 * not enough: after a rollback the next scene reuses it, and a rating of the removed
 * scene that finishes late would be filed under the new one. The archive timestamp
 * tells the two apart (edit-sync keeps it, a new append gets a new one).
 */
export function sceneStillArchived(sceneId: string, archivedAt: number | undefined): boolean {
    const index = (useAppStore.getState() as { archiveIndex?: Array<{ sceneId: string; timestamp?: number }> }).archiveIndex;
    // No index in the store (tests, host facade without one): nothing to check against.
    if (!Array.isArray(index) || index.length === 0) return true;
    const wanted = Number.parseInt(sceneId, 10);
    const entry = index.find(e => Number.parseInt(e.sceneId, 10) === wanted);
    if (!entry) return false;
    if (archivedAt === undefined || entry.timestamp === undefined) return true;
    return entry.timestamp === archivedAt;
}

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
        const archivedAt = ctx.entry?.timestamp;
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
            // The rating is queued work. If the player rolled this scene back while it ran,
            // its records describe a scene that no longer exists — and its number may
            // already belong to a new scene — so they must not be written.
            if (!sceneStillArchived(ctx.sceneId, archivedAt)) return;

            // Merge into the store as it is NOW, with no await before the write. Two ratings
            // run at once; merging into a copy read before an await let the later save drop
            // the other scene's records.
            await updateRelationshipMemories(ctx.activeCampaignId, current =>
                mergeRelationshipMemoryCollections(current.npcToMc, current.npcToNpc, result),
            );
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
