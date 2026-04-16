import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger,
    loadArchiveIndex, loadTimeline, loadChapters, loadEntities,
} from './campaignStore';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import type { GameContext } from '../types';

export async function hydrateCampaign(campaignId: string) {
    const [state, chunks, npcs, archiveIndex, timeline, chapters, entities] = await Promise.all([
        loadCampaignState(campaignId),
        getLoreChunks(campaignId),
        getNPCLedger(campaignId),
        loadArchiveIndex(campaignId),
        loadTimeline(campaignId),
        loadChapters(campaignId),
        loadEntities(campaignId),
    ]);

    useAppStore.setState({
        context: { ...DEFAULT_CONTEXT, ...(state?.context ?? {}) } as GameContext,
        messages: state?.messages ?? [],
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER), isCondensing: false },
        loreChunks: chunks,
        npcLedger: npcs,
        archiveIndex: archiveIndex ?? [],
        timeline: timeline ?? [],
        chapters: chapters ?? [],
        entities: entities ?? [],
        activeCampaignId: campaignId,
    });
}
