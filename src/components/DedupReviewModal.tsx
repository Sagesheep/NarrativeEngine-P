import { useEffect } from 'react';
import { X, Loader2, StopCircle } from 'lucide-react';
import type { DedupGroup } from '../services/campaign-state/factDeduper';
import type { DivergenceEntry } from '../types';

type DedupReviewModalProps = {
    open: boolean;
    running: boolean;
    progress: { msg: string; done: number; total: number } | null;
    groups: DedupGroup[] | null;
    failedBuckets: string[];
    selections: Record<string, Set<string>>;
    error: string | null;
    entries: DivergenceEntry[];
    onCancel: () => void;
    onStop: () => void;
    onToggleDisable: (keepId: string, disableId: string) => void;
    onSkipGroup: (keepId: string) => void;
    onApply: () => void;
};

export function DedupReviewModal({
    open,
    running,
    progress,
    groups,
    failedBuckets,
    selections,
    error,
    entries,
    onCancel,
    onStop,
    onToggleDisable,
    onSkipGroup,
    onApply,
}: DedupReviewModalProps) {
    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === 'Escape' && open) {
                if (running) onStop();
                else onCancel();
            }
        };
        document.addEventListener('keydown', handleKeyDown);
        return () => document.removeEventListener('keydown', handleKeyDown);
    }, [open, running, onCancel, onStop]);

    if (!open) return null;

    const entryMap = new Map<string, DivergenceEntry>();
    for (const e of entries) entryMap.set(e.id, e);

    let totalToDisable = 0;
    if (groups) {
        for (const g of groups) {
            const sel = selections[g.keepId];
            if (sel) totalToDisable += sel.size;
        }
    }

    const groupCount = groups ? groups.length : 0;

    return (
        <div data-motion="overlay" className="fixed inset-0 z-50 flex items-center justify-center bg-black/60" onClick={onCancel}>
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[85vh] flex flex-col mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <div className="flex flex-col">
                        <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">Review Duplicates</h2>
                        {groups && groupCount > 0 && (
                            <span className="text-[10px] text-text-dim mt-0.5">
                                Will disable {totalToDisable} fact{totalToDisable !== 1 ? 's' : ''} across {groupCount} group{groupCount !== 1 ? 's' : ''}
                            </span>
                        )}
                        {failedBuckets.length > 0 && (
                            <span className="text-[10px] text-amber-400 mt-0.5">
                                ⚠ {failedBuckets.length} bucket{failedBuckets.length !== 1 ? 's' : ''} returned unreadable responses: {failedBuckets.slice(0, 5).join(', ')}
                            </span>
                        )}
                    </div>
                    <button onClick={onCancel} className="touch-btn text-text-dim hover:text-text-primary transition-colors">
                        <X size={20} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-3">
                    {running && progress && (
                        <div className="flex flex-col items-center justify-center py-8 space-y-3">
                            <Loader2 size={24} className="animate-spin text-terminal" />
                            <div className="text-sm text-text-primary">{progress.msg}</div>
                            <div className="w-full bg-void border border-border rounded-full h-2">
                                <div
                                    className="bg-terminal h-2 rounded-full transition-all duration-300"
                                    style={{ width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%` }}
                                />
                            </div>
                            <button
                                onClick={onStop}
                                className="flex items-center gap-1.5 px-4 py-2 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors text-xs font-semibold"
                            >
                                <StopCircle size={14} />
                                Stop
                            </button>
                        </div>
                    )}

                    {!running && error && (
                        <div className="bg-red-900/20 border border-red-500/40 rounded p-3 text-xs text-red-400">
                            {error}
                        </div>
                    )}

                    {!running && groups && groups.length === 0 && !error && (
                        <div className="flex flex-col items-center justify-center py-8 text-text-dim">
                            <p className="text-sm">No duplicates found.</p>
                        </div>
                    )}

                    {!running && groups && groups.length > 0 && (
                        <div className="space-y-4">
                            {groups.map(g => {
                                const sel = selections[g.keepId];
                                if (!sel) return null;

                                const keepEntry = entryMap.get(g.keepId);

                                return (
                                    <div key={g.keepId} className="border border-border/40 rounded p-2 space-y-1.5">
                                        <div className="flex items-center justify-between">
                                            <div className="flex items-center gap-2">
                                                <span className="text-[10px] px-1.5 py-0.5 rounded bg-terminal/10 text-terminal font-mono font-bold">
                                                    {g.bucketLabel}
                                                </span>
                                                {g.reason && (
                                                    <span className="text-[10px] text-text-dim italic">{g.reason}</span>
                                                )}
                                            </div>
                                            <button
                                                onClick={() => onSkipGroup(g.keepId)}
                                                className="text-[10px] text-text-dim hover:text-amber-400 transition-colors"
                                            >
                                                Skip this group
                                            </button>
                                        </div>

                                        {keepEntry && (
                                            <div className="border-l-2 border-emerald-400 pl-2 py-1">
                                                <div className="text-[9px] text-emerald-400 font-bold uppercase tracking-wider">Keep</div>
                                                <div className="text-[11px] text-text-primary">
                                                    {keepEntry.text}
                                                    <span className="text-text-dim/40 text-[9px]"> [#{keepEntry.sceneRef}]</span>
                                                </div>
                                            </div>
                                        )}

                                        {g.disableIds.map(dId => {
                                            const disEntry = entryMap.get(dId);
                                            const checked = sel.has(dId);
                                            return (
                                                <div
                                                    key={dId}
                                                    className="flex items-start gap-1.5 pl-2"
                                                >
                                                    <input
                                                        type="checkbox"
                                                        checked={checked}
                                                        onChange={() => onToggleDisable(g.keepId, dId)}
                                                        className="w-2.5 h-2.5 mt-0.5 accent-red-400 shrink-0"
                                                    />
                                                    <span className={`text-[11px] ${checked ? 'text-text-dim/50 line-through' : 'text-text-secondary'}`}>
                                                        {disEntry ? (
                                                            <>
                                                                {disEntry.text}
                                                                <span className="text-text-dim/40 text-[9px]"> [#{disEntry.sceneRef}]</span>
                                                            </>
                                                        ) : dId}
                                                    </span>
                                                </div>
                                            );
                                        })}
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {!running && groups && groups.length > 0 && (
                    <div className="px-4 py-3 border-t border-border flex justify-end gap-2">
                        <button
                            onClick={onCancel}
                            className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary transition-colors rounded"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={onApply}
                            className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 transition-colors"
                        >
                            Disable {totalToDisable} fact{totalToDisable !== 1 ? 's' : ''}
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
