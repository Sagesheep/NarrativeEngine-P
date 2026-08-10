import type { PostTurnTrack, SequentialTrackContext } from '../types';
import type { TurnCallbacks } from '../../turnOrchestrator';
import { tierAllows } from '../../aiTier';
import { makeGuarded } from '../guarded';

export const agencyTrack: PostTurnTrack<SequentialTrackContext> = {
    id: 'track.agency',
    name: 'NPC Agency Tick',
    description: 'Advances off-screen NPC agency and narrates timeskip consequences when enabled.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: () => true,
    async run(ctx) {
        // Runs after archive/NPC/pressure tracks settle so newly-detected NPCs have profiles
        // before they're ticked. Mutates NPC agency state in-place via callbacks.updateNPC;
        // folds a digest into context.agencyDigest for the next GM call. Gated by aiTier in Phase 4.
        // Also bumps activity for every NPC that was on-stage last turn so the deep tier tracks the
        // player's active social circle (bumpOnStageActivity is unconditional — same pattern as the
        // short-want lifecycle).
        try {
            const { runAgencyTick, bumpOnStageActivity } = await import('../../../npc/agency/agencyEngine');
            bumpOnStageActivity(ctx.state, ctx.facade ? { ...ctx.callbacks, updateNPC: ctx.facade.write.updateNPC } : ctx.callbacks, ctx.facade?.data.npcLedger ?? ctx.npcLedger);
            if (tierAllows(ctx.state.settings.aiTier, 'heartbeatTick')) {
                // Guard only addMessage — it's the only callback invoked from a
                // backgroundQueue.push closure inside runAgencyTick (Timeskip-Narration,
                // agencyEngine.ts:341). The synchronous updateContext/updateNPC calls in
                // runAgencyTick run in the same microtask as this line, so they don't need
                // guarding (same reasoning as the synchronous pipeline calls at L68/111).
                const agencyCallbacks: TurnCallbacks = {
                    ...ctx.callbacks,
                    addMessage: makeGuarded(ctx.callbacks.addMessage, ctx.activeCampaignId, 'addMessage (Timeskip-Narration)'),
                };
                runAgencyTick(ctx.state, agencyCallbacks, ctx.facade?.data.npcLedger ?? ctx.npcLedger, ctx.state.displayInput, ctx.facade);
            }
        } catch (err) {
            console.warn('[AgencyTick] Failed (non-fatal):', err);
        }
    },
};
