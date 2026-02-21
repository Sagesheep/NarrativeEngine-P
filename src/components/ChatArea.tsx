import { useState, useRef, useEffect } from 'react';
import { Send, Dices, Loader2, Zap, ChevronDown, Scroll } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../store/useAppStore';
import { buildPayload, sendMessage } from '../services/chatEngine';
import { shouldCondense, condenseHistory } from '../services/condenser';
import { runSaveFilePipeline } from '../services/saveFileEngine';
import { retrieveRelevantLore } from '../services/loreRetriever';

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

        const userMsg = { id: uid(), role: 'user' as const, content: text, timestamp: Date.now() };
        addMessage(userMsg);
        setInput('');

        const relevantLore = loreChunks.length > 0
            ? retrieveRelevantLore(loreChunks, context.canonState, context.headerIndex)
            : undefined;

        let newDC = context.surpriseDC ?? 95;
        const roll = Math.floor(Math.random() * 100) + 1;
        let finalInput = text;

        if (roll >= newDC) {
            const slot1 = ["ENVIRONMENTAL_HAZARD", "NPC_ACTION", "WEATHER_CHANGE", "ITEM_COMPLICATION", "SUDDEN_DANGER", "FACTION_INTERVENTION", "STRANGE_DISCOVERY", "MAGIC_ANOMALY", "BEAST_BEHAVIOR", "STRUCTURAL_COLLAPSE", "SUDDEN_ARRIVAL", "LOST_ITEM", "MISUNDERSTANDING", "REVELATION", "TRAP_TRIGGERED", "OPPORTUNITY"];
            const slot2 = ["GOOD", "BAD", "NEUTRAL", "WEIRD", "HILARIOUS", "TERRIFYING", "AWKWARD", "MYSTERIOUS", "CHAOTIC", "GROTESQUE", "WHOLESOME", "EPIC", "MUNDANE"];
            const type = slot1[Math.floor(Math.random() * slot1.length)];
            const tone = slot2[Math.floor(Math.random() * slot2.length)];

            finalInput += `\n\n[SYSTEM OVERRIDE: SURPRISE EVENT TRIGGERED! Constraints: Event Type = [${type}], Tone = [${tone}]. You MUST inject an unexpected event matching these exact constraints into your immediate narrative response, based strictly on the CURRENT location and situation.]`;
            newDC = 95;
            console.log(`[Surprise Engine] Triggered! Type: ${type}, Tone: ${tone}`);
        } else {
            console.log(`[Surprise Engine] Roll: ${roll} < DC: ${newDC}. Decreasing DC.`);
            newDC = Math.max(5, newDC - 5);
        }
        updateContext({ surpriseDC: newDC });

        const payload = buildPayload(settings, context, messages, finalInput, condenser.condensedSummary || undefined, relevantLore);

        const assistantMsg = { id: uid(), role: 'assistant' as const, content: '', timestamp: Date.now() };
        addMessage(assistantMsg);
        setStreaming(true);

        await sendMessage(
            provider,
            payload,
            (fullText) => updateLastAssistant(fullText),
            () => {
                setStreaming(false);
                // Archive the exchange (non-blocking)
                const allMsgs = useAppStore.getState().messages;
                const lastAssistant = allMsgs[allMsgs.length - 1];
                if (lastAssistant?.role === 'assistant' && lastAssistant.content) {
                    appendToArchive(text, lastAssistant.content);
                }
                // Auto-condense check (non-blocking)
                const allMessages = useAppStore.getState().messages;
                if (settings.autoCondenseEnabled && shouldCondense(allMessages, settings.contextLimit, condenser.condensedUpToIndex)) {
                    triggerCondense();
                }
            },
            (err) => {
                updateLastAssistant(`⚠ Error: ${err}`);
                setStreaming(false);
            }
        );
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

                {messages.map((msg) => (
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
                                    {msg.role === 'user' ? '► YOU' : msg.role === 'system' ? '◆ SYS' : '◇ GM'}
                                </span>
                                <span className="text-[9px] text-text-dim">
                                    {new Date(msg.timestamp).toLocaleTimeString()}
                                </span>
                            </div>

                            <div className="gm-prose">
                                <ReactMarkdown>{msg.content}</ReactMarkdown>
                            </div>
                        </div>
                    </div>
                ))}

                {isStreaming && (
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
