import ReactMarkdown from 'react-markdown';
import { Edit2, RotateCcw, Trash2, Loader2 } from 'lucide-react';
import type { ChatMessage, DebugSection } from '../types';
import { DebugPayloadView } from './DebugPayloadView';

interface MessageBubbleProps {
    message: ChatMessage;
    isStreaming: boolean;
    isLastMessage: boolean;
    showReasoning: boolean;
    debugMode: boolean;
    onStartEdit: (message: ChatMessage) => void;
    onRegenerate: (id: string) => void;
    onDelete: (id: string) => void;
}

export function MessageBubble({
    message: msg,
    isStreaming,
    isLastMessage,
    showReasoning,
    debugMode,
    onStartEdit,
    onRegenerate,
    onDelete,
}: MessageBubbleProps) {
    let markdownContent: string = typeof msg.displayContent === 'string'
        ? msg.displayContent
        : (typeof msg.content === 'string' ? msg.content : '');

    let thinkingBlock = '';
    const thinkMatch = markdownContent.match(/<think([\s\S]*?)<\/think>/i);
    if (thinkMatch) {
        thinkingBlock = thinkMatch[1].trim();
        if (showReasoning === false) {
            markdownContent = markdownContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        } else {
            markdownContent = markdownContent.replace(/<think[\s\S]*?<\/think>/gi, '').trim();
        }
    }

    const parsedArgs = (msg as any).parsedArgs;
    const hasSummary = msg.role === 'tool' && parsedArgs && Array.isArray(parsedArgs.summary);
    const hasDebug = debugMode === true && !!msg.debugPayload;

    return (
        <div
            key={msg.id}
            className={`group flex animate-[msg-in_0.2s_ease-out] ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
        >
            <div
                className={`max-w-[95%] md:max-w-[75%] px-3 md:px-4 py-2 md:py-3 text-sm font-mono leading-relaxed relative ${msg.role === 'user'
                    ? 'bg-terminal/8 border-l-2 border-terminal text-text-primary'
                    : msg.role === 'system'
                        ? 'bg-ember/8 border-l-2 border-ember text-ember/80'
                        : 'bg-void-lighter border-l-2 border-border text-text-primary'
                    }`}
            >
                <div className={`absolute -top-3 ${msg.role === 'user' ? 'left-2' : 'right-2'} flex gap-1 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity bg-void-darker border border-border p-[2px] rounded z-10`}>
                    {msg.role !== 'system' && (
                        <button title="Edit" onClick={() => onStartEdit(msg)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                            <Edit2 size={10} />
                        </button>
                    )}
                    {msg.role === 'assistant' && (
                        <button title="Regenerate" onClick={() => onRegenerate(msg.id)} className="text-text-dim hover:text-terminal p-1 bg-void-lighter rounded">
                            <RotateCcw size={10} />
                        </button>
                    )}
                    <button title="Delete" onClick={() => onDelete(msg.id)} className="text-text-dim hover:text-red-400 p-1 bg-void-lighter rounded">
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
                    {thinkingBlock && showReasoning && (
                        <details className="mb-3 bg-void-darker border border-terminal/20 rounded overflow-hidden">
                            <summary className="cursor-pointer p-2 text-[10px] text-terminal/60 hover:text-terminal transition-colors select-none uppercase tracking-widest flex items-center gap-2 bg-terminal/5">
                                <Loader2 size={10} className={isStreaming && isLastMessage ? "animate-spin" : ""} />
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
                    <DebugPayloadView debugPayload={msg.debugPayload as { sections?: DebugSection[]; raw?: unknown }} />
                )}
            </div>
        </div>
    );
}
