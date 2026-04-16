import type { AppSettings, GameContext, ChatMessage, NPCEntry, LoreChunk, CondenserState, ArchiveIndexEntry, TimelineEvent, EndpointConfig, ProviderConfig, ArchiveChapter } from '../types';
import { uid } from '../utils/uid';
import { buildPayload, sendMessage } from './chatEngine';
import { rollEngines, rollDiceFairness } from './engineRolls';
import { toast } from '../components/Toast';
import { sanitizePayloadForApi } from './lib/payloadSanitizer';
import { handleInterventions } from './aiPlayerEngine';
import { TOOL_DEFINITIONS, handleLoreTool, handleNotebookTool } from './toolHandlers';
import { gatherContext } from './contextGatherer';
import { runPostTurnPipeline } from './postTurnPipeline';

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
    const historyInput = finalInput;
    finalInput += rollDiceFairness(context);
    
    // --- AI INTERVENTION PHASE (Enemy, Neutral, Ally) ---
    await handleInterventions(state, callbacks, finalInput, abortController);

    // Provide immediate UI feedback by adding the user message synchronously before heavy async operations
    const userMsgId = uid();
    callbacks.addMessage({ 
        id: userMsgId, 
        role: 'user', 
        content: historyInput, 
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
        }, abortController.signal);

    if (abortController.signal.aborted) return;

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
        callbacks.updateLastMessage({ debugPayload: { sections: payloadResult.debugSections, raw: payload } });
    }

    const stripLLMSceneHeader = (text: string): string =>
        text.replace(/^Scene\s*#\d+\s*\|?\s*/i, '');

    const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0, existingMsgId?: string) => {
        if (abortController.signal.aborted) return;

        const assistantMsgId = existingMsgId ?? uid();
        if (!existingMsgId) {
            callbacks.addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
        } else {
            callbacks.updateLastAssistant('');
        }
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
                    const loreEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    callbacks.updateLastAssistant(loreEngineText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }]
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: loreEngineText || "",
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
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
                    }, 800);
                    return;
                }

                if (toolCall && toolCall.name === 'update_scene_notebook') {
                    const nbEngineText = sceneNumber
                        ? `Scene #${sceneNumber} | ${stripLLMSceneHeader(finalText)}`
                        : finalText;
                    callbacks.updateLastAssistant(nbEngineText);

                    callbacks.updateLastMessage({
                        tool_calls: [{
                            id: toolCall.id,
                            type: 'function' as const,
                            function: { name: toolCall.name, arguments: toolCall.arguments }
                        }]
                    });

                    currentPayload.push({
                        role: 'assistant',
                        content: nbEngineText || "",
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
                        executeTurn(currentPayload, toolCallCount + 1, 0, assistantMsgId);
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
                const userIdx = allMsgs.findIndex(m => m.id === userMsgId);
                const turnAssistants = allMsgs.slice(userIdx + 1)
                    .filter(m => m.role === 'assistant' && m.content);
                const combinedContent = turnAssistants.map(m => m.content).join('\n\n');

                if (combinedContent && activeCampaignId) {
                    await runPostTurnPipeline(state, callbacks, combinedContent, allMsgs);
                }
            },
            (err) => {
                const isUserAbort = abortController.signal.aborted
                    || err === 'AbortError'
                    || err === 'The user aborted a request.'
                    || (typeof err === 'string' && err.includes('abort'));

                if (isUserAbort) {
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                    return;
                }

                const currentAssistantContent = state.getMessages().find(m => m.id === assistantMsgId)?.content || '';

                if (apiRetryCount === 0) {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                    }
                    toast.warning('LLM request failed — retrying...');
                    setTimeout(() => executeTurn(currentPayload, toolCallCount, 1, assistantMsgId), 2000);
                } else if (apiRetryCount === 1) {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                    }
                    toast.warning('Retry failed — trying without tools...');
                    setTimeout(() => executeTurn(currentPayload, 999, 2, assistantMsgId), 4000);
                } else {
                    if (!currentAssistantContent) {
                        callbacks.updateLastAssistant(`⚠️ Error: ${err}`);
                    }
                    toast.error('LLM request failed after retries');
                    callbacks.setStreaming(false);
                    callbacks.onCheckingNotes(false);
                    callbacks.setLoadingStatus?.(null);
                }
            },
            tools ? [...tools] : undefined,
            abortController
        );
    };

    await executeTurn(payload);
}
