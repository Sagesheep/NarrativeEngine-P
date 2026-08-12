import React, { useState, useRef, useEffect } from 'react';
import { X } from 'lucide-react';
import type { ArchiveChapter, TimelineEvent } from '../../types';
import { getEventsByScene, maxImportanceForScene } from '../../services/campaign-state/timelineResolver';

interface TimelineDotRowProps {
    chapter: ArchiveChapter;
    events: TimelineEvent[];
    onDeleteEvent: (eventId: string) => void;
}

function DotPopover({
    sceneId,
    events,
    onDelete,
    onClose,
}: {
    sceneId: string;
    events: TimelineEvent[];
    onDelete: (id: string) => void;
    onClose: () => void;
}) {
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        function handleClick(e: MouseEvent) {
            if (ref.current && !ref.current.contains(e.target as Node)) onClose();
        }
        document.addEventListener('mousedown', handleClick);
        return () => document.removeEventListener('mousedown', handleClick);
    }, [onClose]);

    return (
        <div
            ref={ref}
            className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 z-50 w-64 bg-void-dark border border-border-bright rounded-lg shadow-xl p-2"
        >
            <div className="flex items-center justify-between mb-1.5">
                <span className="text-[12px] font-bold uppercase font-mono text-text-muted">Scene {sceneId}</span>
                <button onClick={onClose} className="text-text-muted hover:text-text-primary"><X size={12} /></button>
            </div>
            <div className="space-y-1 max-h-52 overflow-y-auto custom-scrollbar">
                {events.map(ev => (
                    <div key={ev.id} className="flex items-start gap-1.5 group">
                        <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1 flex-wrap">
                                <span className="text-[12px] font-mono text-terminal font-bold">{ev.subject}</span>
                                <span className="text-[12px] text-text-muted font-mono">{ev.predicate}</span>
                                <span className="text-[12px] font-mono text-text-secondary">{ev.object}</span>
                                {ev.source === 'manual' && (
                                    <span className="text-[11px] bg-ember/10 border border-ember/20 text-ember px-1 rounded font-mono">manual</span>
                                )}
                            </div>
                            {ev.summary && (
                                <p className="text-[12px] text-text-muted mt-0.5 leading-tight">{ev.summary}</p>
                            )}
                        </div>
                        <button
                            onClick={() => onDelete(ev.id)}
                            className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-text-muted hover:text-red-400"
                        >
                            <X size={11} />
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
}

export const TimelineDotRow = React.memo(function TimelineDotRow({ chapter, events, onDeleteEvent }: TimelineDotRowProps) {
    const [openPopover, setOpenPopover] = useState<string | null>(null);

    const startNum = parseInt(chapter.sceneRange[0], 10);
    const endNum = parseInt(chapter.sceneRange[1], 10);

    if (isNaN(startNum) || isNaN(endNum) || endNum < startNum) return null;

    const sceneCount = endNum - startNum + 1;
    // Cap at 50 dots to avoid overflow
    const maxDots = Math.min(sceneCount, 50);

    const dots: string[] = [];
    for (let i = 0; i < maxDots; i++) {
        dots.push(String(startNum + i).padStart(3, '0'));
    }

    return (
        <div className="px-3 pb-2 flex items-center gap-[3px] flex-wrap relative">
            {dots.map(sceneId => {
                const sceneEvents = getEventsByScene(events, sceneId);
                const maxImp = maxImportanceForScene(events, sceneId);
                const hasEvents = sceneEvents.length > 0;

                // Dot size by importance band
                const dotSize = !hasEvents ? 'w-2 h-2' : maxImp >= 8 ? 'w-3 h-3' : maxImp >= 4 ? 'w-2.5 h-2.5' : 'w-2 h-2';
                const dotColor = !hasEvents
                    ? 'bg-transparent border border-border/40'
                    : maxImp >= 8
                    ? 'bg-ember border border-ember/60'
                    : maxImp >= 4
                    ? 'bg-terminal/70 border border-terminal/50'
                    : 'bg-text-muted/40 border border-border';

                return (
                    <div key={sceneId} className="relative flex items-center justify-center">
                        <button
                            title={hasEvents ? `Scene ${sceneId}: ${sceneEvents.length} event(s)` : `Scene ${sceneId}`}
                            disabled={!hasEvents}
                            onClick={() => hasEvents && setOpenPopover(openPopover === sceneId ? null : sceneId)}
                            className={`rounded-full transition-all duration-150 ${dotSize} ${dotColor} ${hasEvents ? 'cursor-pointer hover:scale-125 hover:brightness-150' : 'cursor-default'}`}
                        />
                        {openPopover === sceneId && hasEvents && (
                            <DotPopover
                                sceneId={sceneId}
                                events={sceneEvents}
                                onDelete={onDeleteEvent}
                                onClose={() => setOpenPopover(null)}
                            />
                        )}
                    </div>
                );
            })}
            {sceneCount > 50 && (
                <span className="text-[11px] text-text-muted font-mono">+{sceneCount - 50}</span>
            )}
        </div>
    );
});
