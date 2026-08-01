import { useAppStore } from '../../../store/useAppStore';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from '../../npc/npcDetector';
import { updateExistingNPCs, backfillNPCDrives } from '../../chatEngine';
import { tierAllows, NPC_UPDATE_COOLDOWN } from '../aiTier';
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
        const response = await facade.model.call('story', {
            prompt: messagesToPrompt(messages),
            trackingLabel,
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

    const pc = data.context.playerCharacter ?? npcLedger.find(n => n.isPC) ?? null;
    const excludeNames = npcLedger.flatMap(npc => {
        const aliases = (npc.aliases || '').split(',').map(a => a.trim()).filter(Boolean);
        return [npc.name, ...aliases];
    });
    if (pc) {
        excludeNames.push(pc.name);
        if (pc.aliases) {
            excludeNames.push(...pc.aliases.split(',').map(a => a.trim()).filter(Boolean));
        }
    }
    const extractedNames = extractNPCNames(lastAssistantContent, excludeNames);
    if (extractedNames.length === 0) return;

    const validatedNames = tierAllows(config.aiTier, 'npcValidate')
        ? useBroker
            ? await validateNPCCandidates(undefined, extractedNames, lastAssistantContent, async (request) => facade.model.call('story', request))
            : provider
                ? await validateNPCCandidates(provider, extractedNames, lastAssistantContent)
                : extractedNames
        : extractedNames;

    if (validatedNames.length === 0) return;

    const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger, excludeNames);

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

    if (existingNpcsToUpdate.length > 0 && tierAllows(config.aiTier, 'npcUpdate')) {
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
                    () => (useBroker
                        ? updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC, modelCall)
                        : updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC))
                        .then(() => {
                            for (const npc of npcsDueForUpdate) {
                                guardedUpdateNPC(npc.id, { lastUpdateScene: sceneNow });
                            }
                        })
                ).catch(err => console.warn('[NPC Update] Background update failed:', err));
            }
        }

        if (tierAllows(config.aiTier, 'drivesBackfill')) {
            const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
            if (npcsNeedingDrives.length > 0) {
                const backfillProvider = useBroker ? undefined : state?.getFreshProvider();
                if (useBroker || backfillProvider) {
                    backgroundQueue.push(
                        `NPC-Drives-Backfill:${npcsNeedingDrives.map(n => n.name).join(',')}`,
                        () => useBroker
                            ? backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, guardedUpdateNPC, modelCall)
                            : backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, guardedUpdateNPC)
                    ).catch(err => console.warn('[NPC Drives Backfill] Background backfill failed:', err));
                }
            }
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