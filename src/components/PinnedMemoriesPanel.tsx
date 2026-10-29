import { useState } from 'react';
import { X, Pin, Trash2, ArrowRight, ChevronDown, ChevronUp } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { countTokens } from '../services/infrastructure/tokenizer';
import type { PinnedExcerpt } from '../types';

const PIN_TOKEN_CAP = 3000;

type Props = {
    open: boolean;
    onClose: () => void;
};

function relativeTime(ts: number): string {
    const diff = Date.now() - ts;
    const secs = Math.floor(diff / 1000);
    if (secs < 60) return 'just now';
    const mins = Math.floor(secs / 60);
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
}

function scrollToMessage(messageId: string) {
    const el = document.querySelector(`[data-message-id="${messageId}"]`);
    if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
}

function ExcerptRow({ excerpt, onUnpin, onJump }: {
    excerpt: PinnedExcerpt;
    onUnpin: () => void;
    onJump: () => void;
}) {
    const [expanded, setExpanded] = useState(false);
    const isLong = excerpt.text.length > 160;
    const displayText = (!expanded && isLong) ? excerpt.text.slice(0, 160) + '…' : excerpt.text;

    return (
        <div className="bg-void border border-border rounded p-3 space-y-2">
            <div className="flex items-center gap-2">
                <Pin size={10} className="text-terminal shrink-0" />
                <span className="text-[9px] uppercase tracking-widest text-terminal/70 font-bold">
                    {excerpt.isFullMessage ? 'Full message' : 'Excerpt'}
                </span>
                <span className="text-[9px] text-text-dim ml-auto shrink-0">
                    {relativeTime(excerpt.createdAt)}
                </span>
            </div>

            <p className="text-[11px] text-text-primary font-mono leading-relaxed whitespace-pre-wrap break-words">
                {displayText}
            </p>

            {isLong && (
                <button
                    onClick={() => setExpanded(p => !p)}
                    className="flex items-center gap-1 text-[9px] text-text-dim hover:text-terminal transition-colors uppercase tracking-wider"
                >
                    {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
                    {expanded ? 'Collapse' : 'Expand'}
                </button>
            )}

            <div className="flex items-center gap-2 pt-1 border-t border-border/40">
                <button
                    onClick={onJump}
                    className="flex items-center gap-1 text-[9px] text-text-dim hover:text-terminal transition-colors uppercase tracking-wider"
                    title="Jump to source message"
                >
                    <ArrowRight size={10} />
                    Jump to source
                </button>
                <button
                    onClick={onUnpin}
                    className="flex items-center gap-1 text-[9px] text-text-dim hover:text-red-400 transition-colors uppercase tracking-wider ml-auto"
                    title="Remove this pin"
                >
                    <Trash2 size={10} />
                    Unpin
                </button>
            </div>
        </div>
    );
}

export function PinnedMemoriesPanel({ open, onClose }: Props) {
    const pinnedExcerpts = useAppStore(s => s.pinnedExcerpts);
    const removePinnedExcerpt = useAppStore(s => s.removePinnedExcerpt);
    const clearPinnedExcerpts = useAppStore(s => s.clearPinnedExcerpts);

    const [confirmClear, setConfirmClear] = useState(false);

    const totalTokens = pinnedExcerpts.reduce((sum, e) => sum + countTokens(e.text), 0);

    const handleClose = () => {
        setConfirmClear(false);
        onClose();
    };

    const handleClearAll = () => {
        if (confirmClear) {
            clearPinnedExcerpts();
            setConfirmClear(false);
        } else {
            setConfirmClear(true);
        }
    };

    if (!open) return null;

    return (
        <div data-motion="overlay" className="fixed inset-0 z-[100] flex items-center justify-center">
            <div
                className="absolute inset-0 bg-ember/40 backdrop-blur-sm"
                onClick={handleClose}
            />

            <div className="relative bg-surface border border-border w-full h-[80vh] max-w-lg mx-4 shadow-2xl flex flex-col overflow-hidden rounded-lg">
                <div className="flex items-center justify-between p-6 border-b border-border shrink-0 bg-void">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase flex items-center gap-2">
                        <Pin size={14} />
                        Pinned Memories
                    </h2>
                    <button onClick={handleClose} className="text-text-dim hover:text-danger transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="px-4 py-3 border-b border-border bg-void shrink-0">
                    <div className="flex items-center justify-between mb-1.5">
                        <span className="text-[10px] uppercase tracking-widest text-text-dim font-bold">Token usage</span>
                        <span className={`text-[11px] font-mono font-bold ${totalTokens >= PIN_TOKEN_CAP * 0.9 ? 'text-red-400' : totalTokens >= PIN_TOKEN_CAP * 0.7 ? 'text-amber-400' : 'text-terminal'}`}>
                            {totalTokens.toLocaleString()} / {PIN_TOKEN_CAP.toLocaleString()}
                        </span>
                    </div>
                    <div className="w-full bg-border rounded-full h-1.5 overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all ${
                                totalTokens >= PIN_TOKEN_CAP * 0.9 ? 'bg-red-500' :
                                totalTokens >= PIN_TOKEN_CAP * 0.7 ? 'bg-amber-400' : 'bg-terminal'
                            }`}
                            style={{ width: `${Math.min(100, (totalTokens / PIN_TOKEN_CAP) * 100)}%` }}
                        />
                    </div>
                </div>

                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                    {pinnedExcerpts.length === 0 ? (
                        <div className="flex flex-col items-center justify-center h-full gap-3 text-center">
                            <Pin size={32} className="text-text-dim/30" />
                            <p className="text-text-dim text-xs uppercase tracking-widest">
                                No pinned memories yet
                            </p>
                            <p className="text-text-dim/60 text-[10px] max-w-[260px] leading-relaxed">
                                Select text in a message and tap the pin button in the header.
                            </p>
                        </div>
                    ) : (
                        pinnedExcerpts.map(excerpt => (
                            <ExcerptRow
                                key={excerpt.id}
                                excerpt={excerpt}
                                onUnpin={() => removePinnedExcerpt(excerpt.id)}
                                onJump={() => {
                                    handleClose();
                                    setTimeout(() => scrollToMessage(excerpt.sourceMessageId), 150);
                                }}
                            />
                        ))
                    )}
                </div>

                {pinnedExcerpts.length > 0 && (
                    <div className="px-4 py-3 border-t border-border bg-void shrink-0 flex items-center gap-3">
                        {confirmClear ? (
                            <>
                                <span className="text-[10px] text-red-400 uppercase tracking-wider flex-1">
                                    Clear all {pinnedExcerpts.length} pins?
                                </span>
                                <button
                                    onClick={() => setConfirmClear(false)}
                                    className="px-3 py-1.5 text-[10px] border border-border rounded text-text-dim hover:text-text-primary uppercase tracking-wider transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleClearAll}
                                    className="px-3 py-1.5 text-[10px] bg-red-500/20 border border-red-500/50 rounded text-red-400 hover:bg-red-500/30 uppercase tracking-wider transition-colors font-bold"
                                >
                                    Confirm
                                </button>
                            </>
                        ) : (
                            <button
                                onClick={handleClearAll}
                                className="flex items-center gap-1.5 text-[10px] text-text-dim hover:text-red-400 uppercase tracking-wider transition-colors"
                            >
                                <Trash2 size={12} />
                                Clear all ({pinnedExcerpts.length})
                            </button>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}