import { useState, useRef, useEffect } from 'react';
import { Send, Save, Loader2, Zap, ChevronDown, Scroll, Edit2, RotateCcw, Trash2, Check, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore, DEFAULT_SURPRISE_TYPES, DEFAULT_SURPRISE_TONES, DEFAULT_WORLD_WHAT, DEFAULT_WORLD_WHERE, DEFAULT_WORLD_WHO, DEFAULT_WORLD_WHY } from '../store/useAppStore';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from '../services/chatEngine';
import type { NPCEntry, ChatMessage } from '../types';
import { shouldCondense, condenseHistory } from '../services/condenser';
import { runSaveFilePipeline } from '../services/saveFileEngine';
import { retrieveRelevantLore, searchLoreByQuery } from '../services/loreRetriever';
import { retrieveArchiveMemory } from '../services/archiveMemory';

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
        archiveChunks,
        updateLastAssistant,
        updateContext,
        setCondensed,
        setCondensing,
        getActiveProvider,
        setActiveProvider,
        activeCampaignId,
        deleteMessage,
        deleteMessagesFrom,
    } = useAppStore();

    const [input, setInput] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [isStreaming, setStreaming] = useState(false); // Moved from store to local state
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const [visibleCount, setVisibleCount] = useState(20);
    const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    // Auto-scroll only when a NEW message appears, not on every streaming token update.
    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages.length]);

    // Close dropdown on outside click
    useEffect(() => {
        const handleClick = (e: MouseEvent) => {
            if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
                setDropdownOpen(false);
            }
        };
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, []);

    const activeProvider = getActiveProvider();

    const triggerCondense = async () => {
        if (condenser.isCondensing) return;
        setCondensing(true);
        try {
            const provider = useAppStore.getState().getActiveProvider();
            // Step 1 & 2: Generate Canon State + Header Index BEFORE condensing
            const currentCtx = useAppStore.getState().context;
            const saveResult = await runSaveFilePipeline(provider, messages, currentCtx);

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
        } catch (err) {
            console.error('[Condenser]', err);
        } finally {
            setCondensing(false);
        }
    };

    const handleSend = async (overrideText?: string) => {
        const textToUse = overrideText || input.trim();
        if (!textToUse || isStreaming) return;

        if (!overrideText) setInput('');

        const provider = useAppStore.getState().getActiveProvider();

        const relevantLore = loreChunks.length > 0
            ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, textToUse, 1200, messages)
            : undefined;

        const archiveRecall = archiveChunks.length > 0
            ? retrieveArchiveMemory(archiveChunks, textToUse, messages, 3000)
            : undefined;

        let newDC = context.surpriseDC ?? 98;
        let finalInput = textToUse;

        if (context.surpriseEngineActive !== false) {
            const roll = Math.floor(Math.random() * 100) + 1;
            if (roll >= newDC) {
                const typesList = context.surpriseConfig?.types || DEFAULT_SURPRISE_TYPES;
                const tonesList = context.surpriseConfig?.tones || DEFAULT_SURPRISE_TONES;
                const type = typesList[Math.floor(Math.random() * typesList.length)];
                const tone = tonesList[Math.floor(Math.random() * tonesList.length)];

                finalInput += `\n[SURPRISE EVENT: ${type} (${tone})]`;
                newDC = context.surpriseConfig?.initialDC || 98;
                console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}. Resetting DC to ${newDC}`);
            } else {
                console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newDC}. Decreasing DC.`);
                newDC = Math.max(5, newDC - (context.surpriseConfig?.dcReduction || 3));
            }
        }

        // <--- WORLD ENGINE ---!>
        const checkWorldEvent = (currentDC: number, initialDC: number, reduction: number) => {
            const roll = Math.floor(Math.random() * 100) + 1;
            if (roll >= currentDC) {
                return { hit: true, roll, newDC: initialDC };
            }
            return { hit: false, roll, newDC: Math.max(5, currentDC - reduction) };
        };

        const generateWorldEventTag = () => {
            const who = DEFAULT_WORLD_WHO[Math.floor(Math.random() * DEFAULT_WORLD_WHO.length)];
            const where = DEFAULT_WORLD_WHERE[Math.floor(Math.random() * DEFAULT_WORLD_WHERE.length)];
            const why = DEFAULT_WORLD_WHY[Math.floor(Math.random() * DEFAULT_WORLD_WHY.length)];
            const what = DEFAULT_WORLD_WHAT[Math.floor(Math.random() * DEFAULT_WORLD_WHAT.length)];
            return `[WORLD_EVENT: ${who} ${what} ${why} ${where}]`;
        };

        const worldEventConfig = context.worldEventConfig || { initialDC: 198, dcReduction: 3, who: [], where: [], why: [], what: [] };
        let currentWorldEventDC = context.worldEventDC ?? worldEventConfig.initialDC;

        if (context.worldEngineActive !== false) {
            const worldEventCheck = checkWorldEvent(currentWorldEventDC, worldEventConfig.initialDC, worldEventConfig.dcReduction);
            if (worldEventCheck.hit) {
                const hasCustomTags = worldEventConfig.who && worldEventConfig.who.length >= 3 &&
                    worldEventConfig.where && worldEventConfig.where.length >= 3 &&
                    worldEventConfig.why && worldEventConfig.why.length >= 3 &&
                    worldEventConfig.what && worldEventConfig.what.length >= 3;

                const tag = hasCustomTags
                    ? `[WORLD_EVENT: ${worldEventConfig.who![Math.floor(Math.random() * worldEventConfig.who!.length)]} ${worldEventConfig.what![Math.floor(Math.random() * worldEventConfig.what!.length)]} ${worldEventConfig.why![Math.floor(Math.random() * worldEventConfig.why!.length)]} ${worldEventConfig.where![Math.floor(Math.random() * worldEventConfig.where!.length)]}]`
                    : generateWorldEventTag();

                finalInput += `\n${tag}`;
                console.log(`[World Engine] Roll: ${worldEventCheck.roll} >= DC: ${currentWorldEventDC}. Triggered! Tag: ${tag}`);
            } else {
                console.log(`[World Engine] Roll: ${worldEventCheck.roll} < DC: ${currentWorldEventDC}. Missed. New DC: ${worldEventCheck.newDC}`);
            }
            currentWorldEventDC = worldEventCheck.newDC;
        }

        updateContext({ surpriseDC: newDC, worldEventDC: currentWorldEventDC });

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
            archiveRecall
        );

        const executeTurn = async (currentPayload: unknown[], toolCallCount = 0, apiRetryCount = 0) => {
            if (toolCallCount === 0) {
                const userMsg = { id: uid(), role: 'user' as const, content: finalInput, displayContent: textToUse, timestamp: Date.now(), debugPayload: payload };
                useAppStore.getState().addMessage(userMsg);
            }

            const assistantMsgId = uid();
            useAppStore.getState().addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
            setStreaming(true);

            // Limit recursion: only provide tools if we haven't looped too many times
            const tools = toolCallCount < 2 ? [{
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

            await sendMessage(
                provider,
                currentPayload,
                (fullText) => updateLastAssistant(fullText),
                async (toolCall) => {
                    if (toolCall && toolCall.name === 'query_campaign_lore') {
                        setIsCheckingNotes(true);
                        setStreaming(false);

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
                            content: null,
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
                                    const provider = settings.providers.find(p => p.id === settings.activeProviderId);
                                    if (provider) {
                                        generateNPCProfile(provider, allMsgs, potentialName, addNPC);
                                    }
                                } else {
                                    existingNpcsToUpdate.push(existingNpc);
                                }
                            }

                            // Trigger batched background update for existing NPCs
                            if (existingNpcsToUpdate.length > 0) {
                                const provider = settings.providers.find(p => p.id === settings.activeProviderId);
                                if (provider) {
                                    updateExistingNPCs(provider, allMsgs, existingNpcsToUpdate, updateNPC);
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
                tools
            );
        };

        await executeTurn(payload);
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
                localStorage.setItem(`nn_settings`, JSON.stringify({ settings: state.settings, activeCampaignId: state.activeCampaignId }));
                localStorage.setItem(`nn_campaign_${state.activeCampaignId}_state`, JSON.stringify({ context: state.context, messages: state.messages, condenser: state.condenser }));
                localStorage.setItem(`nn_campaign_${state.activeCampaignId}_npcs`, JSON.stringify(state.npcLedger));
            } catch (e) {
                console.error("[Save] Failed to force save to localStorage:", e);
            }
        }
        setTimeout(() => setIsSaving(false), 2000);
    };

    // ─── Archive helpers ───
    const appendToArchive = async (userText: string, assistantText: string) => {
        const campaignId = useAppStore.getState().activeCampaignId;
        if (!campaignId) return;
        try {
            await fetch(`/api/campaigns/${campaignId}/archive`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ userContent: userText, assistantContent: assistantText }),
            });
        } catch (err) {
            console.warn('[Archive] Failed to append:', err);
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
            useAppStore.getState().deleteMessagesFrom(msg.id);
            const textToResend = input.trim();
            setInput('');
            setEditingMessageId(null);
            setTimeout(() => {
                handleSend(textToResend);
            }, 50);
        } else {
            useAppStore.getState().updateMessageContent(msg.id, input.trim());
            setInput('');
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
            deleteMessagesFrom(lastUser.id);
            // Wait 50ms for the state deletion to propagate to Zustand store before passing it into handleSend's buildPayload
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

                {messages.slice(-visibleCount).filter(msg => msg.role !== 'tool').map((msg) => (
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
                            {/* Action Bar (opacity-0 group-hover:opacity-100) */}
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
                                <ReactMarkdown>{msg.displayContent || msg.content}</ReactMarkdown>
                            </div>

                            {settings.debugMode && msg.debugPayload && (
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
                ))}

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
                {condenser.condensedSummary && (
                    <span className="text-[9px] text-terminal/60 self-center ml-1">
                        ● condensed
                    </span>
                )}
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
                    <div className="flex gap-0 border border-border bg-void focus-within:border-terminal transition-colors">
                        {/* Provider Dropdown */}
                        <div ref={dropdownRef} className="relative flex-shrink-0">
                            <button
                                onClick={() => setDropdownOpen(!dropdownOpen)}
                                className="flex items-center gap-1 px-3 h-full text-[11px] text-ice uppercase tracking-wider border-r border-border hover:bg-ice/5 transition-colors whitespace-nowrap"
                            >
                                {activeProvider.label}
                                <ChevronDown size={12} className={`transition-transform ${dropdownOpen ? 'rotate-180' : ''}`} />
                            </button>

                            {dropdownOpen && settings.providers.length > 1 && (
                                <div className="absolute bottom-full left-0 mb-1 bg-surface border border-border min-w-[160px] z-50 shadow-lg">
                                    {settings.providers.map((p) => (
                                        <button
                                            key={p.id}
                                            onClick={() => {
                                                setActiveProvider(p.id);
                                                setDropdownOpen(false);
                                            }}
                                            className={`w-full text-left px-3 py-2 text-[11px] uppercase tracking-wider transition-colors ${p.id === activeProvider.id
                                                ? 'text-ice bg-ice/10'
                                                : 'text-text-dim hover:text-text-primary hover:bg-void'
                                                }`}
                                        >
                                            <span className="font-mono">{p.label}</span>
                                            <span className="block text-[9px] text-text-dim/50 normal-case tracking-normal">
                                                {p.modelName}
                                            </span>
                                        </button>
                                    ))}
                                </div>
                            )}
                        </div>

                        <textarea
                            ref={inputRef}
                            value={input}
                            onChange={(e) => setInput(e.target.value)}
                            onKeyDown={handleKeyDown}
                            placeholder={editingMessageId ? "Edit message..." : "What do you do?"}
                            className="flex-1 bg-transparent px-3 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none min-h-[44px]"
                        />
                        <button
                            onClick={editingMessageId ? handleEditSubmit : () => handleSend()}
                            disabled={isStreaming || !input.trim()}
                            className="px-4 text-terminal hover:bg-terminal/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed border-l border-border flex items-center justify-center gap-2"
                        >
                            {editingMessageId ? <Check size={16} /> : <Send size={16} />}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}
