import { api } from '../../../llm/apiClient';
import { backgroundQueue } from '../../../infrastructure/backgroundQueue';
import { witnessesFromHeader, witnessesFromModel } from '../../../npc/witnessCapture';
import { isBlockEnabled } from '../../blockEnablement';
import type { PostTurnTrack, PostCommitTrackContext } from '../types';
import { assertStillActive, makeGuarded } from '../guarded';

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

export const witnessCaptureTrack: PostTurnTrack<PostCommitTrackContext> = {
    id: 'track.witness-capture',
    name: 'Witness Capture',
    description: 'Records who was present in the scene: the GM’s 👥 line, or on Max a model read when the reply has none.',
    toggleable: true,
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: (ctx) => Boolean(ctx.entry),
    async run(ctx) {
        const entry = ctx.entry;
        if (!entry) return;
        const ledger = ctx.facade?.data.npcLedger ?? ctx.state.npcLedger ?? [];
        const serverWitnesses = entry.witnesses ?? [];
        const guardedSetArchiveIndex = makeGuarded(ctx.callbacks.setArchiveIndex, ctx.activeCampaignId, 'setArchiveIndex (Witness-Capture)');

        const save = async (witnesses: string[], witnessSource: 'header' | 'aux_fallback') => {
            if (sameList(witnesses, serverWitnesses)) return;
            if (!assertStillActive(ctx.activeCampaignId, 'Witness-Capture')) return;
            await api.archive.patchWitnesses(ctx.activeCampaignId, [{ sceneId: entry.sceneId, witnesses, witnessSource }]);
            guardedSetArchiveIndex(await api.archive.getIndex(ctx.activeCampaignId));
            console.log(`[WitnessCapture] Scene #${entry.sceneId} witnesses (${witnessSource}): ${witnesses.join(', ') || '(none)'}`);
        };

        const fromHeader = witnessesFromHeader(ctx.lastAssistantContent, ledger);
        if (fromHeader !== null) {
            await save(fromHeader, 'header').catch(err => console.warn('[WitnessCapture] Header patch failed:', err));
            return;
        }

        const tier = ctx.facade?.config.aiTier ?? ctx.state.settings.aiTier;
        const modelCall = ctx.storyModelCall;
        if (!modelCall || !isBlockEnabled('witnessAux', tier, ctx.facade?.config.moduleEnabled ?? ctx.state.settings.moduleEnabled)) return;
        backgroundQueue.push(`Witness-Capture:${entry.sceneId}`, async () => {
            if (!assertStillActive(ctx.activeCampaignId, 'Witness-Capture')) return;
            const present = await witnessesFromModel(ctx.lastAssistantContent, ledger, modelCall);
            if (present.length === 0) return;
            await save(present.map(npc => npc.name), 'aux_fallback');
        }).catch(err => console.warn('[WitnessCapture] Background capture failed:', err));
    },
};
