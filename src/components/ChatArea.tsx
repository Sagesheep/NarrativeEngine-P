import { useState, useRef, useEffect } from 'react';
import { Send, Save, Loader2, Zap, Scroll, Edit2, RotateCcw, Trash2, Check, X, Square } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore, DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_ENCOUNTER_TYPES, DEFAULT_ENCOUNTER_TONES, DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY } from '../store/useAppStore';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from '../services/chatEngine';
import type { NPCEntry, ChatMessage, EndpointConfig, ProviderConfig } from '../types';
import { shouldCondense, condenseHistory } from '../services/condenser';
import { runSaveFilePipeline } from '../services/saveFileEngine';
import { retrieveRelevantLore, searchLoreByQuery } from '../services/loreRetriever';
import { recallArchiveScenes } from '../services/archiveMemory';
import { set } from 'idb-keyval';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function ChatArea() {
    const {
        messages,
        settings,
        context,
        condenser,
        loreChunks,
        npcLedger,
        archiveIndex,
        setArchiveIndex,
        clearArchive,
        updateLastAssistant,
        updateContext,
        setCondensed,
        setCondensing,
        activeCampaignId,
        deleteMessage,
        deleteMessagesFrom,
    } = useAppStore();

    const [input, setInput] = useState('');
    const [isStreaming, setStreaming] = useState(false); // Moved from store to local state
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const [visibleCount, setVisibleCount] = useState(20);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);
    const abortControllerRef = useRef<AbortController | null>(null);

    // Auto-scroll only when a NEW message appears, not on every streaming token update.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                // do nothing now since it's removed, but keeping ref intact in case
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    const triggerCondense = async () => {
        if (condenser.isCondensing) return;
        setCondensing(true);
        try {
            const provider = useAppStore.getState().getActiveStoryEndpoint();
            if (!provider) return;
            // Step 1 & 2: Generate Canon State + Header Index BEFORE condensing
            const currentCtx = useAppStore.getState().context;
            const saveResult = await runSaveFilePipeline(provider as EndpointConfig | ProviderConfig, messages, currentCtx);

            // Auto-populate fields
            if (saveResult.canonSuccess) {
                updateContext({ canonState: saveResult.canonState });
            }
            if (saveResult.indexSuccess) {
                updateContext({ headerIndex: saveResult.headerIndex });
            }

            console.log(`[SavePipeline] Canon: ${saveResult.canonSuccess ? '✓' : '✗'}, Index: ${saveResult.indexSuccess ? '✓' : '✗'}`);

            // Step 3: Condense history (using fresh context with updated glossary)
            const freshCtx = useAppStore.getState().context;
            const npcLedger = useAppStore.getState().npcLedger;
            const campaignId = useAppStore.getState().activeCampaignId || '';
            const result = await condenseHistory(
                provider,
                messages,
                freshCtx,
                condenser.condensedUpToIndex,
                condenser.condensedSummary,
                campaignId,
                npcLedger.map(n => n.name)
            );
            setCondensed(result.summary, result.upToIndex);

            // Reload archive index so newly indexed scenes are available for retrieval
            if (campaignId) {
                const res = await fetch(`/api/campaigns/${campaignId}/archive/index`);
                if (res.ok) {
                    const fresh = await res.json();
                    setArchiveIndex(fresh);
                    console.log(`[Archive] Reloaded index: ${fresh.length} entries`);
                }
            }
        } catch (err) {
            console.error('[Condenser]', err);
        } finally {
            setCondensing(false);
        }
    };

    const handleStop = () => {
        if (abortControllerRef.current) {
            abortControllerRef.current.abort();
            abortControllerRef.current = null;
        }
        setStreaming(false);
        setIsCheckingNotes(false);
    };

    const resetTextareaHeight = () => {
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
        }
    };

    const handleSend = async (overrideText?: string) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming) return;

        if (!overrideText) {
            setInput('');
            resetTextareaHeight();
        }

        const provider = useAppStore.getState().getActiveStoryEndpoint();
        if (!provider) return;

        const relevantLore = loreChunks.length > 0
            ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, textToUse, 1200, messages)
            : undefined;

        // Pre-assign scene number from server BEFORE building payload
        // Server reads .archive.md to get the true next scene number
        let sceneNumber: string | undefined;
        if (activeCampaignId) {
            try {
                const snRes = await fetch(`/api/campaigns/${activeCampaignId}/archive/next-scene`);
                if (snRes.ok) {
                    const snData = await snRes.json();
                    sceneNumber = snData.sceneId; // zero-padded string e.g. "014"
                    console.log(`[Scene Engine] Pre-assigned scene #${sceneNumber}`);
                }
            } catch { /* non-critical, AI will just not have the scene number */ }
        }

        // Archive recall — index-based, returns full verbatim scenes
        const archiveRecall = (archiveIndex.length > 0 && activeCampaignId)
            ? await recallArchiveScenes(activeCampaignId, archiveIndex, textToUse, messages, 3000)
            : undefined;

        let newSurpriseDC = context.surpriseDC ?? 95;
        let newEncounterDC = context.encounterDC ?? 198;
        let newWorldDC = context.worldEventDC ?? 498;
        let finalInput = textToUse;

        // Tier 1: Surprise Engine (Color/Ambient)
        if (context.surpriseEngineActive !== false) {
            const roll = Math.floor(Math.random() * 100) + 1;
            if (roll >= newSurpriseDC) {
                const typesList = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
                const tonesList = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
                const type = typesList[Math.floor(Math.random() * typesList.length)];
                const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

                finalInput += `\n[SURPRISE EVENT: ${type} (${tone})]`;
                newSurpriseDC = context.surpriseConfig?.initialDC || 95;
                console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newSurpriseDC}`);
            } else {
                console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newSurpriseDC}. Decreasing DC.`);
                newSurpriseDC = Math.max(5, newSurpriseDC - (context.surpriseConfig?.dcReduction || 3));
            }
        }

        // Tier 2: Encounter Engine (Challenges/Hooks)
        if (context.encounterEngineActive !== false) {
            const roll = Math.floor(Math.random() * 200) + 1;
            if (roll >= newEncounterDC) {
                const typesList = context.encounterConfig?.types || DEFAULT_ENCOUNTER_TYPES;
                const tonesList = context.encounterConfig?.tones || DEFAULT_ENCOUNTER_TONES;
                const type = typesList[Math.floor(Math.random() * typesList.length)];
                const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

                finalInput += `\n[ENCOUNTER EVENT: ${type} (${tone})]`;
                newEncounterDC = context.encounterConfig?.initialDC || 198;
                console.log(`[Encounter Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newEncounterDC}`);
            } else {
                console.log(`[Encounter Engine] Roll: ${roll} < DC: ${newEncounterDC}. Decreasing DC.`);
                newEncounterDC = Math.max(5, newEncounterDC - (context.encounterConfig?.dcReduction || 2));
            }
        }

        // Tier 3: World Engine (Seismic/Global)
        if (context.worldEngineActive !== false) {
            const worldRoll = Math.floor(Math.random() * 500) + 1;
            if (worldRoll >= newWorldDC) {
                const cfg = context.worldEventConfig || { initialDC: 498, dcReduction: 2, who: [], where: [], why: [], what: [] };
                const hasCustomTags = cfg.who && cfg.who.length >= 3 &&
                    cfg.where && cfg.where.length >= 3 &&
                    cfg.why && cfg.why.length >= 3 &&
                    cfg.what && cfg.what.length >= 3;

                const tag = hasCustomTags
                    ? `[WORLD_EVENT: ${cfg.who![Math.floor(Math.random() * cfg.who!.length)]} ${cfg.what![Math.floor(Math.random() * cfg.what!.length)]} ${cfg.why![Math.floor(Math.random() * cfg.why!.length)]} ${cfg.where![Math.floor(Math.random() * cfg.where!.length)]}]`
                    : `[WORLD_EVENT: ${DEFAULT_WORLD_WHO[Math.floor(Math.random() * DEFAULT_WORLD_WHO.length)]} ${DEFAULT_WORLD_WHAT[Math.floor(Math.random() * DEFAULT_WORLD_WHAT.length)]} ${DEFAULT_WORLD_WHY[Math.floor(Math.random() * DEFAULT_WORLD_WHY.length)]} ${DEFAULT_WORLD_WHERE[Math.floor(Math.random() * DEFAULT_WORLD_WHERE.length)]}]`;

                finalInput += `\n${tag}`;
                newWorldDC = cfg.initialDC || 498;
                console.log(`[World Engine] Triggered! Tag: ${tag}. Resetting DC to ${newWorldDC}`);
            } else {
                console.log(`[World Engine] Roll: ${worldRoll} < DC: ${newWorldDC}. Decreasing DC.`);
                newWorldDC = Math.max(5, newWorldDC - (context.worldEventConfig?.dcReduction || 2));
            }
        }

        updateContext({ surpriseDC: newSurpriseDC, encounterDC: newEncounterDC, worldEventDC: newWorldDC });

        // <--- DICE FAIRNESS ENGINE ---!>
        if (context.diceFairnessActive !== false) {
            const getOutcomeWord = (rollResult: number) => {
                const config = context.diceConfig || {
                    catastrophe: 2,
                    failure: 6,
                    success: 15,
                    triumph: 19,
                    crit: 20
                };
                if (rollResult <= config.catastrophe) return "Catastrophe";
                if (rollResult <= config.failure) return "Failure";
                if (rollResult <= config.success) return "Success";
                if (rollResult <= config.triumph) return "Triumph";
                return "Narrative Boon";
            };

            const generatePool = () => {
                const rolls = [
                    Math.floor(Math.random() * 20) + 1,
                    Math.floor(Math.random() * 20) + 1,
                    Math.floor(Math.random() * 20) + 1
                ].sort((a, b) => a - b);
                return `Disadvantage: ${getOutcomeWord(rolls[0])}, Normal: ${getOutcomeWord(rolls[1])}, Advantage: ${getOutcomeWord(rolls[2])}`;
            };

            finalInput += `\n[DICE OUTCOMES: COMBAT=(${generatePool()}) | PERCEPTION=(${generatePool()}) | STEALTH=(${generatePool()}) | SOCIAL=(${generatePool()}) | MOVEMENT=(${generatePool()}) | KNOWLEDGE=(${generatePool()}) | MUNDANE=(Narrative Boon)]`;
        }

        const payload = buildPayload(
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

        const executeTurn = async (currentPayload: any[], toolCallCount = 0, apiRetryCount = 0) => {
            if (toolCallCount === 0) {
                const userMsg = { id: uid(), role: 'user' as const, content: finalInput, displayContent: textToUse, timestamp: Date.now(), debugPayload: payload };
                useAppStore.getState().addMessage(userMsg);
            }

            const assistantMsgId = uid();
            useAppStore.getState().addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
            setStreaming(true);

            const allowTools = toolCallCount < 2 && apiRetryCount < 2;
            const requestPayload = sanitizePayloadForApi(currentPayload, allowTools);

            // Limit recursion: only provide tools if we haven't looped too many times/retries
            const tools = allowTools ? [{
                type: 'function',
                function: {
                    name: 'query_campaign_lore',
                    description: 'Search the Game Master notes for specific lore, rules, characters, or locations. Do NOT call this sequentially or spam it. If no relevant lore is found, immediately proceed with the narrative response. IMPORTANT: You MUST use the standard JSON tool call format. NEVER output raw XML <|DSML|> tags in your response text.',
                    parameters: {
                        type: 'object',
                        properties: { query: { type: 'string', "description": 'The specific search query' } },
                        required: ['query']
                    }
                }
            }] : undefined;

            abortControllerRef.current = new AbortController();

            await sendMessage(
                provider,
                requestPayload,
                (fullText) => updateLastAssistant(fullText),
                async (finalText, toolCall) => {
                    if (toolCall && toolCall.name === 'query_campaign_lore') {
                        setIsCheckingNotes(true);
                        setStreaming(false);

                        // We must ensure the assistant message in history is truly up to date
                        updateLastAssistant(finalText);

                        // Save tool call block to assistant message
                        const { updateLastMessage } = useAppStore.getState();
                        updateLastMessage({
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
                        } as unknown as import('../services/chatEngine').OpenAIMessage);

                        // Execute Tool locally
                        let query = '';
                        try { query = JSON.parse(toolCall.arguments).query || ''; } catch { /* Ignore missing query */ }

                        let toolResult = "No relevant lore found.";
                        if (query) {
                            const found = searchLoreByQuery(loreChunks, query);
                            if (found.length > 0) {
                                toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
                            }
                        }

                        // Save tool response
                        const toolMsgId = uid();
                        useAppStore.getState().addMessage({
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
                        } as unknown as import('../services/chatEngine').OpenAIMessage);

                        // Loop back to LLM after short visual delay
                        setTimeout(() => {
                            setIsCheckingNotes(false);
                            executeTurn(currentPayload, toolCallCount + 1);
                        }, 800);
                        return;
                    }

                    // Normal Completion
                    setStreaming(false);
                    setIsCheckingNotes(false);
                    updateLastAssistant(finalText); // Final sync
                    const allMsgs = useAppStore.getState().messages;
                    const lastAssistant = allMsgs[allMsgs.length - 1];
                    if (lastAssistant?.role === 'assistant' && lastAssistant.content) {
                        appendToArchive(textToUse, lastAssistant.content);

                        // ── NPC Auto-Generation: Parse AI response for character name tags ──
                        // Supports 3 formats:
                        //   1. [Name]        — plain brackets
                        //   2. [**Name**]    — bold brackets
                        //   3. [SYSTEM: NPC_ENTRY - NAME] — explicit system tag
                        const content = lastAssistant.content;
                        const extractedNames: string[] = [];

                        // Pattern to exclude generic roles like "Guard A" or "Scout 1"
                        const GENERIC_ROLE_PATTERN = /^(guard|scout|merchant|soldier|bandit|thug|villager|citizen|patron|cultist|goblin|orc|skeleton|zombie|enemy|monster|creature)\s+[a-z0-9]$/i;
                        const NPC_NAME_BLOCKLIST = new Set(["you", "i", "the", "a", "an", "and", "or", "but", "in", "on", "at", "to", "for", "with", "by", "about", "like", "through", "over", "before", "between", "after", "since", "without", "under", "within", "along", "following", "across", "behind", "beyond", "plus", "except", "but", "up", "out", "around", "down", "off", "above", "near"]);

                        // Pattern 1 & 2: [Name] or [**Name**] — no colons allowed inside (filters out [SYSTEM: ...])
                        // Now allows periods for honorifics like Mr. / Mrs. / Dr.
                        const bracketMatches = Array.from(content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _.'-]*[A-Za-z0-9.])\*{0,2}\]/g));
                        for (const m of bracketMatches) {
                            const raw = m[1].trim();
                            // Skip common false positives
                            if (raw.length < 2) continue;
                            if (raw.includes(' ') && raw === raw.toUpperCase()) continue;
                            // Skip blocklisted words
                            if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
                            // Skip generic roles
                            if (GENERIC_ROLE_PATTERN.test(raw)) continue;
                            extractedNames.push(raw);
                        }

                        // Pattern 3: [SYSTEM: NPC_ENTRY - NAME]
                        const entryMatches = Array.from(content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi));
                        for (const m of entryMatches) {
                            const raw = m[1].trim();
                            if (NPC_NAME_BLOCKLIST.has(raw.toLowerCase())) continue;
                            if (GENERIC_ROLE_PATTERN.test(raw)) continue;
                            extractedNames.push(raw);
                        }

                        if (extractedNames.length > 0) {
                            const { npcLedger, addNPC, updateNPC } = useAppStore.getState();
                            // Normalize: title-case all-caps single words (e.g., ORIN -> Orin)
                            const normalized = extractedNames.map(n =>
                                n === n.toUpperCase() ? n.charAt(0).toUpperCase() + n.slice(1).toLowerCase() : n
                            );
                            const uniqueNames = Array.from(new Set(normalized));

                            const existingNpcsToUpdate: NPCEntry[] = [];

                            for (const potentialName of uniqueNames) {
                                // Check if already in ledger (case-insensitive against name + aliases)
                                const existingNpc = npcLedger.find(npc => {
                                    if (!npc.name) return false;
                                    const aliasesRaw = npc.aliases || '';
                                    const allNames = [npc.name, ...aliasesRaw.split(',').map(a => a.trim())].filter(Boolean);
                                    const search = potentialName.toLowerCase();
                                    return allNames.some(n => {
                                        const lower = n.toLowerCase();
                                        return lower === search || lower.startsWith(search + ' ') || lower.endsWith(' ' + search);
                                    });
                                });

                                if (!existingNpc) {
                                    console.log(`[NPC Auto-Gen] New character detected: "${potentialName}" — spawning background profile generation...`);
                                    const genProvider = useAppStore.getState().getActiveStoryEndpoint();
                                    if (genProvider) {
                                        generateNPCProfile(genProvider, allMsgs, potentialName, addNPC);
                                    }
                                } else {
                                    existingNpcsToUpdate.push(existingNpc);
                                }
                            }

                            // Trigger batched background update for existing NPCs
                            if (existingNpcsToUpdate.length > 0) {
                                const updateProvider = useAppStore.getState().getActiveStoryEndpoint();
                                if (updateProvider) {
                                    updateExistingNPCs(updateProvider, allMsgs, existingNpcsToUpdate, updateNPC);
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
                        updateLastAssistant(`⚠️ Error: ${err}. Retrying...`);
                        setTimeout(() => executeTurn(currentPayload, toolCallCount, 1), 2000);
                    } else if (apiRetryCount === 1) {
                        updateLastAssistant(`⚠️ Error: ${err}. Retrying without tools...`);
                        setTimeout(() => executeTurn(currentPayload, 999, 2), 2000);
                    } else {
                        updateLastAssistant(`⚠️ Error: ${err}`);
                        setStreaming(false);
                        setIsCheckingNotes(false);
                    }
                },
                tools,
                abortControllerRef.current || undefined
            );
        };

        await executeTurn(payload);
    };

    const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
        setInput(e.target.value);
        if (inputRef.current) {
            inputRef.current.style.height = '40px';
            const newHeight = Math.min(inputRef.current.scrollHeight, 240);
            inputRef.current.style.height = `${newHeight}px`;
        }
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            if (editingMessageId) {
                handleEditSubmit();
            } else {
                handleSend();
            }
        }
    };

    const [isSaving, setIsSaving] = useState(false);

    const handleForceSave = () => {
        setIsSaving(true);
        const state = useAppStore.getState();
        if (state.activeCampaignId) {
            try {
                set(`nn_settings`, { settings: state.settings, activeCampaignId: state.activeCampaignId });
                set(`nn_campaign_${state.activeCampaignId}_state`, { context: state.context, messages: state.messages, condenser: state.condenser });
                set(`nn_campaign_${state.activeCampaignId}_npcs`, state.npcLedger);
            } catch (e) {
                console.error("[Save] Failed to force save to IndexedDB:", e);
            }
        }
        setTimeout(() => setIsSaving(false), 2000);
    };

    // ─── Archive helpers ───
    const appendToArchive = async (userText: string, assistantText: string) => {
        const campaignId = useAppStore.getState().activeCampaignId;
        if (!campaignId) return;
        try {
            const res = await fetch(`/api/campaigns/${campaignId}/archive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userContent: userText, assistantContent: assistantText }),
            });
            if (res.ok) {
                const data = await res.json();
                // Update archive index in store with the new entry appended
                const idxRes = await fetch(`/api/campaigns/${campaignId}/archive/index`);
                if (idxRes.ok) setArchiveIndex(await idxRes.json());
                console.log(`[Archive] Appended scene #${data.sceneId}`);
                return data.sceneId as string;
            }
        } catch (err) {
            console.warn('[Archive] Failed to append:', err);
        }
        return undefined;
    };

    /**
     * Find the earliest archive scene that corresponds to messages at or after
     * `fromTimestamp`, then delete all scenes from that point forward.
     */
    const rollbackArchiveFrom = async (fromTimestamp: number) => {
        const campaignId = useAppStore.getState().activeCampaignId;
        if (!campaignId) return;
        const currentIndex = useAppStore.getState().archiveIndex;
        if (!currentIndex.length) return;

        // Find the first scene whose timestamp >= fromTimestamp
        const sorted = [...currentIndex].sort((a, b) => parseInt(a.sceneId) - parseInt(b.sceneId));
        const target = sorted.find(e => e.timestamp >= fromTimestamp);
        if (!target) return;

        try {
            await fetch(`/api/campaigns/${campaignId}/archive/scenes-from/${target.sceneId}`, {
                method: 'DELETE'
            });
            // Refresh index in store
            const idxRes = await fetch(`/api/campaigns/${campaignId}/archive/index`);
            if (idxRes.ok) setArchiveIndex(await idxRes.json());
            console.log(`[Archive] Rolled back from scene #${target.sceneId}`);
        } catch (err) {
            console.warn('[Archive] Rollback failed:', err);
        }
    };

    const openArchive = async () => {
        if (!activeCampaignId) return;
        try {
            const res = await fetch(`/api/campaigns/${activeCampaignId}/archive/open`);
            if (!res.ok) {
                const data = await res.json();
                console.warn('[Archive]', data.error || 'Failed to open');
            }
        } catch (err) {
            console.warn('[Archive] Failed to open:', err);
        }
    };
    const handleClearArchive = async () => {
        if (!activeCampaignId || !window.confirm('Are you sure you want to PERMANENTLY delete the entire archive? This cannot be undone.')) return;
        try {
            const res = await fetch(`/api/campaigns/${activeCampaignId}/archive`, { method: 'DELETE' });
            if (res.ok) {
                clearArchive();
                console.log('[Archive] Cleared successfully');
            }
        } catch (err) {
            console.warn('[Archive] Failed to clear:', err);
        }
    };

    // ─── Edit & Regenerate logic ───
    const startEditing = (msg: ChatMessage) => {
        setEditingMessageId(msg.id);
        setInput(msg.displayContent || msg.content);
        inputRef.current?.focus();
    };

    const handleEditSubmit = () => {
        if (!editingMessageId) return;
        const msg = messages.find(m => m.id === editingMessageId);
        if (!msg) return;

        if (msg.role === 'user') {
            // Rollback archive to before this message's timestamp
            rollbackArchiveFrom(msg.timestamp);
            useAppStore.getState().deleteMessagesFrom(msg.id);
            const textToResend = input.trim();
            setInput('');
            resetTextareaHeight();
            setEditingMessageId(null);
            setTimeout(() => {
                handleSend(textToResend);
            }, 50);
        } else {
            useAppStore.getState().updateMessageContent(msg.id, input.trim());
            setInput('');
            resetTextareaHeight();
            setEditingMessageId(null);
        }
    };

    const handleRegenerate = (id: string) => {
        const msgs = useAppStore.getState().messages;
        const idx = msgs.findIndex(m => m.id === id);
        if (idx === -1) return;

        const prevMsgs = msgs.slice(0, idx);
        const lastUser = [...prevMsgs].reverse().find(m => m.role === 'user');

        if (lastUser) {
            // Rollback archive: the scene for lastUser's exchange gets removed
            rollbackArchiveFrom(lastUser.timestamp);
            deleteMessagesFrom(lastUser.id);
            setTimeout(() => {
                handleSend(lastUser.displayContent || lastUser.content);
            }, 50);
        }
    };


    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Transcript */}
            <div className="flex-1 overflow-y-auto px-2 md:px-4 py-4 space-y-3">
                {messages.length === 0 && (
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center space-y-3">
                            <div className="text-4xl">⚔</div>
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                Awaiting transmission...
                            </p>
                            <p className="text-text-dim/50 text-[11px]">
                                Paste your lore in the context drawer, configure your LLM, and begin.
                            </p>
                        </div>
                    </div>
                )}

                {/* Reverse Pagination: Load Older Messages Button */}
                {messages.length > visibleCount && (
                    <div className="flex justify-center py-2">
                        <button
                            onClick={() => setVisibleCount(prev => prev + 20)}
                            className="text-xs text-terminal/70 hover:text-terminal bg-terminal/10 hover:bg-terminal/20 px-4 py-2 rounded transition-colors"
                        >
                            ↑ Load older messages... ({messages.length - visibleCount} hidden)
                        </button>
                    </div>
                )}

                {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg) => {
                    let markdownContent: string = typeof msg.displayContent === 'string'
                        ? msg.displayContent
                        : (typeof msg.content === 'string' ? msg.content : '');

                    // Extract thinking block if present
                    let thinkingBlock = '';
                    const thinkMatch = markdownContent.match(/<think>([\s\S]*?)<\/think>/i);
                    if (thinkMatch) {
                        thinkingBlock = thinkMatch[1].trim();
                        // Strip reasoning from main content if hidden, or just to handle it separately
                        if (settings.showReasoning === false) {
                            markdownContent = markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                        } else {
                            // Even if shown, we might want to pull it out of the main markdown flow to style it
                            markdownContent = markdownContent.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
                        }
                    }

                    const parsedArgs = (msg as any).parsedArgs;
                    const hasSummary = msg.role === 'tool' && parsedArgs && Array.isArray(parsedArgs.summary);
                    const hasDebug = settings.debugMode === true && !!msg.debugPayload;

                    return (
                        <div
                            key={msg.id}
                            className={`group flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                        >
                            <div
                                className={`max-w-[95%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${msg.role === 'user'
                                    ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                                    : msg.role === 'system'
                                        ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                                        : 'bg-void-lighter border-l-2 border-border text-text-primary'
                                    }`}
                            >
                                {/* Action Bar */}
                                <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                                    {msg.role !== 'system' && (
                                        <button title="Edit" onClick={() => startEditing(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                            <Edit2 size={10} />
                                        </button>
                                    )}
                                    {msg.role === 'assistant' && (
                                        <button title="Regenerate" onClick={() => handleRegenerate(msg.id)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                                            <RotateCcw size={10} />
                                        </button>
                                    )}
                                    <button title="Delete" onClick={() => deleteMessage(msg.id)} className="text-text-dim hover:text-red-400 p-1 bg-void-lighter rounded">
                                        <Trash2 size={10} />
                                    </button>
                                </div>

                                <div className="flex items-center gap-2 mb-1">
                                    <span
                                        className={`text-[10px] uppercase tracking-widest ${msg.role === 'user'
                                            ? 'text-terminal'
                                            : msg.role === 'system'
                                                ? 'text-ember'
                                                : 'text-ice'
                                            }`}
                                    >
                                        {msg.role === 'user' ? '► YOU' : msg.role === 'tool' ? '◈ TOOL' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                                    </span>
                                    {msg.role === 'tool' && msg.name && (
                                        <span className="text-[9px] text-terminal font-bold tracking-wider opacity-80">
                                            [{msg.name}]
                                        </span>
                                    )}
                                    <span className="text-[9px] text-text-dim">
                                        {new Date(msg.timestamp).toLocaleTimeString()}
                                    </span>
                                </div>

                                <div className="gm-prose">
                                    {thinkingBlock && settings.showReasoning && (
                                        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden">
                                            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                                                <Loader2 size={10} className={isStreaming && msg.id === messages[messages.length - 1].id ? "animate-spin" : ""} />
                                                Cognitive Process
                                            </summary>
                                            <div className="p-3 text-[11px] text-text-dim/80 italic border-t border-terminal/10 max-h-[300px] overflow-y-auto whitespace-pre-wrap leading-relaxed">
                                                {thinkingBlock}
                                            </div>
                                        </details>
                                    )}
                                    <ReactMarkdown>{markdownContent}</ReactMarkdown>
                                    {hasSummary && (
                                        <div className="mt-2 pl-3 border-l-2 border-terminal/30 text-[10px] text-text-dim">
                                            <div className="uppercase tracking-widest text-terminal/60 mb-1">Generated Output:</div>
                                            <ul className="list-disc leading-tight space-y-1">
                                                {(parsedArgs.summary as any[]).map((s: any, i: number) => (
                                                    <li key={i}>{typeof s === 'string' ? s : String(s)}</li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>

                                {hasDebug && (
                                    <details className="mt-2 border-t border-border/50 pt-2 text-[10px]">
                                        <summary className="cursor-pointer text-terminal/60 hover:text-terminal transition-colors select-none">
                                            [View Raw Payload]
                                        </summary>
                                        <pre className="mt-2 bg-void p-2 overflow-x-auto text-text-dim text-[9px] font-mono leading-tight whitespace-pre-wrap break-all">
                                            {JSON.stringify(msg.debugPayload, null, 2)}
                                        </pre>
                                    </details>
                                )}
                            </div>
                        </div>
                    );
                })}

                {isCheckingNotes ? (
                    <div className="flex items-center gap-2 text-terminal/80 text-xs px-4">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse-slow">The GM is checking their notes...</span>
                    </div>
                ) : isStreaming && (
                    <div className="flex items-center gap-2 text-terminal text-xs px-4">
                        <Loader2 size={12} className="animate-spin" />
                        <span className="animate-pulse-slow">Generating...</span>
                    </div>
                )}

                <div ref={bottomRef} />
            </div>

            {/* Macro Bar */}
            <div className="px-2 md:px-4 pb-1 flex gap-2 overflow-x-auto">
                <button
                    onClick={handleForceSave}
                    disabled={isSaving}
                    className="flex items-center gap-1.5 bg-void border border-emerald-500/30 hover:border-emerald-500 text-emerald-500 text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-emerald-500/5 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                    {isSaving ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}
                    <span className="hidden xs:inline">{isSaving ? 'SAVING...' : 'SAVE CAMPAIGN'}</span>
                    {!isSaving && <span className="inline xs:hidden">SAVE</span>}
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={condenser.isCondensing || messages.length < 6}
                    className="flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    {condenser.isCondensing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                    {condenser.isCondensing ? 'Condensing...' : 'Condense'}
                </button>
                <button
                    onClick={openArchive}
                    disabled={!activeCampaignId}
                    className="flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto"
                >
                    <Scroll size={13} />
                    Archive
                </button>
                <button
                    onClick={handleClearArchive}
                    disabled={!activeCampaignId || archiveIndex.length === 0}
                    className="flex items-center gap-1.5 bg-void border border-danger/30 hover:border-danger text-danger text-[10px] sm:text-[11px] uppercase tracking-wider px-2 sm:px-3 py-1.5 transition-all hover:bg-danger/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    <Trash2 size={13} />
                    Clear Archive
                </button>
                {
                    condenser.condensedSummary && (
                        <span className="text-[9px] text-terminal/60 self-center ml-1">
                            ● condensed
                        </span>
                    )
                }
            </div>

            {/* Input Area */}
            <div className="flex-shrink-0 bg-void border-t border-border">
                {editingMessageId && (
                    <div className="bg-terminal/10 border-b border-border px-4 py-2 flex items-center justify-between">
                        <span className="text-terminal text-[11px] uppercase tracking-wider font-bold flex items-center gap-2">
                            <Edit2 size={12} /> Editing Message
                        </span>
                        <button
                            onClick={() => { setEditingMessageId(null); setInput(''); }}
                            className="text-text-dim hover:text-text-primary flex items-center gap-1 text-[10px] uppercase tracking-wider"
                        >
                            <X size={12} /> Cancel
                        </button>
                    </div>
                )}
                <div className="px-2 sm:px-4 pb-3 sm:pb-4 pt-3 sm:pt-4">
                    <div className="flex gap-1 border border-border bg-void focus-within:border-terminal transition-colors items-end p-1 rounded-sm">
                        <div className="relative shrink-0 mb-[4px] ml-1">
                            <select
                                value={settings.activePresetId}
                                onChange={(e) => useAppStore.getState().setActivePreset(e.target.value)}
                                className="h-[32px] bg-surface border border-border text-text-dim hover:text-terminal hover:border-terminal/50 pl-3 pr-7 text-[10px] uppercase tracking-widest focus:outline-none focus:border-terminal max-w-[120px] sm:max-w-[150px] truncate cursor-pointer appearance-none rounded transition-colors font-bold"
                                title="Active AI Preset"
                            >
                                {settings.presets.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>
                            <svg className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-text-dim pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 9l-7 7-7-7"></path></svg>
                        </div>
                        <textarea
                            ref={inputRef}
                            value={input}
                            onChange={handleInputChange}
                            onKeyDown={handleKeyDown}
                            placeholder={editingMessageId ? "Edit message..." : "What do you do?"}
                            className="flex-1 bg-transparent px-2 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[40px] leading-5"
                        />
                        <button
                            onClick={isStreaming ? handleStop : (editingMessageId ? handleEditSubmit : () => handleSend())}
                            disabled={!isStreaming && !input.trim()}
                            className={`h-[32px] w-[44px] mb-[4px] rounded transition-all disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center shrink-0 ${isStreaming ? 'text-amber-500 hover:bg-amber-500/10' : 'text-terminal hover:bg-terminal/10'}`}
                        >
                            {isStreaming ? <Square size={16} fill="currentColor" /> : (editingMessageId ? <Check size={16} /> : <Send size={16} />)}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
