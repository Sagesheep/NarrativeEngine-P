import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, ArchiveScene, TimelineEvent, EndpointConfig, ProviderConfig, ArchiveChapter } from '../types';
import { uid } from '../utils/uid';
import { API_BASE as API } from '../lib/apiBase';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from './chatEngine';
import { retrieveRelevantLore, searchLoreByQuery } from './loreRetriever';
import { recallArchiveScenes, retrieveArchiveMemory, fetchArchiveScenes } from './archiveMemory';
import { rankChapters, recallWithChapterFunnel } from './archiveChapterEngine';
import { generateChapterSummary } from './saveFileEngine';
import { rollEngines, rollDiceFairness } from './engineRolls';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';
import { CHAPTER_SCENE_SOFT_CAP } from '../types';
import { rateImportance } from './importanceRater';
import { recommendContext } from './contextRecommender';
import { backgroundQueue } from './backgroundQueue';
import { scanCharacterProfile } from './characterProfileParser';
import { scanInventory } from './inventoryParser';
import { toast } from '../components/Toast';
import { sanitizePayloadForApi } from './lib/payloadSanitizer';

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

    // Synchronous lore extraction (non-blocking)
    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, input, 1200, messages)
        : undefined;

    // Prepare parallel promises
    let sceneNumber: string | undefined;
    let archiveRecall: ArchiveScene[] | undefined;
    let recommendedNPCNames: string[] | undefined;

    const timelinePromise = activeCampaignId ? fetch(`${API}/campaigns/${activeCampaignId}/archive/next-scene`)
        .then(async res => {
            if (res.ok) {
                const snData = await res.json();
                sceneNumber = snData.sceneId; 
                console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
            }
        }).catch(() => { /* ignored */ }) : Promise.resolve();

    // ─── Phase 4A: Two-Stage Chapter Funnel Retrieval ───
    const archivePromise = (archiveIndex.length > 0 && activeCampaignId)
        ? (async () => {
            const chapters = state.chapters;
            const hasSealedChapters = chapters.some(c => c.sealedAt && c.summary);
            
            if (!hasSealedChapters) {
                // No sealed chapters - use flat retrieval unchanged
                const result = await recallArchiveScenes(
                    activeCampaignId, archiveIndex, input, messages, 3000,
                    npcLedger, (state as any).semanticFacts
                );
                archiveRecall = result;
                return;
            }
            
            // Stage 1: Synchronous 3D scoring (~1ms)
            const rankedChapters = rankChapters(
                chapters, input, messages, npcLedger, (state as any).semanticFacts
            );
            
            // Stage 2: LLM validation with 3s timeout
            const utilityConfig = state.getUtilityEndpoint?.();
            const FUNNEL_TIMEOUT_MS = 8000;
            
            const funnelPromise = recallWithChapterFunnel(
                chapters, archiveIndex, input, messages,
                npcLedger, (state as any).semanticFacts, utilityConfig,
                activeCampaignId, 3000
            );
            
            const timeoutPromise = new Promise<ArchiveScene[]>((resolve) => {
                setTimeout(() => {
                    console.warn('[ChapterFunnel] Timeout - using top-3 fallback');
                    const fallbackRanges: [string, string][] = rankedChapters
                        .slice(0, 3)
                        .map(ch => ch.sceneRange);
                    const openChapter = chapters.find(c => !c.sealedAt);
                    if (openChapter) fallbackRanges.push(openChapter.sceneRange);
                    
                    const matchedIds = retrieveArchiveMemory(
                        archiveIndex, input, messages, npcLedger,
                        undefined, (state as any).semanticFacts, fallbackRanges
                    );
                    fetchArchiveScenes(activeCampaignId!, matchedIds, 3000)
                        .then(resolve)
                        .catch(() => resolve([]));
                }, FUNNEL_TIMEOUT_MS);
            });
            
            archiveRecall = await Promise.race([funnelPromise, timeoutPromise]);
            
            // Double-fallback: if funnel returned empty
            if (archiveRecall.length === 0) {
                console.warn('[ChapterFunnel] Empty result - falling back to flat retrieval');
                archiveRecall = await recallArchiveScenes(
                    activeCampaignId, archiveIndex, input, messages, 3000,
                    npcLedger, (state as any).semanticFacts
                );
            }
        })()
        : Promise.resolve();

    const utilityEndpoint = state.getUtilityEndpoint?.();
    const recommenderPromise = utilityEndpoint?.endpoint ? recommendContext(
        utilityEndpoint,
        npcLedger,
        loreChunks,
        messages,
        finalInput
    ).then(result => {
        recommendedNPCNames = result.relevantNPCNames;
        console.log(`[TurnOrchestrator] Recommender returned: ${recommendedNPCNames.length} NPCs, ${result.relevantLoreIds.length} lore`);
    }).catch(err => {
        console.warn('[TurnOrchestrator] UtilityAI recommender failed:', err);
    }) : Promise.resolve();

    // Timeline events — already in state from last load; used directly in buildPayload
    const timelineEvents: TimelineEvent[] = state.timeline || [];

    // Await all async operations simultaneously, with a 10s safety timeout.
    // If any individual operation hangs, we proceed with whatever completed rather than blocking indefinitely.
    const CONTEXT_GATHER_TIMEOUT_MS = 15_000;
    await Promise.race([
        Promise.all([timelinePromise, archivePromise, recommenderPromise]),
        new Promise<void>((resolve) => setTimeout(() => {
            console.warn('[TurnOrchestrator] Context gather timeout (10s) — proceeding with partial results');
            resolve();
        }, CONTEXT_GATHER_TIMEOUT_MS)),
    ]);

    // ─── Pinned Chapter Injection ───────────────────────────────────────
    if (state.pinnedChapterIds.length > 0 && activeCampaignId) {
        const alreadyCoveredIds = new Set((archiveRecall ?? []).map(s => s.sceneId));
        for (const pinnedId of state.pinnedChapterIds) {
            const pinnedChapter = state.chapters.find(c => c.chapterId === pinnedId);
            if (!pinnedChapter) continue;
            const startNum = parseInt(pinnedChapter.sceneRange[0], 10);
            const endNum = parseInt(pinnedChapter.sceneRange[1], 10);
            const sceneIds = Array.from({ length: endNum - startNum + 1 }, (_, i) =>
                String(startNum + i).padStart(3, '0')
            ).filter(id => !alreadyCoveredIds.has(id));
            if (sceneIds.length > 0) {
                try {
                    const pinnedScenes = await fetchArchiveScenes(activeCampaignId, sceneIds, 1500);
                    archiveRecall = [...(archiveRecall ?? []), ...pinnedScenes];
                    console.log(`[Pin] Injected ${pinnedScenes.length} scenes from pinned chapter ${pinnedId}`);
                } catch (err) {
                    console.warn(`[Pin] Failed to fetch pinned chapter ${pinnedId}:`, err);
                }
            }
        }
        state.clearPinnedChapters();
    }

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

        const tools = allowTools ? [{
            type: 'function',
            function: {
                name: 'query_campaign_lore',
                description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
                parameters: {
                    type: 'object',
                    properties: { query: { type: 'string', description: 'The specific search query' } },
                    required: ['query']
                }
            }
        }, {
            type: 'function',
            function: {
                name: 'update_scene_notebook',
                description: 'Update the scene notebook for tracking temporary state — active spells, timers, NPC positions, environmental conditions, combat state. Actions: add (create note), remove (delete by text match), clear (wipe all). Max 50 notes, max 5 actions per call. Use sparingly — only for volatile scene state that changes within a scene.',
                parameters: {
                    type: 'object',
                    properties: {
                        actions: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    op: { type: 'string', enum: ['add', 'remove', 'clear'] },
                                    text: { type: 'string', description: 'Note text (ignored for clear op)' }
                                },
                                required: ['op']
                            },
                            description: 'Array of notebook actions to perform (max 5)',
                            maxItems: 5
                        }
                    },
                    required: ['actions']
                }
            }
        }] : undefined;

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

                    let query = '';
                    try { query = JSON.parse(toolCall.arguments).query || ''; } catch { /* Ignore */ }

                    let toolResult = "No relevant lore found.";
                    if (query) {
                        const found = searchLoreByQuery(loreChunks, query);
                        if (found.length > 0) {
                            toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
                        }
                    }

                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: toolResult,
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

                    let notebookActions: { op: string; text?: string }[] = [];
                    try { notebookActions = JSON.parse(toolCall.arguments).actions || []; } catch { /* Ignore */ }

                    const currentNotebook = [...state.context.notebook];
                    let opsCount = 0;
                    const MAX_NOTEBOOK_OPS = 5;
                    const MAX_NOTEBOOK_NOTES = 50;

                    for (const action of notebookActions) {
                        if (opsCount >= MAX_NOTEBOOK_OPS) break;
                        if (action.op === 'add' && action.text && currentNotebook.length < MAX_NOTEBOOK_NOTES) {
                            currentNotebook.push({ id: uid(), text: action.text.trim(), timestamp: Date.now() });
                        } else if (action.op === 'remove' && action.text) {
                            const searchLower = action.text.toLowerCase().trim();
                            const idx = currentNotebook.findIndex(n => n.text.toLowerCase().includes(searchLower));
                            if (idx !== -1) currentNotebook.splice(idx, 1);
                        } else if (action.op === 'clear') {
                            currentNotebook.length = 0;
                        }
                        opsCount++;
                    }

                    callbacks.updateContext({ notebook: currentNotebook });
                    console.log(`[Notebook] Updated: ${currentNotebook.length} notes active (${opsCount} ops)`);

                    const toolResult = `Notebook updated. ${currentNotebook.length} notes active.`;
                    const toolMsgId = uid();
                    callbacks.addMessage({
                        id: toolMsgId,
                        role: 'tool' as const,
                        content: toolResult,
                        timestamp: Date.now(),
                        name: toolCall.name,
                        tool_call_id: toolCall.id,
                        ephemeral: true
                    });

                    currentPayload.push({
                        role: 'tool',
                        content: toolResult,
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
// ── Private AI Player Logic ───────────────────────────────────────────

async function handleInterventions(state: TurnState, callbacks: TurnCallbacks, finalInput: string, abortController: AbortController) {
    const { context, forcedInterventions, messages } = state;
    const activeTriggers: ('enemy' | 'neutral' | 'ally')[] = [];

    // Helper to check if an AI player is locked out due to newly established cooldown limits
    const isCooldownActive = (type: 'enemy' | 'neutral' | 'ally') => {
        const cooldownValue = context[`${type}Cooldown` as keyof GameContext] as number ?? 2;
        if (cooldownValue === 0) return false;
        
        const nameMatch = `AI_${type.toUpperCase()}`;
        // Cooldown N means N user turns. 1 full turn typically is 2 messages (user + gm). 
        // Adding +1 ensures we check the slice properly spanning back to the last trigger.
        const sliceCount = (cooldownValue * 2) + 1;
        const recentMessages = messages.slice(-Math.abs(sliceCount));
        
        return recentMessages.some(m => m.name === nameMatch);
    };

    let nextQueue = [...(context.interventionQueue || [])];

    // Priority 1: Manual forces (UI buttons, etc)
    if (forcedInterventions && forcedInterventions.length > 0) {
        activeTriggers.push(...forcedInterventions);
    } 
    else {
        // Priority 2: Pop ONE from the existing queue and update context
        if (nextQueue.length > 0) {
            const nextType = nextQueue.shift()!; // Take first in queue
            activeTriggers.push(nextType);
            callbacks.updateContext({ interventionQueue: nextQueue });
        } 
        // Priority 3: Only roll if the queue is empty
        else if (context.interventionChance) {
            const chance = context.interventionChance;
            const rolledSuccess: ('enemy' | 'neutral' | 'ally')[] = [];

            // Execute 3 independent rolls, restricting by active respective cooldown
            if (context.enemyPlayerActive && !isCooldownActive('enemy') && Math.random() * 100 < chance) rolledSuccess.push('enemy');
            if (context.neutralPlayerActive && !isCooldownActive('neutral') && Math.random() * 100 < chance) rolledSuccess.push('neutral');
            if (context.allyPlayerActive && !isCooldownActive('ally') && Math.random() * 100 < chance) rolledSuccess.push('ally');

            if (rolledSuccess.length > 0) {
                // Fire the first successful roll immediately this turn
                activeTriggers.push(rolledSuccess[0]);
                // Push the remaining successes into the state queue for subsequent turns
                if (rolledSuccess.length > 1) {
                    callbacks.updateContext({ interventionQueue: rolledSuccess.slice(1) });
                }
            }
        }
    }

    if (activeTriggers.length === 0) return;

    for (const type of activeTriggers) {
        try {
            await generateAIPlayerAction(state, callbacks, type, finalInput, abortController);
        } catch (err) {
            console.warn(`[AI Player] ${type} failed to generate:`, err);
        }
    }
}


async function generateAIPlayerAction(
    state: TurnState, 
    callbacks: TurnCallbacks, 
    type: 'enemy' | 'neutral' | 'ally',
    triggerInput: string,
    abortController: AbortController
) {
    const { context, settings, messages, npcLedger, loreChunks } = state;
    const activePreset = settings.presets.find(p => p.id === settings.activePresetId) || settings.presets[0];
    
    // Step 4: Determine World Genre/Context from Lore
    let worldGenre = context.worldVibe;
    if (!worldGenre && loreChunks.length > 0) {
        const overview = loreChunks.find(c => c.category === 'world_overview') 
                      || loreChunks.find(c => c.header.toLowerCase().includes('overview'))
                      || loreChunks.find(c => c.alwaysInclude && c.priority > 8);
        
        if (overview) {
            worldGenre = `${overview.header}: ${overview.content.split('\n')[0].slice(0, 300)}`;
        }
    }
    worldGenre = worldGenre || "General Fantasy";

    const endpoint = (type === 'enemy' ? activePreset.enemyAI 
                     : type === 'neutral' ? activePreset.neutralAI 
                     : activePreset.allyAI) || activePreset.storyAI;

    if (!endpoint || !endpoint.endpoint) return;

    const personaPrompt = (type === 'enemy' ? context.enemyPlayerPrompt 
                         : type === 'neutral' ? context.neutralPlayerPrompt 
                         : context.allyPlayerPrompt);

    const d20 = Math.floor(Math.random() * 20) + 1;
    let tier = "Success";
    if (d20 <= (context.diceConfig?.catastrophe ?? 2)) tier = "Catastrophe";
    else if (d20 <= (context.diceConfig?.failure ?? 6)) tier = "Failure";
    else if (d20 >= (context.diceConfig?.crit ?? 20)) tier = "Critical";
    else if (d20 >= (context.diceConfig?.triumph ?? 19)) tier = "Triumph";

    const relevantNPCs = npcLedger.filter(npc => {
        const d = npc.disposition.toLowerCase();
        if (type === 'enemy') return d.includes('hostile') || d.includes('enemy');
        if (type === 'ally') return d.includes('ally') || d.includes('friendly');
        return !d.includes('hostile') && !d.includes('enemy') && !d.includes('ally') && !d.includes('friendly');
    });

    const npcContext = relevantNPCs.length > 0 
        ? "\n\nRELEVANT NPCs IN SCENE:\n" + relevantNPCs.map(n => 
            `- ${n.name} (Status: ${n.status}) | Goals: ${n.goals} | Personality: ${n.personality || n.disposition || 'Unknown'}${n.voice ? ' | Voice: ' + n.voice : ''}`
          ).join('\n')
        : "";

    const systemPrompt = [
        `WORLD GENRE: ${worldGenre}`,
        personaPrompt,
        context.sceneNoteActive && context.sceneNote ? `CURRENT SCENE NOTE: ${context.sceneNote}` : "",
        `CRITICAL ROLE: You are an independent AI Player acting as a force or character of the ${type.toUpperCase()} alignment. YOU ARE NOT THE GAME MASTER.`,
        npcContext,
        "CRITICAL RULE 1: Describe your action in the 3rd-person perspective (e.g. 'The goblin lunges...', 'The guard turns...'). DO NOT use 2nd-person ('You...').",
        "CRITICAL RULE 2: Keep it brief: 1 to 3 sentences maximum.",
        "CRITICAL RULE 3: DO NOT resolve the user's action or narrate the outcome of their intent. You can only attempt to interfere, help, or act in parallel.",
        "CRITICAL RULE 4: Begin your action by explicitly stating your assumed ROLE based on what you are controlling (e.g., 'ROLE: A stray dog | ' or 'ROLE: Guard Kaelen | ').",
        "COGNITIVE FIREWALL: As an NPC, you are NOT omniscient. You CANNOT read the User's mind or understand out-of-character mechanics. Base your action SOLELY on the physical events described in the immediate history."
    ].filter(Boolean).join("\n\n");

    const recentHistory = messages.slice(-2).map(m => ({
        role: m.role as 'user' | 'assistant' | 'system' | 'tool',
        content: m.content || "",
        name: m.name
    }));

    const finalPayload: import('./chatEngine').OpenAIMessage[] = [
        { role: 'system' as const, content: systemPrompt },
        ...recentHistory,
        { role: 'user' as const, content: `The User just attempted: "${triggerInput}". You rolled a ${d20} (${tier}). State your action.` }
    ];

    callbacks.setLoadingStatus?.(`[AI PLAYER] ${type.toUpperCase()} IS INTERVENING...`);
    
    let resultText = "";
    await sendMessage(
        endpoint,
        finalPayload,
        () => {}, 
        (finalContent) => { resultText = finalContent; },
        (err) => { throw new Error(err); },
        undefined,
        abortController
    );

    if (resultText) {
        callbacks.addMessage({
            id: uid(),
            role: 'assistant',
            name: `AI_${type.toUpperCase()}`,
            content: `[Rolled ${d20} - ${tier}] ${resultText}`,
            timestamp: Date.now()
        });
    }
}
