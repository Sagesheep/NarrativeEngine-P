import { useState, useRef, useEffect } from 'react';
import { Send, Dices, Save, Loader2, Zap } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import { useAppStore } from '../store/useAppStore';
import { buildPayload, sendMessage } from '../services/chatEngine';
import { shouldCondense, condenseHistory } from '../services/condenser';

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
        addMessage,
        updateLastAssistant,
        setStreaming,
        setCondensed,
        setCondensing,
    } = useAppStore();

    const [input, setInput] = useState('');
    const bottomRef = useRef<HTMLDivElement>(null);
    const inputRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
    }, [messages]);

    const triggerCondense = async () => {
        if (condenser.isCondensing) return;
        setCondensing(true);
        try {
            const result = await condenseHistory(
                settings,
                messages,
                context,
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

        const userMsg = { id: uid(), role: 'user' as const, content: text, timestamp: Date.now() };
        addMessage(userMsg);
        setInput('');

        const payload = buildPayload(settings, context, messages, text, condenser.condensedSummary || undefined);

        const assistantMsg = { id: uid(), role: 'assistant' as const, content: '', timestamp: Date.now() };
        addMessage(assistantMsg);
        setStreaming(true);

        await sendMessage(
            settings,
            payload,
            (fullText) => updateLastAssistant(fullText),
            () => {
                setStreaming(false);
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

    const saveState = () => {
        const parts: string[] = [];
        if (context.saveFormat1Active && context.saveFormat1) parts.push(context.saveFormat1);
        if (context.saveFormat2Active && context.saveFormat2) parts.push(context.saveFormat2);
        if (context.saveInstructionActive && context.saveInstruction) parts.push(context.saveInstruction);
        if (context.saveStateMacroActive && context.saveStateMacro) parts.push(context.saveStateMacro);

        const macro = parts.length > 0
            ? parts.join('\n\n')
            : '[SYSTEM: Please summarize the current inventory, HP, and quest status into a JSON block for saving.]';
        insertMacro(macro);
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

                            <div className="prose prose-invert prose-sm max-w-none [&_pre]:bg-void [&_pre]:border [&_pre]:border-border [&_pre]:p-3 [&_code]:text-terminal [&_code]:text-xs">
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
                    onClick={saveState}
                    className="flex items-center gap-1.5 bg-void border border-ice/30 hover:border-ice text-ice text-[11px] uppercase tracking-wider px-3 py-1.5 transition-all hover:bg-ice/5"
                >
                    <Save size={13} />
                    Save State
                </button>
                <button
                    onClick={triggerCondense}
                    disabled={condenser.isCondensing || messages.length < 6}
                    className="flex items-center gap-1.5 bg-void border border-terminal/30 hover:border-terminal text-terminal text-[11px] uppercase tracking-wider px-3 py-1.5 transition-all hover:bg-terminal/5 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                    {condenser.isCondensing ? <Loader2 size={13} className="animate-spin" /> : <Zap size={13} />}
                    {condenser.isCondensing ? 'Condensing...' : 'Condense'}
                </button>
                {condenser.condensedSummary && (
                    <span className="text-[9px] text-terminal/60 self-center ml-1">
                        ● condensed
                    </span>
                )}
            </div>

            {/* Input */}
            <div className="px-4 pb-4 pt-1">
                <div className="flex gap-2 border border-border bg-void focus-within:border-terminal transition-colors">
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
