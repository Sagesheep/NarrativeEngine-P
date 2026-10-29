import { useState, useEffect } from 'react';
import { useAppStore } from '../store/useAppStore';
import { useUtilityCalls, extendCall } from '../services/llm/utilityCallTracker';
import type { PipelinePhase, StreamingStats } from '../types';

const LABEL_MAP: Record<string, string> = {
    'expandQuery': 'Query Expansion',
    'rerank-scene': 'Reranking Scenes',
    'rerank-lore': 'Reranking Lore',
    'recommender': 'AI Recommender',
    'planner': 'Planner',
    'archive-planner': 'Archive Planner',
    'deep-search-chapters': 'Deep Search · Chapters',
    'deep-search-scenes': 'Deep Search · Scenes',
    'deep-search-summarize': 'Deep Search · Summarize',
    'deep-search-merge': 'Deep Search · Merge',
    'scene-stakes-classify': 'Scene Stakes',
    'story-generation': 'Story Generation',
    'importance-rating': 'Rating Scene Importance',
    'scene-event-extract': 'Extracting Scene Events',
    'profile-scan': 'Scanning Character Profile',
    'trait-scan': 'Scanning Character Traits',
    'inventory-scan': 'Scanning Inventory',
    'npc-validate': 'Validating NPCs',
    'npc-update': 'Updating NPCs',
    'npc-drives-backfill': 'Backfilling NPC Drives',
    'witness-capture': 'Capturing Witnesses',
    'chapter-seal': 'Sealing Chapter',
};

const PHASE_LABEL: Record<PipelinePhase, string> = {
    'idle': '',
    'rolling-dice': 'rolling dice',
    'gathering-context': 'gathering context',
    'building-prompt': 'building prompt',
    'generating': 'generating',
    'checking-notes': 'checking notes',
    'post-processing': 'post-processing',
};

function formatElapsed(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return m > 0 ? `${m}:${String(s).padStart(2, '0')}` : `${s}s`;
}

function GenerationStrip({ phase, stats }: { phase: PipelinePhase; stats: StreamingStats | null }) {
    const modelName = useAppStore.getState().getActiveStoryEndpoint?.()?.modelName;
    const isGenerating = phase === 'generating' || phase === 'checking-notes';
    const isPreGen = phase !== 'idle' && phase !== 'generating' && phase !== 'checking-notes' && phase !== 'post-processing';
    const isPost = phase === 'post-processing';

    if (phase === 'idle') return null;

    return (
        <div className="flex items-center gap-2 px-4 py-1.5 bg-void-lighter/30 border-t border-border/30 text-text-dim text-[9px] uppercase tracking-wider font-mono">
            {(isGenerating || isPost) && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-terminal animate-pulse" />
            )}
            {isPreGen && (
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
            )}
            <span className="text-text-dim/70">{PHASE_LABEL[phase]}</span>
            {modelName && (
                <>
                    <span className="text-text-dim/30">·</span>
                    <span className="text-text-dim/50 normal-case truncate max-w-[140px]">{modelName}</span>
                </>
            )}
            {isGenerating && stats && stats.tokens > 0 && (
                <>
                    <span className="text-text-dim/30">·</span>
                    <span className="tabular-nums">{stats.tokens} tok</span>
                    <span className="text-text-dim/30">·</span>
                    <span className="tabular-nums">{formatElapsed(stats.elapsed)}</span>
                    <span className="text-text-dim/30">·</span>
                    <span className="tabular-nums">{stats.speed.toFixed(0)} tok/s</span>
                </>
            )}
        </div>
    );
}

/**
 * Telemetry strip (WO-11.7) — upgraded UtilityCallStrip. Now shows the live
 * generation status (phase, model, tokens, elapsed, speed) alongside the
 * active utility-call tracker. Desktop previously had a simpler strip + a
 * separate GenerationProgress stepper; this consolidates the per-call telemetry
 * mobile's TelemetryStrip surfaces, while the stepper remains for the
 * phase pipeline visualization.
 */
export function UtilityCallStrip() {
    const { active } = useUtilityCalls();
    const pipelinePhase = useAppStore(s => s.pipelinePhase);
    const streamingStats = useAppStore(s => s.streamingStats);
    const [, setTick] = useState(0);

    useEffect(() => {
        if (active.length === 0 && pipelinePhase === 'idle') return;
        const id = setInterval(() => setTick(t => t + 1), 1000);
        return () => clearInterval(id);
    }, [active.length, pipelinePhase]);

    const hasGeneration = pipelinePhase !== 'idle';
    if (active.length === 0 && !hasGeneration) return null;

    return (
        <div className="border-b border-terminal/20 bg-terminal/5">
            {hasGeneration && <GenerationStrip phase={pipelinePhase} stats={streamingStats} />}
            {active.map(call => {
                const now = Date.now();
                const elapsed = Math.floor((now - call.startedAt) / 1000);
                const totalSec = Math.floor(call.initialTimeoutMs / 1000);
                const remaining = Math.max(0, Math.floor((call.deadline - now) / 1000));
                const isWarning = remaining <= Math.floor(totalSec * 0.25) && remaining > 0;
                const isExpired = remaining === 0;
                const displayName = LABEL_MAP[call.label] ?? call.label;

                return (
                    <div key={call.id} className="flex items-center gap-2 px-4 py-1.5">
                        <div className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${isExpired ? 'bg-red-500' : isWarning ? 'bg-amber-400 animate-pulse' : 'bg-terminal animate-pulse'}`} />
                        <span className={`text-[9px] uppercase tracking-widest font-bold font-mono flex-1 truncate ${isExpired ? 'text-red-400' : isWarning ? 'text-amber-400' : 'text-terminal'}`}>
                            {displayName}
                            <span className="text-text-dim font-normal normal-case tracking-normal ml-1">— {call.endpointName}</span>
                            <span className={`ml-2 ${isWarning || isExpired ? '' : 'text-text-dim'}`}>
                                {elapsed}s / {totalSec + call.extensions * 60}s
                            </span>
                            {call.extensions > 0 && (
                                <span className="ml-1 text-text-dim">(+{call.extensions}ext)</span>
                            )}
                        </span>
                        <button
                            onClick={() => extendCall(call.id, 60000)}
                            className="shrink-0 text-[9px] uppercase tracking-wider font-bold px-2 py-1 border rounded transition-colors border-terminal/40 text-terminal/70 hover:text-terminal hover:border-terminal hover:bg-terminal/10 min-h-[28px]"
                        >
                            EXTEND +1m
                        </button>
                    </div>
                );
            })}
        </div>
    );
}