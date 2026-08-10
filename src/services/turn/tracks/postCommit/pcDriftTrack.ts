import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { hasHostModelRole } from '../../hostFacade';
import { tierAllows } from '../../aiTier';
import type { PostCommitTrackContext, PostTurnTrack } from '../types';
import { assertStillActive } from '../guarded';

export const pcDriftTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.pc-drift',
    name: 'PC Drift',
    description: 'Checks the player character for narrative drift after bookkeeping.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => Boolean(
        ctx.bookkeepingDue
        && ctx.facade
        && hasHostModelRole(ctx.facade, 'story')
        && ctx.pc
        && tierAllows(ctx.facade.config.aiTier ?? ctx.state.settings.aiTier, 'npcUpdate'),
    ),
    async run(ctx) {
        const pc = ctx.pc;
        const facade = ctx.facade;
        const guardedUpdatePlayerCharacter = ctx.guardedUpdatePlayerCharacter;
        if (!pc || !facade || !guardedUpdatePlayerCharacter) return;

        backgroundQueue.push('PC-Drift:' + pc.name, async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'PC-Drift')) return;
            const { checkCharacterDrift } = await import('../../../character/pcUpdater');
            await checkCharacterDrift(
                (request) => facade.model.callJson('story', request, { retries: 1 }),
                ctx.scanMessages,
                pc,
                guardedUpdatePlayerCharacter,
            );
            console.log('[Auto Bookkeeping] PC drift check completed at scene #' + ctx.sceneId);
        }).catch(err => console.warn('[PC Updater] Background drift check failed:', err));
    },
};
