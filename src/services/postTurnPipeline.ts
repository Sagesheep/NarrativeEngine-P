import type { ChatMessage } from '../types';
import type { TurnState, TurnCallbacks } from './turnOrchestrator';
import { useAppStore } from '../store/useAppStore';
import { api } from './apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../types';
import { rateImportance } from './importanceRater';
import { generateChapterSummary } from './saveFileEngine';
import { backgroundQueue } from './backgroundQueue';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { generateNPCProfile, updateExistingNPCs, backfillNPCDrives } from './chatEngine';
import { scanPressure, buildPressurePatch } from './npcPressureTracker';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { toast } from '../components/Toast';
import { extractDivergences, mergeEntries, pruneChapterEntries, EMPTY_REGISTER } from './divergenceRegister';
import { saveDivergenceRegister } from '../store/campaignStore';

export async function runPostTurnPipeline(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[]
): Promise<void> {
    const activeCampaignId = state.activeCampaignId!;
    const { displayInput, npcLedger } = state;

    const results = await Promise.allSettled([
        runArchiveTrack(state, callbacks, displayInput, lastAssistantContent, allMsgs, activeCampaignId),
        runNPCTrack(state, callbacks, lastAssistantContent, allMsgs, npcLedger, activeCampaignId),
        runDivergenceTrack(state, callbacks, displayInput, lastAssistantContent, activeCampaignId),
        runPressureTrack(state, callbacks, displayInput, npcLedger, activeCampaignId),
    ]);

    for (const r of results) {
        if (r.status === 'rejected') {
            console.warn('[PostTurn] Track failed:', r.reason);
        }
    }
}

