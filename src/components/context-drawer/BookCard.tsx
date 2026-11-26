import { useState, type ReactNode } from 'react';
import { ChevronDown, ChevronUp, Library, RefreshCcw, Unlink, Check, Loader2 } from '../icons/narrativeIcons';
import type { ArchiveBook } from '../../types';

/**
 * A book: a run of sealed chapters with its own summary. Collapsed it shows the
 * title, era and range; expanded it shows the summary, era editing and its
 * chapters (passed as children).
 */
export function BookCard({ book, chapterCount, children, isLast, busy, onSetEra, onRegenerate, onUnbind }: {
    book: ArchiveBook;
    chapterCount: number;
    children: ReactNode;
    /** Only the newest book can be unbound — books stay contiguous. */
    isLast: boolean;
    busy: boolean;
    onSetEra: (era: string) => void;
    onRegenerate: () => void;
    onUnbind: () => void;
}) {
    const [open, setOpen] = useState(false);
    const [showChapters, setShowChapters] = useState(false);
    // A draft only while editing; otherwise the saved era shows (and follows updates).
    const [eraDraft, setEraDraft] = useState<string | null>(null);
    const era = eraDraft ?? book.era ?? '';
    const saveEra = () => { onSetEra(era.trim()); setEraDraft(null); };

    return (
        <div className="relative border rounded-lg bg-amber-500/5 border-amber-500/30">
            {busy && (
                <div className="absolute inset-0 bg-void/60 z-10 flex items-center justify-center rounded-lg backdrop-blur-[1px]">
                    <div className="flex items-center space-x-2 text-amber-400 font-mono text-[12px] uppercase font-bold">
                        <Loader2 size={14} className="animate-spin" />
                        <span>Writing book summary...</span>
                    </div>
                </div>
            )}
            <button onClick={() => setOpen(!open)} className="w-full flex items-center gap-2 px-3 py-2 text-left">
                <Library size={16} className="text-amber-400 shrink-0" />
                <span className="flex-1 min-w-0">
                    <span className="text-sm font-bold text-text-primary">{book.title}</span>
                    {book.era && <span className="ml-2 text-[11px] font-mono text-amber-400 bg-amber-500/10 px-1.5 rounded">{book.era}</span>}
                    {book.summaryPending && <span className="ml-2 text-[11px] uppercase font-bold text-ice">summary pending</span>}
                    <span className="block text-[11px] font-mono text-text-dim">
                        {book.bookId} · {chapterCount} chapter{chapterCount === 1 ? '' : 's'} · scenes {book.sceneRange[0]}–{book.sceneRange[1]}
                    </span>
                </span>
                {open ? <ChevronUp size={14} className="text-text-dim" /> : <ChevronDown size={14} className="text-text-dim" />}
            </button>

            {open && (
                <div className="px-3 pb-3 space-y-3">
                    <p className="text-text-secondary leading-relaxed font-serif italic text-[13px] bg-void-dark/50 p-2 rounded border border-border/30 whitespace-pre-wrap">
                        {book.summary}
                    </p>
                    {book.unresolvedThreads.length > 0 && (
                        <div className="text-[12px] text-text-dim">
                            <span className="uppercase font-bold">Open at the end: </span>{book.unresolvedThreads.join(' · ')}
                        </div>
                    )}

                    <div className="flex items-center gap-2">
                        <span className="text-[11px] uppercase font-bold text-text-dim">Era</span>
                        <input
                            type="text"
                            value={era}
                            onChange={e => setEraDraft(e.target.value)}
                            onKeyDown={e => { if (e.key === 'Enter' && era.trim() !== (book.era ?? '')) saveEra(); }}
                            placeholder="e.g. P3 · 2009"
                            className="flex-1 min-w-0 bg-void border border-border text-text-primary text-xs px-2 py-1 rounded outline-none focus:border-amber-500"
                        />
                        <button
                            onClick={saveEra}
                            disabled={era.trim() === (book.era ?? '')}
                            className="p-1 rounded text-emerald-400 hover:bg-emerald-500/10 disabled:opacity-30"
                            title="Save era"
                            aria-label="Save era"
                        >
                            <Check size={14} />
                        </button>
                    </div>

                    <div className="flex items-center gap-2 flex-wrap">
                        <button
                            onClick={onRegenerate}
                            disabled={busy}
                            title="Write the book summary again from its chapter summaries (one AI call)"
                            className="flex items-center space-x-1 px-3 py-1.5 rounded bg-void-dark border border-border hover:border-terminal hover:text-terminal text-text-secondary transition-colors font-bold text-[13px] uppercase disabled:opacity-50"
                        >
                            <RefreshCcw size={12} />
                            <span>Rewrite Summary</span>
                        </button>
                        {isLast && (
                            <button
                                onClick={onUnbind}
                                disabled={busy}
                                title="Unbind this book: its chapters become loose again"
                                className="flex items-center space-x-1 px-3 py-1.5 rounded bg-void-dark border border-border hover:border-red-400 hover:text-red-400 text-text-secondary transition-colors font-bold text-[13px] uppercase disabled:opacity-50"
                            >
                                <Unlink size={12} />
                                <span>Unbind</span>
                            </button>
                        )}
                        <button
                            onClick={() => setShowChapters(!showChapters)}
                            className="ml-auto text-[12px] uppercase font-bold text-terminal hover:underline"
                        >
                            {showChapters ? 'Hide chapters' : `Show ${chapterCount} chapters`}
                        </button>
                    </div>

                    {showChapters && (
                        <div className="grid grid-cols-1 xl:grid-cols-2 gap-3 pl-3 border-l border-amber-500/20">
                            {children}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
