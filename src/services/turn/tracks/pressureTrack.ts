import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import { useAppStore } from '../../../store/useAppStore';
import { scanPressure, buildPressurePatch, shouldArchiveNPC, findArchivedToRestore } from '../../npc/npcPressureTracker';
import { toast } from '../../../components/Toast';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

// WO-P2-03 — moved verbatim from `postTurnPipeline.ts` (was `runPressureTrack`, L846-935).
// Body, parameter list, guard placement and logging are byte-for-byte the original;
// only the surrounding import paths changed.
async function runPressureTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    npcLedger: import('../../../types').NPCEntry[],
    activeCampaignId: string,
    lastAssistantContent: string
): Promise<void> {
    if (!npcLedger || npcLedger.length === 0) return;

    const archiveIndex = state.archiveIndex;
    const sceneNumber = archiveIndex.length > 0
        ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
        : 0;

    const loreHeadersSet = new Set<string>();
    if (state.loreChunks) {
        for (const chunk of state.loreChunks) {
            if (chunk.header) loreHeadersSet.add(chunk.header.toLowerCase());
        }
    }
    const activeNPCs = npcLedger.filter(npc => {
        if (npc.archived) return false;
        if (!npc.name) return false;
        if (loreHeadersSet.has(npc.name.toLowerCase())) return false;
        return true;
    });

    if (activeNPCs.length === 0) return;

    const updates = scanPressure(displayInput, activeNPCs);
    if (updates.length === 0) return;

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) return;
        callbacks.updateNPC(id, patch);
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

    // ── Auto-archive stale NPCs ──
    const maxStaleTurns = useAppStore.getState().settings.autoArchiveStaleNPCsTurns ?? 0;
    const currentTurn = archiveIndex.length;
    if (maxStaleTurns > 0) {
        const guardedArchiveNPC = (id: string, turn: number, reason: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== activeCampaignId) return;
            callbacks.archiveNPC(id, turn, reason);
        };

        for (const npc of activeNPCs) {
            const result = shouldArchiveNPC(npc, currentTurn, maxStaleTurns);
            if (result.shouldArchive) {
                guardedArchiveNPC(npc.id, currentTurn, result.reason);
                console.log(`[Auto-Archive] ${npc.name} archived after ${result.turnsSince} turns inactive`);
            }
        }
    }

    // ── Auto-restore archived NPCs mentioned in the response ──
    const archivedNPCs = npcLedger.filter(n => n.archived);
    if (archivedNPCs.length > 0) {
        const toRestore = findArchivedToRestore(lastAssistantContent, archivedNPCs);
        const guardedRestoreNPC = (id: string) => {
            const currentId = useAppStore.getState().activeCampaignId;
            if (currentId !== activeCampaignId) return;
            callbacks.restoreNPC(id);
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

/**
 * Zero-LLM social-pressure accrual: scores the player's turn against every live NPC, writes
 * the ignored/engaged deltas, auto-archives NPCs gone stale for too long, and auto-restores
 * archived ones the GM just named.
 *
 * Race-guards: `guardedUpdateNPC`, `guardedArchiveNPC` and `guardedRestoreNPC` — the three
 * inline campaign-id checks, moved with the body and still wrapping the same three write
 * paths.
 *
 * `shouldRun` mirrors the body's own opening guard (`!npcLedger || npcLedger.length === 0`).
 * The guard is deliberately left in the body too: the body is a verbatim move, and the
 * duplication means calling `run` directly is still safe.
 */
export const pressureTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.pressure',
    name: 'NPC Pressure Tracking',
    description: 'Accrues ignored/engaged pressure per NPC, then auto-archives stale ones and restores those the GM brings back.',
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: false,
    shouldRun: (ctx) => !!ctx.npcLedger && ctx.npcLedger.length > 0,
    run: (ctx) => runPressureTrack(
        ctx.state,
        ctx.callbacks,
        ctx.displayInput,
        ctx.npcLedger,
        ctx.activeCampaignId,
        ctx.lastAssistantContent,
    ),
};
