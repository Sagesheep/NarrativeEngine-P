import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, ArchiveScene, TimelineEvent, EndpointConfig, ProviderConfig, ArchiveChapter } from '../types';
import { uid } from '../utils/uid';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from './chatEngine';
import { generateChapterSummary } from './saveFileEngine';
import { rollEngines, rollDiceFairness } from './engineRolls';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../types';
import { rateImportance } from './importanceRater';
import { backgroundQueue } from './backgroundQueue';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { toast } from '../components/Toast';
import { sanitizePayloadForApi } from './lib/payloadSanitizer';
import { handleInterventions } from './aiPlayerEngine';
import { TOOL_DEFINITIONS, handleLoreTool, handleNotebookTool } from './toolHandlers';
import { gatherContext } from './contextGatherer';

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    setTimeline?: (events: TimelineEvent[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: any) => void;
    setLoadingStatus?: (status: string | null) => void;
};

export type TurnState = {
    input: string;
    displayInput: string;
    settings: AppSettings;
    context: GameContext;
    messages: ChatMessage[];
    condenser: CondenserState;
    loreChunks: LoreChunk[];
    npcLedger: NPCEntry[];
    archiveIndex: ArchiveIndexEntry[];
    activeCampaignId: string | null;
    provider: EndpointConfig | ProviderConfig | undefined;
    getMessages: () => ChatMessage[]; // to get fresh messages midway
    getFreshProvider: () => EndpointConfig | ProviderConfig | undefined;
    getUtilityEndpoint?: () => EndpointConfig | undefined; // optional — context recommender
    forcedInterventions?: ('enemy' | 'neutral' | 'ally')[]; // For manual triggers from UI
    timeline?: TimelineEvent[];
    // Phase 2B: store-lifted fields (eliminate useAppStore.getState() inside runTurn)
    chapters: ArchiveChapter[];
    pinnedChapterIds: string[];
    clearPinnedChapters: () => void;
    setChapters: (chapters: ArchiveChapter[]) => void;
    incrementBookkeepingTurnCounter: () => number;
    resetBookkeepingTurnCounter: () => void;
    autoBookkeepingInterval: number;
    getFreshContext: () => GameContext;
};


