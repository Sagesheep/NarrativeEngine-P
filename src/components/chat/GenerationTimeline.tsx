import { useEffect, useReducer, useState } from 'react';
import { useAppStore } from '../../store/useAppStore';
import { useGatherStageRecords } from '../../services/turn/gatherProgress';
import { useUtilityCalls } from '../../services/llm/utilityCallTracker';
import type { UtilityCallRecord } from '../../services/llm/utilityCallTracker';
import { EMPTY_RUN, PHASE_LABELS, recordGenerationPhase } from './generationTimelineState';

function duration(start: number, end: number): string {
    const seconds = Math.max(0, Math.floor((end - start) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function callName(label: string): string {
    return label.replace(/[-_]/g, ' ').replace(/([a-z])([A-Z])/g, '$1 $2');
}
function CallRow({ call, now }: { call: UtilityCallRecord; now: number }) {
    const status = call.status === 'success' ? 'Complete' : call.status === 'running' ? 'Running'
        : call.status === 'aborted' ? 'Stopped' : call.status === 'timeout' ? 'Timed out' : 'Failed';
    return <li className="generation-call" data-status={call.status}>
        <details>
            <summary><span>{callName(call.label)}</span><span className="generation-duration">{duration(call.startedAt, call.settledAt ?? now)}</span></summary>
            <div className="generation-call-detail">
                <span>{status} · {call.endpointName}</span>
                {call.errorMessage && <p>{call.errorMessage}</p>}
            </div>
        </details>
        <span className="generation-call-status">{status}</span>
    </li>;
}

export function GenerationTimeline() {
    const [run, dispatch] = useReducer(recordGenerationPhase, EMPTY_RUN, () => {
        const state = useAppStore.getState();
        return recordGenerationPhase(EMPTY_RUN, { phase: state.pipelinePhase ?? 'idle', now: Date.now(), tier: state.settings?.aiTier ?? 'pro' });
    });
    const [expanded, setExpanded] = useState(() => window.matchMedia?.('(min-width: 1100px)').matches ?? false);
    const [now, setNow] = useState(Date.now);
    const gather = useGatherStageRecords();
    const calls = useUtilityCalls();

    // Subscribe to writes, not rendered props: synchronous phases must not disappear
    // when React batches multiple store updates into one render.
    useEffect(() => useAppStore.subscribe((state, previous) => {
        if (state.activeCampaignId !== previous.activeCampaignId) { dispatch({ reset: true }); return; }
        if (state.pipelinePhase === previous.pipelinePhase) return;
        const assistant = [...state.messages].reverse().find(message => message.role === 'assistant');
        dispatch({ phase: state.pipelinePhase, now: Date.now(), tier: state.settings.aiTier ?? 'pro', halted: !!assistant?.retryable });
    }), []);

    const records = [...calls.history, ...calls.active].filter(call => run.startedAt !== undefined
        && call.startedAt >= run.startedAt && (run.endedAt === undefined || call.startedAt <= run.endedAt))
        .sort((a, b) => a.startedAt - b.startedAt);
    const tasks = gather.filter(task => run.startedAt !== undefined && task.startedAt >= run.startedAt
        && (run.endedAt === undefined || task.startedAt <= run.endedAt));
    const running = run.status === 'running' || records.some(call => call.status === 'running');
    useEffect(() => {
        if (!running) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1000);
        return () => window.clearInterval(timer);
    }, [running]);

    return <aside className="generation-sidebar" aria-label="Generation stages" data-expanded={expanded}>
        <header className="generation-heading">
            <div><h2>Generation stages</h2><span>{run.tier ? `${run.tier.toUpperCase()} · ` : ''}{run.status === 'ready' ? 'Ready for your next turn'
                : run.status === 'running' ? 'Running' : run.status === 'finished' ? 'Last turn finished' : 'Turn stopped'}</span></div>
            <button type="button" onClick={() => setExpanded(value => !value)} aria-expanded={expanded} aria-controls="generation-stage-details" aria-label={expanded ? 'Collapse generation stages' : 'Expand generation stages'}>{expanded ? '−' : '+'}</button>
        </header>
        <div id="generation-stage-details" className="generation-body" hidden={!expanded}>
            {run.startedAt === undefined ? <p className="generation-empty">Steps appear here as they run. Parallel context tasks and model calls are recorded automatically.</p> : <>
                <div className="generation-total">Turn elapsed <span>{duration(run.startedAt, run.endedAt ?? now)}</span></div>
                <ol className="generation-steps">
                    {run.steps.map((step, index) => <li key={`${step.phase}-${index}`} data-status={step.status}>
                        <div className="generation-step-line"><span className="generation-step-mark" aria-hidden="true">{step.status === 'running' ? '●' : step.status === 'finished' ? '✓' : '!'}</span>
                            <span>{PHASE_LABELS[step.phase]}</span><span className="generation-duration">{duration(step.startedAt, step.endedAt ?? now)}</span></div>
                        <span className="generation-state">{step.status === 'running' ? 'Running' : step.status === 'finished' ? 'Finished' : 'Stopped'}</span>
                        {step.phase === 'gathering-context' && tasks.length > 0 && <details className="generation-context" open={step.status === 'running'}>
                            <summary>Context tasks · may run in parallel</summary><ul>{tasks.map(task => <li key={`${task.label}-${task.startedAt}`}><span>{task.label}</span><span>{task.endedAt === undefined && run.status === 'running' ? 'Running' : task.endedAt !== undefined ? 'Finished' : 'Stopped'}</span></li>)}</ul>
                        </details>}
                    </li>)}
                </ol>
                {records.length > 0 && <section className="generation-calls"><h3>Model calls</h3><ul>{records.map(call => <CallRow key={call.id} call={call} now={now} />)}</ul></section>}
                <p className="generation-footnote">Only observed steps are shown. Disabled or unused steps are omitted.</p>
            </>}
        </div>
    </aside>;
}
