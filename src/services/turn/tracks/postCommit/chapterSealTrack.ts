import { CHAPTER_SCENE_SOFT_CAP, type EndpointConfig, type ProviderConfig } from '../../../../types';
import { api } from '../../../llm/apiClient';
import type { SealModelCall } from '../../../saveFileEngine';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { toast } from '../../../../components/Toast';
import { EMPTY_REGISTER } from '../../../campaign-state/divergenceRegister';
import { tierAllows } from '../../aiTier';
import { hasHostModelRole } from '../../hostFacade';
import { emitCoreEvent } from '../../../mods/events';
import { runCombinedSeal } from '../../postTurnPipeline';
import type { TurnCallbacks } from '../../turnOrchestrator';
import type { PostTurnTrack, PostCommitTrackContext } from '../types';
import { assertStillActive, makeGuarded } from '../guarded';

export const chapterSealTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.chapter-seal',
    name: 'Chapter Auto-Seal',
    description: 'Seals an open chapter after it reaches the scene soft cap.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => {
        const openChapter = ctx.freshChapters.find(c => !c.sealedAt);
        return Boolean(openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP);
    },
    async run(ctx) {
        const openChapter = ctx.freshChapters.find(c => !c.sealedAt);
        if (!openChapter) return;

        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes \u2014 sealing...`);
        const guardedSetChapters = makeGuarded(ctx.state.setChapters, ctx.activeCampaignId, 'setChapters (Auto-Seal)');
        const guardedSealCallbacks: TurnCallbacks = {
            ...ctx.callbacks,
            setDivergenceRegister: ctx.callbacks.setDivergenceRegister
                ? makeGuarded(ctx.callbacks.setDivergenceRegister, ctx.activeCampaignId, 'setDivergenceRegister (Auto-Seal)')
                : undefined,
            setArchiveIndex: makeGuarded(ctx.callbacks.setArchiveIndex, ctx.activeCampaignId, 'setArchiveIndex (Auto-Seal)'),
        };
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'Chapter-AutoSeal')) return;
            const sealResult = await api.chapters.seal(ctx.activeCampaignId);
            if (!assertStillActive(ctx.activeCampaignId, 'Chapter-AutoSeal')) return;
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(ctx.activeCampaignId);
            if (!assertStillActive(ctx.activeCampaignId, 'Chapter-AutoSeal')) return;
            guardedSetChapters(sealedChapters);
            emitCoreEvent('archive.chapterSealed', {
                campaignId: ctx.activeCampaignId,
                chapterId: sealResult.sealedChapter.chapterId,
                title: sealResult.sealedChapter.title,
                trigger: 'auto',
            });
            toast.info(`Chapter "${sealResult.sealedChapter.title}" auto-sealed (${CHAPTER_SCENE_SOFT_CAP} scenes)`);

            const sealProvider: EndpointConfig | ProviderConfig | undefined = ctx.facade ? undefined : ctx.state.getFreshProvider();
            const sealModelCall: SealModelCall | undefined = ctx.facade && hasHostModelRole(ctx.facade, 'story')
                ? (request) => ctx.facade!.model.call('story', request).then(result => result.content)
                : undefined;
            if ((sealProvider || sealModelCall) && tierAllows(ctx.facade?.config.aiTier ?? ctx.state.settings.aiTier, 'sealChapter')) {
                await runCombinedSeal(
                    sealProvider,
                    sealResult.sealedChapter,
                    ctx.activeCampaignId,
                    ctx.state,
                    guardedSealCallbacks,
                    true,
                    {
                        npcLedger: ctx.facade?.data.npcLedger ?? ctx.state.npcLedger ?? [],
                        archiveIndex: ctx.facade?.data.archiveIndex ?? ctx.state.archiveIndex ?? [],
                        divergenceScanBudget: ctx.facade?.config.divergenceScanBudget ?? ctx.state.settings.divergenceScanBudget ?? 0,
                        contextLimit: ctx.facade?.config.contextLimit ?? ctx.state.settings.contextLimit ?? 4096,
                        divergenceRegister: ctx.facade?.data.divergenceRegister ?? ctx.state.divergenceRegister ?? EMPTY_REGISTER,
                    },
                );
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    },
};
