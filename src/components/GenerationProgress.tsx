import type { PipelinePhase, StreamingStats } from '../types';
import { useGatherStages } from '../services/turn/gatherProgress';

const STEPS: { phase: PipelinePhase; label: string }[] = [
    { phase: 'rolling-dice', label: 'Dice' },
    { phase: 'gathering-context', label: 'Context' },
    { phase: 'building-prompt', label: 'Prompt' },
    { phase: 'generating', label: 'Generating' },
    { phase: 'post-processing', label: 'Post' },
];

const PHASE_INDEX: Record<PipelinePhase, number> = {
    'idle': -1,
    'rolling-dice': 0,
    'gathering-context': 1,
    'building-prompt': 2,
    'generating': 3,
    'checking-notes': 3,
    'post-processing': 4,
};

function formatElapsed(ms: number): string {
    const s = Math.floor(ms / 1000);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}

type Props = {
    phase: PipelinePhase;
    stats: StreamingStats | null;
    /** WO-05: true while `runDirectorBrief` is in flight. Surfaces a
     *  "Director drafting brief…" amber pulse (mirrors the existing
     *  "Checking notes..." treatment) + a small bordered Skip button that
     *  aborts the Director call only (never the whole turn). */
    directorBriefRunning?: boolean;
    /** WO-05: aborts the Director call only. */
    onSkipDirectorBrief?: () => void;
};

export function GenerationProgress({ phase, stats, directorBriefRunning, onSkipDirectorBrief }: Props) {
    const gatherStages = useGatherStages();

    if (phase === 'idle') return null;

    const currentIdx = PHASE_INDEX[phase];
    const isCheckingNotes = phase === 'checking-notes';
    const showGatherStages = phase === 'gathering-context' && gatherStages.length > 0;

    return (
        <div data-motion="reveal" className="flex items-center gap-2 px-4 py-1.5 bg-void border-t border-border/50" aria-live="polite">
            <div className="flex items-center gap-1">
                {STEPS.map((step, idx) => {
                    const isCompleted = idx < currentIdx;
                    const isCurrent = idx === currentIdx;

                    return (
                        <span key={step.phase} className="flex items-center gap-1">
                            {idx > 0 && (
                                <span
                                    className={`w-2 h-px transition-colors duration-300 ${
                                        idx <= currentIdx ? 'bg-terminal/60' : 'bg-border'
                                    }`}
                                />
                            )}
                            <span
                                className={`flex items-center gap-1 transition-colors duration-200 ${
                                    isCompleted
                                        ? 'text-emerald-500'
                                        : isCurrent
                                            ? 'text-terminal'
                                            : 'text-text-dim/40'
                                }`}
                            >
                                <span
                                    className={`inline-block w-1.5 h-1.5 rounded-full transition-all duration-300 ${
                                        isCompleted
                                            ? 'bg-emerald-500'
                                            : isCurrent
                                                ? 'bg-terminal animate-pulse shadow-[0_0_6px_rgba(0,255,65,0.5)]'
                                                : 'bg-text-dim/20'
                                    }`}
                                />
                                <span
                                    className={`text-[9px] uppercase tracking-wider font-medium ${
                                        isCurrent ? 'inline' : 'hidden sm:inline'
                                    }`}
                                >
                                    {step.label}
                                </span>
                            </span>
                        </span>
                    );
                })}
            </div>

            {isCheckingNotes && (
                <span className="text-[9px] uppercase tracking-wider text-amber-500/80 animate-pulse-slow ml-1">
                    Checking notes...
                </span>
            )}

            {/* WO-05: Director Brief in flight — mirror the "Checking notes..."
                amber pulse treatment and add a small bordered Skip button that
                aborts the Director call only (styled like UtilityCallStrip's
                EXTEND +1m button so no new visual pattern is introduced). */}
            {directorBriefRunning && (
                <span className="flex items-center gap-1.5 ml-1">
                    <span className="text-[9px] uppercase tracking-wider text-amber-500/80 animate-pulse-slow">
                        Director drafting brief…
                    </span>
                    {onSkipDirectorBrief && (
                        <button
                            onClick={onSkipDirectorBrief}
                            className="shrink-0 text-[9px] uppercase tracking-wider font-bold px-2 py-1 border rounded transition-colors border-amber-500/40 text-amber-500/80 hover:text-amber-500 hover:border-amber-500 hover:bg-amber-500/10 min-h-[28px]"
                        >
                            Skip
                        </button>
                    )}
                </span>
            )}

            {showGatherStages && (
                <span className="ml-1 flex items-center gap-1.5 min-w-0 text-[9px] uppercase tracking-wider text-terminal/70">
                    <span className="text-terminal/30">·</span>
                    <span className="truncate animate-pulse-slow">{gatherStages.join(' · ')}</span>
                </span>
            )}

            {phase === 'generating' && stats && stats.tokens > 0 && (
                <span className="ml-auto flex items-center gap-2 text-[9px] uppercase tracking-wider text-terminal/60 tabular-nums">
                    <span>{stats.tokens} tok</span>
                    <span className="text-terminal/30">·</span>
                    <span>{stats.speed.toFixed(0)} tok/s</span>
                    <span className="text-terminal/30">·</span>
                    <span>{formatElapsed(stats.elapsed)}</span>
                </span>
            )}
        </div>
    );
}
