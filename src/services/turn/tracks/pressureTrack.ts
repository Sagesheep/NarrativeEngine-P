import { useAppStore } from '../../../store/useAppStore';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from '../../npc/npcPressureTracker';
import { toast } from '../../../components/Toast';
import { buildHostFacade } from '../hostFacade';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

function getFacade(ctx: PostTurnTrackContext) {
    if (ctx.facade) return ctx.facade;
    if (!ctx.state || !ctx.callbacks) throw new Error('[Pressure Track] missing host facade');
    return buildHostFacade(ctx.state, ctx.callbacks);
}

async function runPressureTrack(ctx: PostTurnTrackContext): Promise<void> {
    const facade = getFacade(ctx);
    const npcLedger = ctx.facade ? facade.data.npcLedger : ctx.npcLedger;
    if (!npcLedger || npcLedger.length === 0) return;

    const archiveIndex = facade.data.archiveIndex;
    const sceneNumber = archiveIndex.length > 0
        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
        : 0;

    const loreHeadersSet = new Set<string>();
    for (const chunk of facade.data.loreChunks) {
        if (chunk.header) loreHeadersSet.add(chunk.header.toLowerCase());
    }
    const activeNPCs = npcLedger.filter(npc => {
        if (npc.archived) return false;
        if (!npc.name) return false;
        if (loreHeadersSet.has(npc.name.toLowerCase())) return false;
        return true;
    });

    if (activeNPCs.length === 0) return;

    const updates = scanPressure(ctx.displayInput, activeNPCs);
    if (updates.length === 0) return;

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof facade.write.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== ctx.activeCampaignId) return;
        facade.write.updateNPC(id, patch);
    };

    for (const update of updates) {
        const npc = npcLedger.find(n => n.id === update.npcId);
        if (!npc) continue;

        const patch = buildPressurePatch(npc, update, sceneNumber);
        guardedUpdateNPC(npc.id, patch);

        if (update.reasons.length > 0) {
            console.log(`[PressureTracker] ${npc.name}: ignored=${patch.pressure?.ignored?.toFixed(1)}, engaged=${patch.pressure?.engaged?.toFixed(1)} — ${update.reasons.join(', ')}`);
        }
    }

    const maxStaleTurns = facade.config.autoArchiveStaleNPCsTurns;
    const currentTurn = archiveIndex.length;
    if (maxStaleTurns > 0) {
        const guardedArchiveNPC = (id: string, turn: number, reason: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== ctx.activeCampaignId) return;
            facade.write.archiveNPC(id, turn, reason);
        };

        for (const npc of activeNPCs) {
            const result = shouldArchiveNPC(npc, currentTurn, maxStaleTurns);
            if (result.shouldArchive) {
                guardedArchiveNPC(npc.id, currentTurn, result.reason);
                console.log(`[Auto-Archive] ${npc.name} archived after ${result.turnsSince} turns inactive`);
            }
        }
    }

    const archivedNPCs = npcLedger.filter(n => n.archived);
    if (archivedNPCs.length > 0) {
        const toRestore = findArchivedToRestore(ctx.lastAssistantContent, archivedNPCs);
        const guardedRestoreNPC = (id: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== ctx.activeCampaignId) return;
            facade.write.restoreNPC(id);
        };

        for (const npcId of toRestore) {
            const npc = npcLedger.find(n => n.id === npcId);
            guardedRestoreNPC(npcId);
            if (npc) {
                console.log(`[Auto-Restore] ${npc.name} re-enters the scene`);
                toast.info(`${npc.name} re-enters the scene`);
            }
        }
    }
}

export const pressureTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.pressure',
    name: 'NPC Pressure Tracking',
    description: 'Accrues ignored/engaged pressure per NPC, then auto-archives stale ones and restores those the GM brings back.',
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: (ctx) => !!ctx.npcLedger && ctx.npcLedger.length > 0,
    run: runPressureTrack,
};