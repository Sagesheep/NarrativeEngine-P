import type { PayloadTrace, DebugSection } from '../../types';

export interface TraceCollector {
    addTrace(t: PayloadTrace): void;
    addSection(s: DebugSection): void;
    readonly trace: PayloadTrace[];
    readonly debugSections: DebugSection[];
}

export function createTraceCollector(isDebug: boolean): TraceCollector {
    const trace: PayloadTrace[] = [];
    const debugSections: DebugSection[] = [];
    return {
        addTrace: (t) => { if (isDebug) trace.push(t); },
        addSection: (s) => { if (isDebug) debugSections.push(s); },
        trace,
        debugSections,
    };
}
