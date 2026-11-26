import type { PipelinePhase } from '../../types';

export const PHASE_LABELS: Record<Exclude<PipelinePhase, 'idle'>, string> = {
    'rolling-dice': 'Resolve dice and events',
    'gathering-context': 'Gather context and memories',
    'building-prompt': 'Prepare story prompt',
    'generating': 'Generate story',
    'checking-notes': 'Check notes',
    'post-processing': 'Finalize story',
};
export type TimelineStep = {
    phase: Exclude<PipelinePhase, 'idle'>;
    startedAt: number;
    endedAt?: number;
    status: 'running' | 'finished' | 'stopped';
};
export type GenerationRun = {
    startedAt?: number;
    endedAt?: number;
    tier?: string;
    status: 'ready' | 'running' | 'finished' | 'stopped';
    steps: TimelineStep[];
};
export const EMPTY_RUN: GenerationRun = { status: 'ready', steps: [] };
export type TimelineEvent = { phase: PipelinePhase; now: number; tier?: string; halted?: boolean } | { reset: true };

/** Records only phases actually entered; never guesses whether a gated step ran. */
export function recordGenerationPhase(run: GenerationRun, event: TimelineEvent): GenerationRun {
    if ('reset' in event) return EMPTY_RUN;
    const { phase, now, tier, halted } = event;
    const last = run.steps.at(-1);
    if (phase === 'idle') {
        if (run.status !== 'running') return run;
        const finished = last?.phase === 'post-processing' && !halted;
        return { ...run, endedAt: now, status: finished ? 'finished' : 'stopped',
            steps: run.steps.map((step, i) => i === run.steps.length - 1
                ? { ...step, endedAt: now, status: finished ? 'finished' : 'stopped' } : step) };
    }
    if (run.status === 'running' && last?.phase === phase) return run;
    if (run.status !== 'running') {
        return { startedAt: now, tier, status: 'running', steps: [{ phase, startedAt: now, status: 'running' }] };
    }
    return { ...run, steps: [...run.steps.map(step => step.status === 'running'
        ? { ...step, endedAt: now, status: 'finished' as const } : step), { phase, startedAt: now, status: 'running' }] };
}