export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, messages, condenser, loreChunks, npcLedger, archiveIndex, activeCampaignId, provider } = state;

    if (!provider) return;

    let finalInput = input;
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    finalInput += rollDiceFairness(context);
    
    // --- AI INTERVENTION PHASE (Enemy, Neutral, Ally) ---
    await handleInterventions(state, callbacks, finalInput, abortController);

    // Provide immediate UI feedback by adding the user message synchronously before heavy async operations
    const userMsgId = uid();
    callbacks.addMessage({ 
        id: userMsgId, 
        role: 'user', 
        content: finalInput, 
        displayContent: displayInput, 
        timestamp: Date.now() 
    });
    callbacks.setStreaming(true);
    callbacks.setLoadingStatus?.('Gathering Context & Memories concurrently...');

    // ─── Context Gathering (parallel: archive, timeline, recommender, lore, pinned chapters) ───
    const { sceneNumber, archiveRecall, recommendedNPCNames, timelineEvents, relevantLore } =
        await gatherContext(state, finalInput, {
            chapters: state.chapters,
            pinnedChapterIds: state.pinnedChapterIds,
            clearPinnedChapters: state.clearPinnedChapters,
        });

    callbacks.setLoadingStatus?.('Architecting AI Prompt...');
    const payloadResult = buildPayload(
        settings,
        context,
        messages,
        finalInput,
        condenser.condensedSummary || undefined,
        condenser.condensedUpToIndex,
        relevantLore,
        npcLedger,
        archiveRecall,
        sceneNumber,
        recommendedNPCNames,
        undefined,      // semanticFactText — deprecated, replaced by timelineEvents
        archiveIndex,
        timelineEvents
    );

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }
    
    // Attach the debug payload to the user message we added earlier (memory-only, never persisted)
    if (settings.debugMode) {
        callbacks.updateLastMessage({ debugPayload: payload });
    }

    const stripLLMSceneHeader = (text: string): string =>
        text.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0) => {
        const assistantMsgId = uid();
        callbacks.addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
        callbacks.setStreaming(true);

        const allowTools = toolCallCount < 2 && apiRetryCount < 2;
        const requestPayload = sanitizePayloadForApi(currentPayload, allowTools);

        const tools = allowTools ? TOOL_DEFINITIONS : undefined;

        callbacks.setLoadingStatus?.(null);
        await sendMessage(
            provider,
            requestPayload,
            (fullText) => callbacks.updateLastAssistant(
                sceneNumber ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(fullText)}` : fullText
            ),
            async (finalText, toolCall) => {
                if (toolCall && toolCall.name === 'query_campaign_lore') {
                    callbacks.onCheckingNotes(true);
                    callbacks.setStreaming(false);
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }]
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: finalText || "",
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('./chatEngine').OpenAIMessage);

                    const { toolResult: loreResult } = handleLoreTool(toolCall.arguments, { loreChunks, notebook: state.context.notebook });

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: loreResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: loreResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('./chatEngine').OpenAIMessage);

                    setTimeout(() => {
                        callbacks.onCheckingNotes(false);
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'update_scene_notebook') {
                    callbacks.updateLastAssistant(finalText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }]
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: finalText || "",
                        tool_calls: [{ id: toolCall.id, type: 'function', function: { name: toolCall.name, arguments: toolCall.arguments } }]
                    } as unknown as import('./chatEngine').OpenAIMessage);

                    const { toolResult: notebookResult, updatedNotebook } = handleNotebookTool(toolCall.arguments, { loreChunks, notebook: state.context.notebook });
                    callbacks.updateContext({ notebook: updatedNotebook });

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: notebookResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: notebookResult,
                        name: toolCall.name,
                        tool_call_id: toolCall.id
                    } as unknown as import('./chatEngine').OpenAIMessage);

                    setTimeout(() => {
                        executeTurn(currentPayload, toolCallCount + 1);
                    }, 800);
                    return;
                }

                callbacks.setStreaming(false);
                callbacks.onCheckingNotes(false);
                const engineText = sceneNumber
                    ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                    : finalText;
                callbacks.updateLastAssistant(engineText);
                
                const allMsgs = state.getMessages();
                const lastAssistant = allMsgs[allMsgs.length - 1];
                
                if (lastAssistant?.role === 'assistant' && lastAssistant.content && activeCampaignId) {
                    let sceneImportance: number | undefined;
                    const importanceProvider = state.getFreshProvider();
                    if (importanceProvider) {
                        try {
                            sceneImportance = await rateImportance(importanceProvider, displayInput, lastAssistant.content, allMsgs);
                            console.log(`[ImportanceRater] Scene rated: ${sceneImportance}/5`);
                        } catch (err) {
                            console.warn('[ImportanceRater] Failed (non-fatal):', err);
                        }
                    }

                    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistant.content, sceneImportance);
                    const appendedSceneId = appendData?.sceneId;
                    if (appendData) {
                        const freshIndex = await api.archive.getIndex(activeCampaignId);
                        callbacks.setArchiveIndex(freshIndex);
                        const freshTimeline = await api.timeline.get(activeCampaignId);
                        callbacks.setTimeline?.(freshTimeline);
                        console.log(`[Archive] Appended scene #${appendedSceneId}`);

                        // ─── Auto-seal check ──────────────────────────────────────
                        const freshChapters = await api.chapters.list(activeCampaignId);
                        state.setChapters(freshChapters);
                        const openChapter = freshChapters.find(c => !c.sealedAt);
                        if (openChapter && openChapter.sceneCount >= CHAPTER_SCENE_SOFT_CAP) {
                            console.log(`[Auto-Seal] Chapter "${openChapter.title}" hit ${openChapter.sceneCount} scenes — sealing...`);
                            backgroundQueue.push('Chapter-AutoSeal', async () => {
                                const sealResult = await api.chapters.seal(activeCampaignId!);
                                if (!sealResult) return;
                                const sealedChapters = await api.chapters.list(activeCampaignId!);
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
                                    const chScenes = await api.archive.fetchScenes(activeCampaignId!, sIds);
                                    const freshCtx = state.getFreshContext();
                                    const summaryPatch = await generateChapterSummary(sealProvider, ch, chScenes, freshCtx.headerIndex);
                                    if (summaryPatch) {
                                        await api.chapters.update(activeCampaignId!, ch.chapterId, { ...summaryPatch, invalidated: false });
                                        const latestChapters = await api.chapters.list(activeCampaignId!);
                                        state.setChapters(latestChapters);
                                        console.log(`[Auto-Seal] Summary generated for "${ch.title}"`);
                                    }
                                }
                            }).catch(err => console.warn('[Auto-Seal] Failed:', err));
                        }
                    }

                    const content = lastAssistant.content;
                    const extractedNames = extractNPCNames(content);

                    if (extractedNames.length > 0) {
                        const provider = state.getFreshProvider();
                        const validatedNames = provider ? 
                            await validateNPCCandidates(provider, extractedNames, content) : 
                            extractedNames;

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

                    // ── Auto Bookkeeping: Profile & Inventory scan every N turns ──
                    const turnCount = state.incrementBookkeepingTurnCounter();
                    const interval = state.autoBookkeepingInterval;
                    if (turnCount >= interval && appendedSceneId) {
                        console.log(`[Auto Bookkeeping] Turn ${turnCount} >= interval ${interval} — queuing profile + inventory scan (scene #${appendedSceneId})`);
                        state.resetBookkeepingTurnCounter();

                        const bkProvider = state.getFreshProvider();
                        if (bkProvider) {
                            const sceneId = appendedSceneId;

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
            },
            (err) => {
                if (err === 'AbortError' || err === 'The user aborted a request.') {
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    return;
                }
                if (apiRetryCount === 0) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    toast.warning('LLM request failed — retrying...');
                    setTimeout(() => executeTurn(currentPayload, toolCallCount, 1), 2000);
                } else if (apiRetryCount === 1) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    toast.warning('Retry failed — trying without tools...');
                    setTimeout(() => executeTurn(currentPayload, 999, 2), 4000); // doubled backoff
                } else {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    toast.error('LLM request failed after retries');
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                }
            },
            tools,
            abortController
        );
    };

    await executeTurn(payload);
}
