import { useAppStore } from '../../../store/useAppStore';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from '../../npc/npcDetector';
import { updateExistingNPCs } from '../../chatEngine';
// import { backfillNPCDrives } from '../../chatEngine'; — disabled, see the note in runNPCTrack.
import { agencyFillPatch, needsAgencyFill } from '../../npc/agency/agencyLazyFill';
import { NPC_UPDATE_COOLDOWN } from '../aiTier';
import { isBlockEnabled } from '../blockEnablement';
import { buildHostFacade, type HostFacade } from '../hostFacade';
import type { JsonModelCall } from '../../npc-generation/shared';
import { AI_CALL_TIMEOUT_MS } from '../../llm/timeouts';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

function legacyFacade(ctx: PostTurnTrackContext): { facade: HostFacade; useBroker: boolean } {
    if (ctx.facade) return { facade: ctx.facade, useBroker: true };
    if (!ctx.state || !ctx.callbacks) throw new Error('[NPC Track] missing host facade');
    return { facade: buildHostFacade(ctx.state, ctx.callbacks), useBroker: false };
}

function messagesToPrompt(messages: Array<{ role: string; content: string | null }>): string {
    return messages.map((message) => `${message.role.toUpperCase()}: ${message.content}`).join('\n\n');
}

function brokerJsonCall(facade: HostFacade): JsonModelCall {
    return async (messages, _contextLabel, trackingLabel) => {
        // Thinking off: NPC profile updates and drives backfill are JSON extractions that
        // run every turn on Max, in the background queue the other post-turn steps share.
        const response = await facade.model.call('story', {
            prompt: messagesToPrompt(messages),
            trackingLabel,
            thinkingEffort: 'off',
            timeoutMs: AI_CALL_TIMEOUT_MS,
        });
        return response.content;
    };
}

