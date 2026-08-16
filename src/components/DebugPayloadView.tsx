import React from 'react';
import type { DebugSection } from '../types';

const classificationColors: Record<string, string> = {
    stable_truth: 'text-terminal border-terminal/40',
    summary: 'text-ice border-ice/40',
    world_context: 'text-blue-400 border-blue-400/40',
    volatile_state: 'text-amber-400 border-amber-400/40',
    scene_local: 'text-purple-400 border-purple-400/40',
};

const classificationBg: Record<string, string> = {
    stable_truth: 'bg-terminal/5',
    summary: 'bg-ice/5',
    world_context: 'bg-blue-400/5',
    volatile_state: 'bg-amber-400/5',
    scene_local: 'bg-purple-400/5',
};

// WO2-Clock §5: sections with `role: 'utility'` are NEVER sent to the GM — they live
// only in debugSections. Today exactly one call site emits this role (the Director
// world_facts entry in volatile.ts). Badge them so QA off this view is not misled
// into thinking the Director's payload duplicates the GM's payload.
const UTILITY_BADGE = 'NOT SENT TO GM';

interface DebugPayloadViewProps {
    debugPayload: { sections?: DebugSection[]; raw?: unknown };
}

export const DebugPayloadView: React.FC<DebugPayloadViewProps> = ({ debugPayload }) => {
    const { sections, raw } = debugPayload;
    const hasSections = sections && sections.length > 0;

    return (
        <details className="mt-2 border-t border-border/50 pt-2 text-[10px]">
            <summary className="cursor-pointer text-terminal/60 hover:text-terminal transition-colors select-none flex items-center gap-2">
                <span>Debug Payload</span>
                {hasSections && (
                    <span className="text-text-dim text-[8px]">({sections.length} sections)</span>
                )}
            </summary>
            <div className="mt-2 space-y-1 max-h-[50vh] overflow-y-auto">
                {hasSections ? (
                    sections.map((section, idx) => {
                        const colorClass = classificationColors[section.classification || ''] || 'text-text-dim border-border/40';
                        const bgClass = classificationBg[section.classification || ''] || 'bg-void';
                        const isUtility = section.role === 'utility';
                        return (
                            <details
                                key={idx}
                                className={`border-l-2 ${colorClass} ${bgClass} rounded-r overflow-hidden ${isUtility ? 'opacity-70 border-dashed' : ''}`}
                                data-role={section.role}
                                data-utility={isUtility ? 'true' : 'false'}
                            >
                                <summary className="cursor-pointer px-2 py-1 hover:brightness-125 transition-all select-none flex items-center justify-between gap-2">
                                    <span className="font-bold uppercase tracking-tighter text-[10px]">
                                        {section.label}
                                    </span>
                                    <div className="flex items-center gap-2 text-[8px] shrink-0">
                                        {isUtility && (
                                            <span
                                                className="px-1 py-0.5 border border-dashed border-ember/60 text-ember bg-ember-wash rounded font-bold uppercase tracking-wider"
                                                title="This section is debug-only — it is supplied to the Continuity Director, never to the GM."
                                            >
                                                {UTILITY_BADGE}
                                            </span>
                                        )}
                                        <span className="px-1 bg-void-darker rounded">{section.role}</span>
                                        {section.tokens !== undefined && (
                                            <span className="text-text-dim">{section.tokens}t</span>
                                        )}
                                    </div>
                                </summary>
                                <div className="px-2 py-1.5 border-t border-border/20 text-text-dim text-[9px] font-mono leading-relaxed whitespace-pre-wrap break-words max-h-[400px] overflow-y-auto">
                                    {section.content || '(empty)'}
                                </div>
                            </details>
                        );
                    })
                ) : (
                    <pre className="bg-void p-2 overflow-x-auto overflow-y-auto max-h-[300px] text-text-dim text-[9px] font-mono leading-tight whitespace-pre-wrap break-all">
                        {JSON.stringify(raw, null, 2)}
                    </pre>
                )}
            </div>
        </details>
    );
};