async function runArchiveTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    activeCampaignId: string
): Promise<void> {
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

    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistantContent, sceneImportance);
    const appendedSceneId = appendData?.sceneId;
    if (!appendData) {
        console.warn('[PostTurn] Archive append returned no data — skipping archive refresh');
        return;
    }

    const [freshIndex, freshTimeline, freshChapters] = await Promise.all([
        api.archive.getIndex(activeCampaignId),
        api.timeline.get(activeCampaignId),
        api.chapters.list(activeCampaignId),
    ]);
    callbacks.setArchiveIndex(freshIndex);
    callbacks.setTimeline?.(freshTimeline);
    state.setChapters(freshChapters);
    console.log(`[Archive] Appended scene #${appendedSceneId}`);

    const openChapter = freshChapters.find(c => !c.sealedAt);
    if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
        console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
        backgroundQueue.push('Chapter-AutoSeal', async () => {
            const sealResult = await api.chapters.seal(activeCampaignId);
            if (!sealResult) return;
            const sealedChapters = await api.chapters.list(activeCampaignId);
            state.setChapters(sealedChapters);
            toast.info(`Chapter "${sealResult.sealedChapter.title}" auto-sealed (${CHAPTER_SCENE_SOFT_CAP} scenes)`);

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

                const liveRegister = useAppStore.getState().divergenceRegister;
                if (liveRegister && liveRegister.entries.length > 0) {
                    const allChaptersNow = await api.chapters.list(activeCampaignId);
                    const sealedWithSummary = allChaptersNow.find(c => c.chapterId === sealResult.sealedChapter.chapterId);
                    const chapterForPrune = sealedWithSummary && (sealedWithSummary.summary || sealedWithSummary.unresolvedThreads?.length)
                        ? sealedWithSummary
                        : sealResult.sealedChapter;
                    const pruned = await pruneChapterEntries(sealProvider, chapterForPrune, liveRegister, allChaptersNow);
                    callbacks.setDivergenceRegister?.(pruned);
                    await saveDivergenceRegister(activeCampaignId, pruned);
                }
            }
        }).catch(err => console.warn('[Auto-Seal] Failed:', err));
    }

    const turnCount = state.incrementBookkeepingTurnCounter();
    const interval = state.autoBookkeepingInterval;
    if (turnCount >= interval && appendedSceneId) {
        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan (scene #${appendedSceneId})`);
        state.resetBookkeepingTurnCounter();

        const bkProvider = state.getFreshProvider();
        if (bkProvider) {
            const sceneId = appendedSceneId;
            const inventoryItems = state.getFreshContext().inventoryItems || [];
            const profileData = state.getFreshContext().characterProfileData || { name: '', race: '', class: '', level: 1, hp: { current: 20, max: 20 }, stats: {}, skills: [], abilities: [], traits: [], notes: '' };

            backgroundQueue.push('Profile-Scan', async () => {
                const newProfile = await scanCharacterProfile(bkProvider, state.getMessages(), profileData);
                callbacks.updateContext({
                    characterProfile: JSON.stringify(newProfile), // legacy sync
                    characterProfileData: newProfile,
                    characterProfileLastScene: sceneId,
                });
                const s = useAppStore.getState();
                if (s.activeCampaignId === activeCampaignId && 'setCharacterProfileData' in s) {
                    (s as any).setCharacterProfileData(newProfile);
                }
                console.log(`[Auto Bookkeeping] Profile updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Profile scan failed:', err));

            backgroundQueue.push('Inventory-Scan', async () => {
                const newItems = await scanInventory(bkProvider, state.getMessages(), inventoryItems);
                callbacks.updateContext({
                    inventory: newItems.map(it => `- ${it.qty > 1 ? `${it.qty}x ` : ''}${it.name}`).join('\n'), // legacy sync
                    inventoryItems: newItems,
                    inventoryLastScene: sceneId,
                });
                const s = useAppStore.getState();
                if (s.activeCampaignId === activeCampaignId && 'setInventoryItems' in s) {
                    (s as any).setInventoryItems(newItems);
                }
                console.log(`[Auto Bookkeeping] Inventory updated at scene #${sceneId}`);
            }).catch(err => console.warn('[Auto Bookkeeping] Inventory scan failed:', err));
        }
    }
}

async function runNPCTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    lastAssistantContent: string,
    allMsgs: ChatMessage[],
    npcLedger: import('../types').NPCEntry[],
    activeCampaignId: string
): Promise<void> {
    const extractedNames = extractNPCNames(lastAssistantContent);
    if (extractedNames.length === 0) return;

    const freshProvider = state.getFreshProvider();
    const validatedNames = freshProvider
        ? await validateNPCCandidates(freshProvider, extractedNames, lastAssistantContent)
        : extractedNames;

    if (validatedNames.length === 0) return;

    const { newNames, existingNpcs: existingNpcsToUpdate } = classifyNPCNames(validatedNames, npcLedger);

    const guardedAddNPC = (npc: Parameters<typeof callbacks.addNPC>[0]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[NPC Auto-Gen] Dropping NPC "${npc.name}" — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        callbacks.addNPC(npc);
    };

    const guardedUpdateNPC = (id: string, patch: Parameters<typeof callbacks.updateNPC>[1]) => {
        const currentId = useAppStore.getState().activeCampaignId;
        if (currentId !== activeCampaignId) {
            console.warn(`[NPC Update] Dropping update for NPC ${id} — campaign switched (${activeCampaignId} → ${currentId})`);
            return;
        }
        callbacks.updateNPC(id, patch);
    };

    for (const potentialName of newNames) {
        console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — queuing background profile generation...`);
        const genProvider = state.getFreshProvider();
        if (genProvider) {
            backgroundQueue.push(
                `NPC-Gen:${potentialName}`,
                () => generateNPCProfile(genProvider, allMsgs, potentialName, guardedAddNPC)
            ).catch(err => console.warn(`[NPC Auto-Gen] Background generation failed for "${potentialName}":`, err));
        }
    }

    if (existingNpcsToUpdate.length > 0) {
        const updateProvider = state.getFreshProvider();
        if (updateProvider) {
            backgroundQueue.push(
                `NPC-Update:${existingNpcsToUpdate.map(n => n.name).join(',')}`,
                () => updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, guardedUpdateNPC)
            ).catch(err => console.warn('[NPC Update] Background update failed:', err));
        }

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

async function runDivergenceTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    lastAssistantContent: string,
    activeCampaignId: string
): Promise<void> {
    if (state.settings.autoExtractDivergences === false) return;
    if (!callbacks.setDivergenceRegister) return;

    const divProvider = state.getFreshProvider();
    if (!divProvider) return;

    const currentRegister = state.divergenceRegister || EMPTY_REGISTER;
    const sceneText = `[User]: ${displayInput.slice(0, 600)}\n[GM]: ${lastAssistantContent.slice(0, 1200)}`;
    const archiveIndex = state.archiveIndex;
    const sceneId = archiveIndex.length > 0
        ? String(parseInt(archiveIndex[archiveIndex.length - 1].sceneId, 10) || 0).padStart(3, '0')
        : '000';

    const { entries } = await extractDivergences(divProvider, sceneText, sceneId, currentRegister);
    if (entries.length > 0) {
        const merged = mergeEntries(currentRegister, entries, sceneId);
        callbacks.setDivergenceRegister(merged);

        const lastMsg = state.getMessages().slice().reverse().find(m => m.role === 'assistant');
        if (lastMsg && callbacks.updateMessageDivergence) {
            callbacks.updateMessageDivergence(lastMsg.id, entries.map(e => e.id));
        }

        try {
            await saveDivergenceRegister(activeCampaignId, merged);
        } catch (e) {
            console.warn('[DivergenceRegister] Failed to save register to server:', e);
        }

        console.log(`[DivergenceRegister] Scene #${sceneId}: ${entries.length} entries extracted`);
    }
}

async function runPressureTrack(
    state: TurnState,
    callbacks: TurnCallbacks,
    displayInput: string,
    npcLedger: import('../types').NPCEntry[],
    activeCampaignId: string
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
}