async function runNPCTrack(ctx: PostTurnTrackContext): Promise<void> {
    const { facade, useBroker } = legacyFacade(ctx);
    const data = facade.data;
    const config = facade.config;
    const write = facade.write;
    const lastAssistantContent = ctx.lastAssistantContent;
    const allMsgs = ctx.allMsgs;
    const activeCampaignId = ctx.activeCampaignId;
    const npcLedger = ctx.facade ? data.npcLedger : ctx.npcLedger;
    const state = ctx.state;
    const modelCall = useBroker ? brokerJsonCall(facade) : undefined;
    const provider = useBroker ? undefined : state?.getFreshProvider();

    // Only the player character is excluded. Excluding every ledger name and alias here
    // (081bc45, meant to stop known NPCs being re-suggested) also kept them out of the
    // update step whenever the GM named them exactly — most turns — so NPC Profile Update
    // and Drives Backfill rarely ran. classifyNPCNames already keeps known NPCs out of
    // the suggestions.
    const pc = data.context.playerCharacter ?? npcLedger.find(n => n.isPC) ?? null;
    const pcNames = pc ? [pc.name, ...(pc.aliases || '').split(',').map(a => a.trim()).filter(Boolean)] : [];
    const extractedNames = extractNPCNames(lastAssistantContent, pcNames);
    if (extractedNames.length === 0) return;

    // Known NPCs go straight to the update step; only unknown names need the validator.
    const { newNames: unknownNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(extractedNames, npcLedger, pcNames);
    const newNames = unknownNames.length === 0 || !isBlockEnabled('npcValidate', config.aiTier, config.moduleEnabled)
        ? unknownNames
        : useBroker
            ? await validateNPCCandidates(undefined, unknownNames, lastAssistantContent, async (request) => facade.model.call('story', request))
            : provider
                ? await validateNPCCandidates(provider, unknownNames, lastAssistantContent)
                : unknownNames;

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof write.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[NPC Update] Dropping update for NPC ${id} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        write.updateNPC(id, patch);
    };

    for (const potentialName of newNames) {
        console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — adding to suggestions for player review...`);
        write.addNpcSuggestions([potentialName], lastAssistantContent);
    }

    if (existingNpcsToUpdate.length > 0 && isBlockEnabled('npcUpdate', config.aiTier, config.moduleEnabled)) {
        const cooldown = NPC_UPDATE_COOLDOWN[config.aiTier ?? 'pro'];
        const archiveIndex = data.archiveIndex;
        const sceneNow = archiveIndex.length > 0
            ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
            : 0;
        const npcsDueForUpdate = existingNpcsToUpdate.filter(
            npc => sceneNow - (npc.lastUpdateScene ?? -Infinity) >= cooldown
        );

        if (npcsDueForUpdate.length > 0) {
            const updateProvider = useBroker ? undefined : state?.getFreshProvider();
            if (useBroker || updateProvider) {
                backgroundQueue.push(
                    `NPC-Update:${npcsDueForUpdate.map(n => n.name).join(',')}`,
                    async () => {
                        const relationshipMemoryEnabled = (ctx.facade?.data.context ?? ctx.state?.context)?.relationshipMemory === true;
                        const updated = await (useBroker
                            ? relationshipMemoryEnabled
                                ? updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC, modelCall, { relationshipMemoryEnabled: true })
                                : updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC, modelCall)
                            : relationshipMemoryEnabled
                                ? updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC, undefined, { relationshipMemoryEnabled: true })
                                : updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC));
                        // A failed call or unparseable answer leaves the cooldown unspent, so these
                        // NPCs are tried again the next time the GM names them.
                        if (!updated) return;
                        for (const npc of npcsDueForUpdate) {
                            guardedUpdateNPC(npc.id, { lastUpdateScene: sceneNow });
                        }
                    },
                ).catch(err => console.warn('[NPC Update] Background update failed:', err));
            }
        }

        // NPC Drives Backfill — DISABLED 2026-10-04 (owner decision: no conflicting systems).
        // Drives (core/session/scene wants) are the pre-agency motivation model. The agency
        // system replaced them: wants + personality hexagon + goal records, which the NPC
        // block in the prompt and the NPC updater read first ("wants, NOT drives",
        // update.ts). Backfilling drives gave older NPCs a second, competing set of
        // motivations; the agency fill below now covers those NPCs instead. Drives already
        // on an NPC are still shown as a fallback when it has no wants, and are carried
        // into its wants by the agency fill. The block switch is kept (marked unwired) so
        // stored settings stay valid.
        //
        // if (isBlockEnabled('drivesBackfill', config.aiTier, config.moduleEnabled)) {
        //     const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
        //     if (npcsNeedingDrives.length > 0) {
        //         const backfillProvider = useBroker ? undefined : state?.getFreshProvider();
        //         if (useBroker || backfillProvider) {
        //             backgroundQueue.push(
        //                 `NPC-Drives-Backfill:${npcsNeedingDrives.map(n => n.name).join(',')}`,
        //                 () => useBroker
        //                     ? backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, guardedUpdateNPC, modelCall)
        //                     : backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, guardedUpdateNPC)
        //             ).catch(err => console.warn('[NPC Drives Backfill] Background backfill failed:', err));
        //         }
        //     }
        // }
    }

    // Agency fill: an NPC from before the agency system gets its fields the first time
    // the GM names it, so off-screen agency (which ticks only populated NPCs) can include
    // it. Mechanical, no model call (agencyLazyFill.ts). Runs when the heartbeat it feeds
    // is on.
    const heartbeatOn = isBlockEnabled('heartbeatTick', config.aiTier, config.moduleEnabled);
    const npcsNeedingAgency = heartbeatOn ? existingNpcsToUpdate.filter(needsAgencyFill) : [];
    if (npcsNeedingAgency.length > 0) {
        const matureMode = (ctx.state?.settings ?? useAppStore.getState().settings)?.matureMode ?? false;
        for (const npc of npcsNeedingAgency) {
            // The fill rolls a personality, so never fill an NPC twice: the ledger this
            // turn was built from can predate a fill an earlier commit already made.
            const live = useAppStore.getState().npcLedger?.find(n => n.id === npc.id);
            if (live && !needsAgencyFill(live)) continue;
            guardedUpdateNPC(npc.id, agencyFillPatch(npc, { matureMode }));
            console.log(`[NPC Agency Fill] Populated ${npc.name}`);
        }
    }
}

export const npcTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.npc',
    name: 'NPC Detection',
    description: 'Spots newly named characters in the GM reply and keeps known NPC profiles current.',
    defaultEnabled: true,
    trigger: 'automatic',
    callsModel: true,
    shouldRun: () => true,
    run: runNPCTrack,
};
