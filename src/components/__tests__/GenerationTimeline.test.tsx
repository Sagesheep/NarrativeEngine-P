import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_RUN, recordGenerationPhase } from '../chat/generationTimelineState';
import type { PipelinePhase } from '../../types';

const fixture = vi.hoisted(() => ({
    state: { pipelinePhase: 'idle', activeCampaignId: 'a', settings: { aiTier: 'max' }, messages: [] as { role: string; retryable?: boolean }[] },
    listeners: new Set<(state: unknown, previous: unknown) => void>(),
    calls: { active: [] as unknown[], history: [] as unknown[] },
    gather: [] as unknown[],
}));
vi.mock('../../store/useAppStore', () => ({ useAppStore: {
    getState: () => fixture.state,
    subscribe: (listener: (state: unknown, previous: unknown) => void) => {
        fixture.listeners.add(listener); return () => fixture.listeners.delete(listener);
    },
} }));
vi.mock('../../services/turn/gatherProgress', () => ({ useGatherStageRecords: () => fixture.gather }));
vi.mock('../../services/llm/utilityCallTracker', () => ({ useUtilityCalls: () => fixture.calls }));
import { GenerationTimeline } from '../chat/GenerationTimeline';

function update(patch: Partial<typeof fixture.state>) {
    const previous = fixture.state;
    fixture.state = { ...previous, ...patch };
    fixture.listeners.forEach(listener => listener(fixture.state, previous));
}
beforeEach(() => {
    fixture.state = { pipelinePhase: 'idle', activeCampaignId: 'a', settings: { aiTier: 'max' }, messages: [] };
    fixture.calls = { active: [], history: [] }; fixture.gather = [];
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
});
afterEach(() => { vi.unstubAllGlobals(); });

describe('generation timeline', () => {
    it('records all actual phases even when React batches a whole turn', () => {
        render(<GenerationTimeline />);
        act(() => {
            for (const pipelinePhase of ['rolling-dice', 'gathering-context', 'building-prompt', 'generating', 'post-processing', 'idle']) update({ pipelinePhase });
        });
        expect(screen.getByText('Resolve dice and events')).toBeInTheDocument();
        expect(screen.getByText('Gather context and memories')).toBeInTheDocument();
        expect(screen.getByText('Prepare story prompt')).toBeInTheDocument();
        expect(screen.getByText('Generate story')).toBeInTheDocument();
        expect(screen.getByText('Finalize story')).toBeInTheDocument();
        expect(screen.getByText('MAX · Last turn finished')).toBeInTheDocument();
        expect(screen.queryByText('Check notes')).not.toBeInTheDocument();
    });
    it('marks cancellation as stopped and clears the previous campaign', () => {
        render(<GenerationTimeline />);
        act(() => { update({ pipelinePhase: 'generating' }); update({ pipelinePhase: 'idle' }); });
        expect(screen.getByText('MAX · Turn stopped')).toBeInTheDocument();
        act(() => update({ activeCampaignId: 'b' }));
        expect(screen.getByText('Ready for your next turn')).toBeInTheDocument();
        expect(screen.queryByText('Generate story')).not.toBeInTheDocument();
    });
    it('shows real parallel context tasks and model errors without mixing old calls', () => {
        const view = render(<GenerationTimeline />);
        act(() => update({ pipelinePhase: 'gathering-context' }));
        const now = Date.now();
        fixture.gather = [{ label: 'Planner', startedAt: now }, { label: 'Recall', startedAt: now, endedAt: now }];
        fixture.calls.history = [
            { id: 'old', label: 'old-call', startedAt: now - 10000, settledAt: now, status: 'success' },
            { id: 'new', label: 'planner', endpointName: 'Utility', startedAt: now, settledAt: now, status: 'error', errorMessage: 'Connection failed' },
        ];
        view.rerender(<GenerationTimeline />);
        expect(screen.getByText('Planner')).toBeInTheDocument();
        expect(screen.getByText('Recall')).toBeInTheDocument();
        expect(screen.getByText('Failed')).toBeInTheDocument();
        expect(screen.getByText('Connection failed')).toBeInTheDocument();
        expect(screen.queryByText('old call')).not.toBeInTheDocument();
    });
    it('can collapse without losing the turn record', () => {
        render(<GenerationTimeline />);
        act(() => update({ pipelinePhase: 'generating' }));
        fireEvent.click(screen.getByRole('button', { name: 'Collapse generation stages' }));
        expect(document.querySelector('#generation-stage-details')).toHaveAttribute('hidden');
        fireEvent.click(screen.getByRole('button', { name: 'Expand generation stages' }));
        expect(screen.getByText('Generate story')).toBeVisible();
    });
});

describe('phase recording', () => {
    it('preserves durations and starts a fresh run after a finished turn', () => {
        let run = recordGenerationPhase(EMPTY_RUN, { phase: 'generating', now: 100, tier: 'max' });
        run = recordGenerationPhase(run, { phase: 'post-processing', now: 300 });
        run = recordGenerationPhase(run, { phase: 'idle', now: 350 });
        expect(run.steps[0].endedAt).toBe(300);
        expect(run.status).toBe('finished');
        run = recordGenerationPhase(run, { phase: 'rolling-dice', now: 1000, tier: 'lite' });
        expect(run.steps).toHaveLength(1); expect(run.tier).toBe('lite');
    });
    it('does not label a halted turn successful even after post-processing', () => {
        const run = recordGenerationPhase(EMPTY_RUN, { phase: 'post-processing', now: 100 });
        expect(recordGenerationPhase(run, { phase: 'idle', now: 200, halted: true }).status).toBe('stopped');
    });
    it('does not duplicate repeated phase notifications', () => {
        const event = { phase: 'generating' as PipelinePhase, now: 100 };
        const run = recordGenerationPhase(EMPTY_RUN, event);
        expect(recordGenerationPhase(run, { ...event, now: 200 })).toBe(run);
    });
});
