import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, EndpointConfig, ProviderConfig } from '../types';
import { uid } from '../utils/uid';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from './chatEngine';
import { shouldCondense, condenseHistory } from './condenser';
import { runSaveFilePipeline } from './saveFileEngine';
import { retrieveRelevantLore, searchLoreByQuery } from './loreRetriever';
import { recallArchiveScenes } from './archiveMemory';
import { rollEngines, rollDiceFairness } from './engineRolls';
import { extractNPCNames, classifyNPCNames, validateNPCCandidates } from './npcDetector';
import { api } from './apiClient';

export type TurnCallbacks = {
    onCheckingNotes: (checking: boolean) => void;
    addMessage: (msg: ChatMessage) => void;
    updateLastAssistant: (content: string) => void;
    updateLastMessage: (patch: Partial<ChatMessage>) => void;
    updateContext: (patch: Partial<GameContext>) => void;
    setArchiveIndex: (entries: ArchiveIndexEntry[]) => void;
    updateNPC: (id: string, patch: Partial<NPCEntry>) => void;
    addNPC: (npc: NPCEntry) => void;
    setCondensed: (summary: string, upToIndex: number) => void;
    setCondensing: (v: boolean) => void;
    setStreaming: (v: boolean) => void;
    setLastPayloadTrace?: (trace: any) => void;
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
};

