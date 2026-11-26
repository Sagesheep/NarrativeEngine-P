import { useEffect } from 'react';
import { X, Loader2, StopCircle } from 'lucide-react';
import type { NPCReviewCandidate } from '../services/npc/npcReview';

export type NPCReviewAction = 'keep' | 'archive' | 'delete';

type NPCReviewModalProps = {
    open: boolean;
    running: boolean;
    progress: { msg: string; done: number; total: number } | null;
    candidates: NPCReviewCandidate[] | null;
    failedBatches: number;
    actions: Record<string, NPCReviewAction>;
    error: string | null;
    onCancel: () => void;
    onStop: () => void;
    onSetAction: (id: string, action: NPCReviewAction) => void;
    onApply: () => void;
};

const ACTION_OPTS: { key: NPCReviewAction; label: string; active: string }[] = [
    { key: 'keep', label: 'Keep', active: 'bg-terminal text-void' },
    { key: 'archive', label: 'Archive', active: 'bg-amber-500 text-void' },
    { key: 'delete', label: 'Delete', active: 'bg-red-500 text-void' },
];

export function NPCReviewModal({
    open,
    running,
    progress,
    candidates,
    failedBatches,
    actions,
    error,
    onCancel,
    onStop,
    onSetAction,
    onApply,
}: NPCReviewModalProps) {
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

    const archiveCount = candidates ? candidates.filter(c => actions[c.id] === 'archive').length : 0;
    const deleteCount = candidates ? candidates.filter(c => actions[c.id] === 'delete').length : 0;
    const total = archiveCount + deleteCount;

    return (
        <div data-motion="overlay" className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60" onClick={onCancel}>
            <div
                className="bg-surface border border-border rounded-lg w-full max-w-lg max-h-[85vh] flex flex-col mx-4 font-sans text-text-primary"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-4 border-b border-border">
                    <div className="flex flex-col">
                        <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">Review NPCs</h2>
                        {candidates && candidates.length > 0 && (
                            <span className="text-[10px] text-text-dim mt-0.5">
                                {candidates.length} flagged · {archiveCount} to archive, {deleteCount} to delete
                            </span>
                        )}
                        {failedBatches > 0 && (
                            <span className="text-[10px] text-amber-400 mt-0.5">
                                ⚠ {failedBatches} batch{failedBatches !== 1 ? 'es' : ''} could not be read
                            </span>
                        )}
                    </div>
                    <button onClick={onCancel} className="touch-btn text-text-dim hover:text-text-primary transition-colors cursor-pointer">
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
                                className="flex items-center gap-1.5 px-4 py-2 bg-red-500/20 text-red-400 rounded hover:bg-red-500/30 transition-colors text-xs font-semibold cursor-pointer"
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

                    {!running && candidates && candidates.length === 0 && !error && (
                        <div className="flex flex-col items-center justify-center py-8 text-text-dim">
                            <p className="text-sm">No likely non-NPCs found.</p>
                            <p className="text-[10px] mt-1 opacity-60">Every entry looks like a real character.</p>
                        </div>
                    )}

                    {!running && candidates && candidates.length > 0 && (
                        <div className="space-y-1.5">
                            <p className="text-[10px] text-text-dim/70 px-1 pb-1">
                                The AI flagged these as probably not real NPCs. Choose what to do with each — nothing happens until you Apply. Deletes are backed up first.
                            </p>
                            {candidates.map(c => {
                                const action = actions[c.id] ?? 'archive';
                                return (
                                    <div key={c.id} className="border border-border/40 rounded p-2 flex items-center justify-between gap-2 bg-void/20">
                                        <div className="min-w-0">
                                            <div className="text-[12px] text-text-primary font-semibold truncate">{c.name}</div>
                                            <div className="text-[10px] text-text-dim italic truncate">{c.reason}</div>
                                        </div>
                                        <div className="flex shrink-0 border border-border rounded overflow-hidden">
                                            {ACTION_OPTS.map(opt => (
                                                <button
                                                    key={opt.key}
                                                    onClick={() => onSetAction(c.id, opt.key)}
                                                    className={`text-[9px] uppercase tracking-wide px-1.5 py-1 transition-colors cursor-pointer ${action === opt.key ? opt.active : 'text-text-dim hover:text-text-primary bg-surface'}`}
                                                >
                                                    {opt.label}
                                                </button>
                                            ))}
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                    )}
                </div>

                {!running && candidates && candidates.length > 0 && (
                    <div className="px-4 py-3 border-t border-border flex justify-end gap-2 bg-void/10">
                        <button
                            onClick={onCancel}
                            className="px-3 py-1.5 text-xs text-text-dim hover:text-text-primary transition-colors rounded cursor-pointer"
                        >
                            Cancel
                        </button>
                        <button
                            onClick={onApply}
                            disabled={total === 0}
                            className="px-3 py-1.5 text-xs font-semibold bg-terminal/20 text-terminal rounded hover:bg-terminal/30 transition-colors disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer"
                        >
                            Apply ({archiveCount > 0 ? `${archiveCount} archive` : ''}{archiveCount > 0 && deleteCount > 0 ? ' · ' : ''}{deleteCount > 0 ? `${deleteCount} delete` : ''}{total === 0 ? 'nothing' : ''})
                        </button>
                    </div>
                )}
            </div>
        </div>
    );
}
