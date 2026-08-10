import { scanCharacterTraits } from '../../../characterTraitParser';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { tierAllows } from '../../aiTier';
import type { PostCommitTrackContext, PostTurnTrack } from '../types';
import { assertStillActive } from '../guarded';

export const traitScanTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.trait-scan',
    name: 'Trait Scan',
    description: 'Maintains the structured character traits from recent messages.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => ctx.bookkeepingDue
        && ctx.bkAvailable
        && ctx.freshContext.characterProfileActive
        && tierAllows(ctx.facade?.config.aiTier ?? ctx.state.settings.aiTier, 'profileScan'),
    async run(ctx) {
        const traitProfile = ctx.freshContext.characterProfile || { identity: {}, activeTraits: [] };
        backgroundQueue.push('Trait-Scan', async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'Trait-Scan')) return;
            const newTraits = await scanCharacterTraits(
                ctx.facade ? undefined : ctx.bkProvider,
                ctx.scanMessages,
                traitProfile,
                ctx.storyModelCall,
            );
            if (!assertStillActive(ctx.activeCampaignId, 'Trait-Scan')) return;
            ctx.guardedUpdateContext({
                characterProfile: newTraits,
            });
            console.log(`[Auto Bookkeeping] Traits updated at scene #${ctx.sceneId} (${newTraits.activeTraits.filter(t => !t.superseded).length} active)`);
        }).catch(err => console.warn('[Auto Bookkeeping] Trait scan failed:', err));
    },
};
