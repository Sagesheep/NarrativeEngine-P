import { AlertTriangle, Check, Loader2, RotateCw } from 'lucide-react';
import type { AdaptationProgress, AdaptationResult } from '../../services/import/adaptationTypes';

/**
 * WO-C §9.3 (order "C2") — the Living-world adaptation pass, made visible.
 *
 * Presentational only: it owns no timer, no abort controller and no model call.
 * The wizard runs the pass and hands down what it has; this file decides what
 * that looks like. Which is why every button here is a callback prop — the
 * panel cannot itself cancel, retry or continue, it can only ask.
 *
 * On the progress bar: it is INDETERMINATE on purpose. A batch of four to eight
 * cards against a slow local endpoint can sit for the better part of three
 * minutes with nothing to report, and a bar that creeps toward 100% over a
 * guessed 180s is a lie that gets found out precisely when the user is already
 * anxious (WO-A2 §2.4, same reasoning as the guided-creation wizard). The
 * honest signals are the batch counter and the names in flight, and those are
 * real numbers from `onProgress`.
 */

export type AdaptationPanelProps = {
    progress: AdaptationProgress | null;
    results: AdaptationResult[];
    running: boolean;
    elapsedSeconds: number;
    onCancel: () => void;
    onRetry: (ids: string[]) => void;
    onContinue: () => void;
    /** Label for the final button. The wizard continues into a new campaign; the ledger is already in one. */
    continueLabel?: string;
};

const LABEL = 'block text-[10px] uppercase tracking-wider text-text-dim mb-1';
const BTN = 'px-3 py-1.5 text-[10px] uppercase tracking-wider border rounded transition-colors disabled:opacity-30 disabled:cursor-not-allowed';

/** "2/6 · batch 1/2 · Aria, Bram" — every number in it is one the service reported. */
function progressLine(progress: AdaptationProgress | null): string {
    if (!progress) return 'Starting…';
    const parts = [`${progress.done}/${progress.total}`];
    if (progress.batchCount > 0) parts.push(`batch ${progress.batchIndex + 1}/${progress.batchCount}`);
    if (progress.inFlight.length > 0) parts.push(progress.inFlight.join(', '));
    return parts.join(' · ');
}

function elapsedLabel(seconds: number): string {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
}

export function AdaptationPanel({
    progress,
    results,
    running,
    elapsedSeconds,
    onCancel,
    onRetry,
    onContinue,
    continueLabel = 'Continue to campaign',
}: AdaptationPanelProps) {
    const adapted = results.filter(r => r.status === 'adapted');
    const fallbacks = results.filter(r => r.status !== 'adapted');

    return (
        <div className="space-y-5" data-testid="st-adaptation-panel">
            <div>
                <div className={LABEL}>Living-world adaptation</div>
                <p className="text-[11px] text-text-dim leading-relaxed max-w-xl">
                    The campaign is already saved. This pass only proposes motivations — stopping it,
                    or a character failing it, leaves that character on the offline pool wants.
                </p>
            </div>

            {running && (
                <div className="border border-border rounded p-3 space-y-2">
                    <div className="flex items-center justify-between gap-3">
                        <div className="flex items-center gap-2 min-w-0">
                            <Loader2 size={12} className="shrink-0 animate-spin text-terminal" />
                            <span className="text-[11px] text-text-primary truncate" data-testid="st-adaptation-progress">
                                {progressLine(progress)}
                            </span>
                        </div>
                        <span className="shrink-0 text-[10px] text-text-dim tabular-nums">{elapsedLabel(elapsedSeconds)}</span>
                    </div>
                    {/* Indeterminate — see the header note. No percentage is claimed. */}
                    <div className="h-1 w-full bg-void border border-border rounded overflow-hidden">
                        <div className="h-full w-full bg-terminal/60 animate-pulse" />
                    </div>
                    <button type="button" onClick={onCancel} className={`${BTN} text-text-dim border-border hover:text-terminal hover:border-terminal`}>
                        Cancel
                    </button>
                </div>
            )}

            {fallbacks.length > 0 && (
                <div className="space-y-1">
                    <div className={LABEL}>{fallbacks.length} on offline fallback</div>
                    {fallbacks.map(result => (
                        <div
                            key={result.id}
                            className="flex items-start justify-between gap-3 border border-amber-500/40 rounded px-2 py-1.5"
                        >
                            <div className="flex items-start gap-2 min-w-0">
                                <AlertTriangle size={11} className="shrink-0 mt-0.5 text-amber-400" />
                                <span className="min-w-0">
                                    <span className="text-[11px] text-amber-400">{result.name}</span>
                                    <span className="block text-[10px] text-text-dim leading-snug">
                                        {result.error ?? (result.status === 'cancelled' ? 'cancelled' : 'no reason given')}
                                        {' — keeping the pool motivations.'}
                                    </span>
                                </span>
                            </div>
                            <button
                                type="button"
                                disabled={running}
                                onClick={() => onRetry([result.id])}
                                className={`${BTN} shrink-0 flex items-center gap-1 text-amber-400 border-amber-500/40 hover:bg-amber-500/10`}
                            >
                                <RotateCw size={10} /> Retry {result.name}
                            </button>
                        </div>
                    ))}
                </div>
            )}

            {adapted.length > 0 && (
                <div className="space-y-1">
                    <div className={LABEL}>{adapted.length} adapted</div>
                    {adapted.map(result => (
                        <div key={result.id} className="flex items-start gap-2 border border-emerald-500/30 rounded px-2 py-1.5">
                            <Check size={11} className="shrink-0 mt-0.5 text-emerald-400" />
                            <span className="min-w-0">
                                <span className="text-[11px] text-emerald-400">{result.name}</span>
                                <span className="block text-[10px] text-text-dim leading-snug truncate">
                                    {result.wants?.long || 'motivations updated'}
                                </span>
                            </span>
                        </div>
                    ))}
                </div>
            )}

            {!running && (
                <div className="flex items-center justify-end gap-2">
                    {fallbacks.length > 0 && (
                        <button
                            type="button"
                            onClick={() => onRetry(fallbacks.map(r => r.id))}
                            className={`${BTN} flex items-center gap-1 text-amber-400 border-amber-500/40 hover:bg-amber-500/10`}
                        >
                            <RotateCw size={10} /> Retry all failed
                        </button>
                    )}
                    <button
                        type="button"
                        onClick={onContinue}
                        className={`${BTN} text-terminal border-terminal hover:bg-terminal/10`}
                    >
                        {continueLabel}
                    </button>
                </div>
            )}
        </div>
    );
}
