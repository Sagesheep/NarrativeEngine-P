import type { ChatMessage } from '../types';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { api } from './apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../types';
import { rateImportance } from './importanceRater';
import { generateChapterSummary } from './saveFileEngine';
import { backgroundQueue } from './backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { generateNPCProfile, updateExistingNPCs } from './chatEngine';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { toast } from '../components/Toast';

/**
 * Runs everything that happens after a successful LLM response:
 * importance rating, archive append, archive index refresh, auto-seal,
 * NPC detection/generation, and auto-bookkeeping.
 *
 * Caller must guard: activeCampaignId is non-null, lastAssistant has content.
 *
 * @param allMsgs - snapshot from state.getMessages() taken right after updateLastAssistant
 */
export async function runPostTurnPipeline(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[]
): Promise<void> {
    const activeCampaignId = state.activeCampaignId!;
    const { displayInput, npcLedger } = state;

    // ── Importance Rating ────────────────────────────────────────────────
    let sceneImportance: number | undefined;
    const importanceProvider = state.getFreshProvider();
    if (importanceProvider) {
        try {
            sceneImportance = await rateImportance(importanceProvider, displayInput, lastAssistantContent, allMsgs);
            console.log(`[ImportanceRater] Scene rated: ${sceneImportance}/5`);
        } catch (err) {
            console.warn('[ImportanceRater] Failed (non-fatal):', err);
        }
    }

    // ── Archive Append ───────────────────────────────────────────────────
    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent, sceneImportance);
    const appendedSceneId = appendData?.sceneId;
    if (!appendData) return;

    const freshIndex = await api.archive.getIndex(activeCampaignId);
    callbacks.setArchiveIndex(freshIndex);
    const freshTimeline = await api.timeline.get(activeCampaignId);
    callbacks.setTimeline?.(freshTimeline);
    console.log(`[Archive] Appended scene #${appendedSceneId}`);

    // ── Auto-Seal Check ──────────────────────────────────────────────────
    const freshChapters = await api.chapters.list(activeCampaignId);
    state.setChapters(freshChapters);
    const openChapter = freshChapters.find(c => !c.sealedAt);
    if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            const sealResult = await api.chapters.seal(activeCampaignId);
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(activeCampaignId);
            state.setChapters(sealedChapters);
            toast.info(`Chapter "${sealResult.sealedChapter.title}" auto-sealed (${CHAPTER_SCENE_SOFT_CAP} scenes)`);

            // Generate summary in background
            const sealProvider = state.getFreshProvider();
            if (sealProvider) {
                const ch = sealResult.sealedChapter;
                const startNum = parseInt(ch.sceneRange[0], 10);
                const endNum = parseInt(ch.sceneRange[1], 10);
                const sIds = Array.from({ length: endNum - startNum + 1 }, (_, i) =>
                    String(startNum + i).padStart(3, '0')
                );
                const chScenes = await api.archive.fetchScenes(activeCampaignId, sIds);
                const freshCtx = state.getFreshContext();
                const summaryPatch = await generateChapterSummary(sealProvider, ch, chScenes, freshCtx.headerIndex);
                if (summaryPatch) {
                    await api.chapters.update(activeCampaignId, ch.chapterId, { ...summaryPatch, invalidated: false });
                    const latestChapters = await api.chapters.list(activeCampaignId);
                    state.setChapters(latestChapters);
                    console.log(`[Auto-Seal] Summary generated for "${ch.title}"`);
                }
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    }

    // ── NPC Detection ────────────────────────────────────────────────────
    const extractedNames = extractNPCNames(lastAssistantContent);
    if (extractedNames.length > 0) {
        const freshProvider = state.getFreshProvider();
        const validatedNames = freshProvider
            ? await validateNPCCandidates(freshProvider, extractedNames, lastAssistantContent)
            : extractedNames;

        if (validatedNames.length > 0) {
            const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);

            for (const potentialName of newNames) {
                console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — queuing background profile generation...`);
                const genProvider = state.getFreshProvider();
                if (genProvider) {
                    backgroundQueue.push(
                        `NPC-Gen:${potentialName}`,
                        () => generateNPCProfile(genProvider, allMsgs, potentialName, callbacks.addNPC)
                    ).catch(err => console.warn(`[NPC Auto-Gen] Background generation failed for "${potentialName}":`, err));
                }
            }

            if (existingNpcsToUpdate.length > 0) {
                const updateProvider = state.getFreshProvider();
                if (updateProvider) {
                    backgroundQueue.push(
                        `NPC-Update:${existingNpcsToUpdate.map(n => n.name).join(',')}`,
                        () => updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, callbacks.updateNPC)
                    ).catch(err => console.warn('[NPC Update] Background update failed:', err));
                }
            }
        }
    }

    // ── Auto Bookkeeping: Profile & Inventory scan every N turns ─────────
    const turnCount = state.incrementBookkeepingTurnCounter();
    const interval = state.autoBookkeepingInterval;
    if (turnCount >= interval && appendedSceneId) {
        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan (scene #${appendedSceneId})`);
        state.resetBookkeepingTurnCounter();

        const bkProvider = state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;

            // Closures call state.getMessages() / state.getFreshContext() at execution time
            // to get the freshest state when the background task drains.
            backgroundQueue.push('Profile-Scan', async () => {
                const newProfile = await scanCharacterProfile(bkProvider, state.getMessages(), state.getFreshContext().characterProfile);
                callbacks.updateContext({
                    characterProfile: newProfile,
                    characterProfileLastScene: sceneId,
                });
                console.log(`[Auto Bookkeeping] Profile updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));

            backgroundQueue.push('Inventory-Scan', async () => {
                const newInventory = await scanInventory(bkProvider, state.getMessages(), state.getFreshContext().inventory);
                callbacks.updateContext({
                    inventory: newInventory,
                    inventoryLastScene: sceneId,
                });
                console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
        }
    }
}
