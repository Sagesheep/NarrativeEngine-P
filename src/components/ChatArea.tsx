import { useState, useRef, useEffect } from 'react';
import { Send, Dices, Loader2, Zap, ChevronDown, Scroll } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../store/useAppStore';
import { buildPayload, sendMessage, generateNPCProfile, updateExistingNPCs } from '../services/chatEngine';
import type { NPCEntry } from '../types';
import { shouldCondense, condenseHistory } from '../services/condenser';
import { runSaveFilePipeline } from '../services/saveFileEngine';
import { retrieveRelevantLore, searchLoreByQuery } from '../services/loreRetriever';

function uid(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

export function ChatArea() {
    const {
        messages,
        settings,
        context,
        isStreaming,
        condenser,
        loreChunks,
        npcLedger,
        addMessage,
        updateLastAssistant,
        setStreaming,
        updateContext,
        setCondensed,
        setCondensing,
        getActiveProvider,
        setActiveProvider,
        activeCampaignId,
    } = useAppStore();

    const [input, setInput] = useState('');
    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [isCheckingNotes, setIsCheckingNotes] = useState(false);
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);
    const dropdownRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

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
            const result = await condenseHistory(
                provider,
                messages,
                freshCtx,
                condenser.condensedUpToIndex,
                condenser.condensedSummary
            );
            setCondensed(result.summary, result.upToIndex);
        } catch (err) {
            console.error('[Condenser]', err);
        } finally {
            setCondensing(false);
        }
    };

    const handleSend = async () => {
        const text = input.trim();
        if (!text || isStreaming) return;

        const provider = useAppStore.getState().getActiveProvider();

        setInput('');

        const relevantLore = loreChunks.length > 0
            ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex, text)
            : undefined;

        let newDC = context.surpriseDC ?? 98;
        const roll = Math.floor(Math.random() * 100) + 1;
        let finalInput = text;

        if (roll >= newDC) {
            const slot1 = ["ENVIRONMENTAL_HAZARD", "NPC_ACTION", "WEATHER_CHANGE", "ITEM_COMPLICATION", "SUDDEN_DANGER", "FACTION_INTERVENTION", "STRANGE_DISCOVERY", "MAGIC_ANOMALY", "BEAST_BEHAVIOR", "STRUCTURAL_COLLAPSE", "SUDDEN_ARRIVAL", "LOST_ITEM", "MISUNDERSTANDING", "REVELATION", "TRAP_TRIGGERED", "OPPORTUNITY"];
            const slot2 = ["GOOD", "BAD", "NEUTRAL", "WEIRD", "HILARIOUS", "TERRIFYING", "AWKWARD", "MYSTERIOUS", "CHAOTIC", "GROTESQUE", "WHOLESOME", "EPIC", "MUNDANE"];
            const type = slot1[Math.floor(Math.random() * slot1.length)];
            const tone = slot2[Math.floor(Math.random() * slot2.length)];

            finalInput += `\n\n[SYSTEM OVERRIDE: SURPRISE EVENT TRIGGERED! Constraints: Event Type = [${type}], Tone = [${tone}]. You MUST inject an unexpected event matching these exact constraints into your immediate narrative response, based strictly on the CURRENT location and situation.]`;
            newDC = 98;
            console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}`);
        } else {
            console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newDC}. Decreasing DC.`);
            newDC = Math.max(5, newDC - 3);
        }
        updateContext({ surpriseDC: newDC });

        // <--- DICE FAIRNESS ENGINE ---!>
        const generatePool = () => {
            const rolls = [
                Math.floor(Math.random() * 20) + 1,
                Math.floor(Math.random() * 20) + 1,
                Math.floor(Math.random() * 20) + 1
            ].sort((a, b) => a - b);
            return `[Disadvantage: ${rolls[0]} | Normal: ${rolls[1]} | Advantage: ${rolls[2]}]`;
        };

        const diceBlock = `
[SYSTEM: ACTION RESOLUTION PROTOCOL]
Identify the CORE intent of the player's action, pick the SINGLE most relevant category, and resolve the action using ONLY the pre-generated dice numbers below.

=== GENERATED DICE POOLS FOR THIS TURN ===
* COMBAT_AND_PHYSICAL: ${generatePool()}
* PERCEPTION_AND_INVESTIGATION: ${generatePool()}
* STEALTH_AND_DECEPTION: ${generatePool()}
* SOCIAL_AND_PERSUASION: ${generatePool()}
* MOVEMENT_AND_ACROBATICS: ${generatePool()}
* KNOWLEDGE_AND_SYSTEMS: ${generatePool()}
* MUNDANE_SAFE_ACTION: [Disadvantage: 20 | Normal: 20 | Advantage: 20] 

=== HOW TO CHOOSE ADVANTAGE LEVEL ===
Look at the player's contextual tags, tools, and narrative positioning.
- Use **Advantage** if they are a master, have the perfect tool, or the enemy is highly vulnerable.
- Use **Normal** for standard baseline attempts.
- Use **Disadvantage** if they are unskilled, impaired, or the task is bordering on impossible.

=== FLAT RESOLUTION SCALE (MANDATORY OUTCOMES) ===
Interpret the chosen number STRICTLY according to this scale. Do NOT invent a DC.
* 1-2 = Catastrophe (Action fails terribly, severe consequences)
* 3-6 = Failure (Action fails, player takes damage, setback, or loses an item)
* 7-11 = Mixed Success (Action succeeds, but at a steep cost, compromise, or partial injury)
* 12-17 = Clean Success (Action succeeds exactly as intended)
* 18-19 = Exceptional Success (Action succeeds rapidly with an unexpected minor benefit)
* 20 = Narrative Boon (Flawless victory, the player gains a massive strategic advantage)
[END SYSTEM INSTRUCTION]`;

        finalInput += `\n\n${diceBlock}`;
        // <----------------------!>

        const payload = buildPayload(settings, context, messages, finalInput, condenser.condensedSummary || undefined, relevantLore, npcLedger);

        const executeTurn = async (currentPayload: any[], toolCallCount = 0) => {
            if (toolCallCount === 0) {
                const userMsg = { id: uid(), role: 'user' as const, content: text, timestamp: Date.now(), debugPayload: payload };
                addMessage(userMsg);
            }

            const assistantMsgId = uid();
            addMessage({ id: assistantMsgId, role: 'assistant' as const, content: '', timestamp: Date.now() });
            setStreaming(true);

            // Limit recursion: only provide tools if we haven't looped too many times
            const tools = toolCallCount < 2 ? [{
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
                        });

                        // Execute Tool locally
                        let query = '';
                        try { query = JSON.parse(toolCall.arguments).query || ''; } catch { }

                        let toolResult = "No relevant lore found.";
                        if (query) {
                            const found = searchLoreByQuery(loreChunks, query);
                            if (found.length > 0) {
                                toolResult = found.map(c => `### ${c.header}\n${c.content}`).join('\n\n');
                            }
                        }

                        // Save tool response
                        const toolMsgId = uid();
                        addMessage({
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
                        });

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
                        appendToArchive(text, lastAssistant.content);

                        // ── NPC Auto-Generation: Parse AI response for character name tags ──
                        // Supports 3 formats:
                        //   1. [Name]        — plain brackets
                        //   2. [**Name**]    — bold brackets
                        //   3. [SYSTEM: NPC_ENTRY - NAME] — explicit system tag
                        const content = lastAssistant.content;
                        const extractedNames: string[] = [];

                        // Pattern 1 & 2: [Name] or [**Name**] — no colons allowed inside (filters out [SYSTEM: ...])
                        const bracketMatches = Array.from(content.matchAll(/\[\*{0,2}([A-Za-z][A-Za-z0-9 _'-]*[A-Za-z0-9])\*{0,2}\]/g));
                        for (const m of bracketMatches) {
                            const raw = m[1].trim();
                            // Skip if it contains a colon (system tags) or is too short
                            if (raw.includes(':') || raw.length < 2) continue;
                            // Skip multi-word ALL-CAPS tags like "END RECORD" or "ACTIVE NPC CONTEXT"
                            if (raw.includes(' ') && raw === raw.toUpperCase()) continue;
                            extractedNames.push(raw);
                        }

                        // Pattern 3: [SYSTEM: NPC_ENTRY - NAME]
                        const entryMatches = Array.from(content.matchAll(/\[SYSTEM:\s*NPC_ENTRY\s*[-–—]\s*([A-Za-z][A-Za-z0-9 _'-]*)\]/gi));
                        for (const m of entryMatches) {
                            extractedNames.push(m[1].trim());
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
                                    const allNames = [npc.name.toLowerCase(), ...aliasesRaw.split(',').map(a => a.trim().toLowerCase())];
                                    return allNames.includes(potentialName.toLowerCase());
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
                    updateLastAssistant(`⚠ Error: ${err}`);
                    setStreaming(false);
                    setIsCheckingNotes(false);
                },
                tools
            );
        };

        await executeTurn(payload);
    };

    const handleKeyDown = (e: React.KeyboardEvent) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            handleSend();
        }
    };

    const insertMacro = (text: string) => {
        setInput((prev) => prev + text);
        inputRef.current?.focus();
    };

    const rollD20 = () => {
        const result = Math.floor(Math.random() * 20) + 1;
        insertMacro(`[SYSTEM: User rolled D20: ${result}]`);
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


    return (
        <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
            {/* Transcript */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
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

                {messages.filter(msg => msg.role !== 'tool').map((msg) => (
                    <div
                        key={msg.id}
                        className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                    >
                        <div
                            className={`max-w-[75%] px-4 py-3 text-sm font-mono leading-relaxed ${msg.role === 'user'
                                ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                                : msg.role === 'system'
                                    ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                                    : 'bg-void-lighter border-l-2 border-border text-text-primary'
                                }`}
                        >
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
                                <ReactMarkdown>{msg.content}</ReactMarkdown>
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
            <div className="px-4 pb-1 flex gap-2">
                <button
                    onClick={rollD20}
                    className="flex items-center gap-1.5 bg-void border border-ember/30 hover:border-ember text-ember text-[11px] uppercase tracking-wider px-3 py-1.5 transition-all hover:bg-ember/5"
                >
                    <Dices size={13} />
                    Roll D20
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={condenser.isCondensing || messages.length < 6}
                    className="flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[11px] uppercase tracking-wider px-3 py-1.5 transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    {condenser.isCondensing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                    {condenser.isCondensing ? 'Condensing...' : 'Condense'}
                </button>
                <button
                    onClick={openArchive}
                    disabled={!activeCampaignId}
                    className="flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[11px] uppercase tracking-wider px-3 py-1.5 transition-all hover:bg-ice/5 disabled:opacity-30 disabled:cursor-not-allowed ml-auto"
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

            {/* Input */}
            <div className="px-4 pb-4 pt-1">
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
                        placeholder="Enter your command..."
                        rows={2}
                        className="flex-1 bg-transparent px-3 py-2.5 text-sm text-text-primary placeholder:text-text-dim/40 font-mono resize-none border-none outline-none"
                    />
                    <button
                        onClick={handleSend}
                        disabled={isStreaming || !input.trim()}
                        className="px-4 text-terminal hover:bg-terminal/10 transition-all disabled:opacity-30 disabled:cursor-not-allowed border-l border-border"
                    >
                        <Send size={16} />
                    </button>
                </div>
            </div>
        </div>
    );
}
