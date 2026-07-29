import type { ChatMessage } from '../../../types';
import type { TurnState, TurnCallbacks } from '../turnOrchestrator';
import { useAppStore } from '../../../store/useAppStore';
import { backgroundQueue } from '../../infrastructure/backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from '../../npc/npcDetector';
import { updateExistingNPCs, backfillNPCDrives } from '../../chatEngine';
import { tierAllows, NPC_UPDATE_COOLDOWN } from '../aiTier';
import type { PostTurnTrack, PostTurnTrackContext } from './types';

// WO-P2-03 — moved verbatim from `postTurnPipeline.ts` (was `runNPCTrack`, L753-844).
// Body, parameter list, guard placement and logging are byte-for-byte the original;
// only the surrounding import paths changed.
async function runNPCTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    npcLedger: import('../../../types').NPCEntry[],
    activeCampaignId: string
): Promise<void> {
    // WO-A rewrite 2 §2: the PC lives at `context.playerCharacter` now, not as
    // an `isPC` row in the ledger. The NPC detector must skip the PC's name +
    // aliases so play never spawns an NPC clone of the player character.
    // Defensive: also check the ledger for a legacy `isPC` row (post-migration
    // this should be empty, but cheap to guard).
    const pc = state.context.playerCharacter ?? npcLedger.find(n => n.isPC) ?? null;
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

    // Lite tier: skip NPC validation LLM call — surface raw extracted names as suggestions only.
    const freshProvider = state.getFreshProvider();
    const validatedNames = (freshProvider && tierAllows(state.settings.aiTier, 'npcValidate'))
        ? await validateNPCCandidates(freshProvider, extractedNames, lastAssistantContent)
        : extractedNames;

    if (validatedNames.length === 0) return;

    const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger, excludeNames);

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[NPC Update] Dropping update for NPC ${id} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        callbacks.updateNPC(id, patch);
    };

    for (const potentialName of newNames) {
        console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — adding to suggestions for player review...`);
        callbacks.addNpcSuggestions?.([potentialName], lastAssistantContent);
    }

    if (existingNpcsToUpdate.length > 0 && tierAllows(state.settings.aiTier, 'npcUpdate')) {
        const cooldown = NPC_UPDATE_COOLDOWN[state.settings.aiTier ?? 'pro'];
        const archiveIndex = state.archiveIndex;
        const sceneNow = archiveIndex.length > 0
            ? parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0
            : 0;
        // Apply the tier cooldown (Infinity on Lite — but the npcUpdate gate above already
        // blocks Lite entirely; this still matters for Pro's 5-scene cooldown).
        const npcsDueForUpdate = existingNpcsToUpdate.filter(
            npc => sceneNow - (npc.lastUpdateScene ?? -Infinity) >= cooldown
        );

        if (npcsDueForUpdate.length > 0) {
            const updateProvider = state.getFreshProvider();
            if (updateProvider) {
                backgroundQueue.push(
                    `NPC-Update:${npcsDueForUpdate.map(n => n.name).join(',')}`,
                    () => updateExistingNPCs(updateProvider, allMsgs, npcsDueForUpdate, guardedUpdateNPC)
                        .then(() => {
                            for (const npc of npcsDueForUpdate) {
                                guardedUpdateNPC(npc.id, { lastUpdateScene: sceneNow });
                            }
                        })
                ).catch(err => console.warn('[NPC Update] Background update failed:', err));
            }
        }

        if (tierAllows(state.settings.aiTier, 'drivesBackfill')) {
            const npcsNeedingDrives = existingNpcsToUpdate.filter(n => !n.drives);
            if (npcsNeedingDrives.length > 0) {
                const backfillProvider = state.getFreshProvider();
                if (backfillProvider) {
                    backgroundQueue.push(
                        `NPC-Drives-Backfill:${npcsNeedingDrives.map(n => n.name).join(',')}`,
                        () => backfillNPCDrives(backfillProvider, allMsgs, npcsNeedingDrives, guardedUpdateNPC)
                    ).catch(err => console.warn('[NPC Drives Backfill] Background backfill failed:', err));
                }
            }
        }
    }
}

/**
 * Detects characters named in the GM's reply: extract → (tier-gated) LLM validation →
 * classify into new names (queued as suggestions for player review, never auto-added) and
 * known NPCs (background profile update + drives backfill, both under a tier cooldown).
 *
 * Race-guard: `guardedUpdateNPC`, the inline campaign-id check moved with the body. It is
 * the only guard this track ever had, and it still wraps every one of the three write paths
 * that can land after an `await` — the profile update, the `lastUpdateScene` stamp, and the
 * drives backfill.
 *
 * `shouldRun` is unconditional: unlike the other tracks this one opens with work (building
 * the PC exclusion list) rather than a pure guard, and the WO-P2-03 rule is to move bodies
 * verbatim rather than re-cut where their early returns sit.
 */
export const npcTrack: PostTurnTrack<PostTurnTrackContext> = {
    id: 'track.npc',
    name: 'NPC Detection',
    description: 'Spots newly named characters in the GM reply and keeps known NPC profiles current.',
    defaultEnabled: true,
    shouldRun: () => true,
    run: (ctx) => runNPCTrack(
        ctx.state,
        ctx.callbacks,
        ctx.lastAssistantContent,
        ctx.allMsgs,
        ctx.npcLedger,
        ctx.activeCampaignId,
    ),
};
