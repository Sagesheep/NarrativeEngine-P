import { useAppStore } from './useAppStore';
import {
    loadCampaignState, getLoreChunks, getNPCLedger,
    loadArchiveIndex, loadTimeline, loadChapters, loadEntities,
} from './campaignStore';
import { DEFAULT_CONTEXT, DEFAULT_CONDENSER } from '../services/campaignInit';
import { migrateLegacyContext } from '../types';
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

    const rawContext: GameContext = { ...DEFAULT_CONTEXT, ...(state?.context ?? {}) } as GameContext;
    const migratedContext = migrateLegacyContext(rawContext);

    useAppStore.setState({
        context: migratedContext,
        messages: state?.messages ?? [],
        condenser: { ...(state?.condenser ?? DEFAULT_CONDENSER), isCondensing: false },
        loreChunks: chunks,
        npcLedger: npcs,
        archiveIndex: archiveIndex ?? [],
        timeline: timeline ?? [],
        chapters: chapters ?? [],
        entities: entities ?? [],
        activeCampaignId: campaignId,
        inventoryItems: migratedContext.inventoryItems,
        characterProfileData: migratedContext.characterProfileData,
    });
}