const sanitizePayloadForApi = (rawPayload: any[], allowTools: boolean) => {
    const cleaned: any[] = [];
    const openToolCalls = new Set<string>();

    for (const msg of rawPayload) {
        if (!msg || typeof msg !== 'object') continue;

        if (msg.role === 'assistant') {
            if (!allowTools || !Array.isArray(msg.tool_calls) || msg.tool_calls.length === 0) {
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            const validCalls = msg.tool_calls.filter((tc: any) =>
                tc && tc.type === 'function' && typeof tc.id === 'string' &&
                tc.function && typeof tc.function.name === 'string'
            );

            if (validCalls.length === 0) {
                const { tool_calls, ...assistantNoTools } = msg;
                cleaned.push(assistantNoTools);
                continue;
            }

            cleaned.push({ ...msg, tool_calls: validCalls });
            for (const tc of validCalls) openToolCalls.add(tc.id);
            continue;
        }

        if (msg.role === 'tool') {
            if (!allowTools) continue;

            const callId = typeof msg.tool_call_id === 'string' ? msg.tool_call_id : '';
            if (!callId || !openToolCalls.has(callId)) {
                console.warn('[Payload] Dropping orphan tool message:', msg.tool_call_id);
                continue;
            }

            openToolCalls.delete(callId);
            cleaned.push(msg);
            continue;
        }

        cleaned.push(msg);
    }

    return cleaned;
};

export async function runTurn(
    state: TurnState,
    callbacks: TurnCallbacks,
    abortController: AbortController
): Promise<void> {
    const { input, displayInput, settings, context, messages, condenser, loreChunks, npcLedger, archiveIndex, activeCampaignId, provider } = state;

    if (!provider) return;

    const relevantLore = loreChunks.length > 0
        ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, input, 1200, messages)
        : undefined;

    let sceneNumber: string | undefined;
    if (activeCampaignId) {
        try {
            const snRes = await fetch(`/api/campaigns/${activeCampaignId}/archive/next-scene`);
            if (snRes.ok) {
                const snData = await snRes.json();
                sceneNumber = snData.sceneId; 
                console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
            }
        } catch { /* ignored */ }
    }

    const archiveRecall = (archiveIndex.length > 0 && activeCampaignId)
        ? await recallArchiveScenes(activeCampaignId, archiveIndex, input, messages, 3000)
        : undefined;

    let finalInput = input;
    const engineResult = rollEngines(context);
    finalInput += engineResult.appendToInput;
    callbacks.updateContext(engineResult.updatedDCs);
    finalInput += rollDiceFairness(context);

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
        sceneNumber
    );

    const payload = payloadResult.messages;
    if (settings.debugMode && callbacks.setLastPayloadTrace) {
        callbacks.setLastPayloadTrace(payloadResult.trace);
    }

    const triggerCondense = async () => {
        if (condenser.isCondensing || !activeCampaignId) return;
        callbacks.setCondensing(true);
        try {
            const currentProvider = state.getFreshProvider();
            if (!currentProvider) return;
            
            const currentMsgs = state.getMessages();
            const uncondensed = currentMsgs.slice(condenser.condensedUpToIndex + 1);
            const saveResult = await runSaveFilePipeline(currentProvider as EndpointConfig | ProviderConfig, uncondensed, context);

            if (saveResult.canonSuccess) callbacks.updateContext({ canonState: saveResult.canonState });
            if (saveResult.indexSuccess) callbacks.updateContext({ headerIndex: saveResult.headerIndex });

            console.log(`[SavePipeline] Canon: ${saveResult.canonSuccess ? '✓' : '✗'}, Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);

            const result = await condenseHistory(
                currentProvider,
                currentMsgs,
                context, // Using stale context, but safe enough here
                condenser.condensedUpToIndex,
                condenser.condensedSummary,
                activeCampaignId,
                npcLedger.map(n => n.name),
                settings.contextLimit
            );
            callbacks.setCondensed(result.summary, result.upToIndex);

            const freshIndex = await api.archive.getIndex(activeCampaignId);
            callbacks.setArchiveIndex(freshIndex);
            console.log(`[Archive] Reloaded index: ${freshIndex.length} entries`);
        } catch (err) {
            console.error('[Condenser]', err);
        } finally {
            callbacks.setCondensing(false);
        }
    };

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0) => {
        if (toolCallCount === 0) {
            const userMsg = { id: uid(), role: 'user' as const, content: finalInput, displayContent: displayInput, timestamp: Date.now(), debugPayload: payload };
            callbacks.addMessage(userMsg);
        }

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
        }] : undefined;

        await sendMessage(
            provider,
            requestPayload,
            (fullText) => callbacks.updateLastAssistant(fullText),
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
                        tool_call_id: toolCall.id
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

                callbacks.setStreaming(false);
                callbacks.onCheckingNotes(false);
                callbacks.updateLastAssistant(finalText);
                
                const allMsgs = state.getMessages();
                const lastAssistant = allMsgs[allMsgs.length - 1];
                
                if (lastAssistant?.role === 'assistant' && lastAssistant.content && activeCampaignId) {
                    const appendData = await api.archive.append(activeCampaignId, displayInput, lastAssistant.content);
                    const appendedSceneId = appendData?.sceneId;
                    if (appendData) {
                        const freshIndex = await api.archive.getIndex(activeCampaignId);
                        callbacks.setArchiveIndex(freshIndex);
                        console.log(`[Archive] Appended scene #${appendedSceneId}`);
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
                                console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — spawning background profile generation...`);
                                const genProvider = state.getFreshProvider();
                                if (genProvider) {
                                    generateNPCProfile(genProvider, allMsgs, potentialName, callbacks.addNPC);
                                }
                            }

                            if (existingNpcsToUpdate.length > 0) {
                                const updateProvider = state.getFreshProvider();
                                if (updateProvider) {
                                    updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, callbacks.updateNPC);
                                }
                            }
                        }
                    }
                }
                
                if (settings.autoCondenseEnabled && shouldCondense(allMsgs, settings.contextLimit, condenser.condensedUpToIndex)) {
                    triggerCondense();
                }
            },
            (err) => {
                if (apiRetryCount === 0) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    setTimeout(() => executeTurn(currentPayload, toolCallCount, 1), 2000);
                } else if (apiRetryCount === 1) {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    setTimeout(() => executeTurn(currentPayload, 999, 2), 2000);
                } else {
                    callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                }
            },
            tools,
            abortController
        );
    };

    await executeTurn(payload);
}
