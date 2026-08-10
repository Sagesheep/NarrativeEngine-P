import { scanCharacterProfile } from '../../../characterProfileParser';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { tierAllows } from '../../aiTier';
import type { PostCommitTrackContext, PostTurnTrack } from '../types';
import { assertStillActive } from '../guarded';

export const profileScanTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.profile-scan',
    name: 'Profile Scan',
    description: 'Updates the structured character profile from recent messages.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => ctx.bookkeepingDue
        && ctx.bkAvailable
        && tierAllows(ctx.facade?.config.aiTier ?? ctx.state.settings.aiTier, 'profileScan'),
    async run(ctx) {
        backgroundQueue.push('Profile-Scan', async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'Profile-Scan')) return;
            const newProfile = await scanCharacterProfile(
                ctx.facade ? undefined : ctx.bkProvider,
                ctx.scanMessages,
                ctx.profileData,
                ctx.storyModelCall,
            );
            if (!assertStillActive(ctx.activeCampaignId, 'Profile-Scan')) return;
            ctx.guardedUpdateContext({
                characterProfileData: newProfile,
                characterProfileLastScene: ctx.sceneId,
            });
            (ctx.facade?.write.setCharacterProfileData ?? ctx.guardedSetCharacterProfileData)(newProfile);
            console.log(`[Auto Bookkeeping] Profile sheet updated at scene #${ctx.sceneId}`);
        }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));
    },
};
