import type { PipelinePhase, StreamingStats } from '../types';

const STEPS: { phase: PipelinePhase; label: string }[] = [
    { phase: 'rolling-dice', label: 'Dice' },
    { phase: 'ai-intervention', label: 'AI Turn' },
    { phase: 'gathering-context', label: 'Context' },
    { phase: 'building-prompt', label: 'Prompt' },
    { phase: 'generating', label: 'Generating' },
    { phase: 'post-processing', label: 'Post' },
];

const PHASE_INDEX: Record<PipelinePhase, number> = {
    'idle': -1,
    'rolling-dice': 0,
    'ai-intervention': 1,
    'gathering-context': 2,
    'building-prompt': 3,
    'generating': 4,
    'checking-notes': 4,
    'post-processing': 5,
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
};

export function GenerationProgress({ phase, stats }: Props) {
    if (phase === 'idle') return null;

    const currentIdx = PHASE_INDEX[phase];
    const isCheckingNotes = phase === 'checking-notes';

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-void border-t border-border/50" aria-live="polite">
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
