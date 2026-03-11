import React from 'react';
import { useAppStore } from '../store/useAppStore';
import { Activity, Info } from 'lucide-react';

export const PayloadTraceView: React.FC = () => {
    const { lastPayloadTrace, settings } = useAppStore();

    if (!settings.debugMode || !lastPayloadTrace || lastPayloadTrace.length === 0) {
        return null;
    }

    const totalTokens = lastPayloadTrace.reduce((acc, t) => acc + (t.included ? t.tokens : 0), 0);
    const budgetRemaining = settings.contextLimit - totalTokens;

    return (
        <div className="mt-4 p-3 bg-void-darker border border-terminal/30 rounded font-mono text-[10px]">
            <div className="flex items-center gap-2 mb-3 border-b border-terminal/20 pb-2">
                <Activity size={14} className="text-terminal" />
                <span className="text-terminal uppercase tracking-widest font-bold">Payload Trace</span>
                <div className="ml-auto text-text-dim">
                    Total: <span className="text-terminal font-bold">{totalTokens}</span> / {settings.contextLimit}
                </div>
            </div>

            <div className="space-y-3">
                {lastPayloadTrace.map((trace, idx) => (
                    <div key={idx} className={`p-2 border-l-2 ${trace.included ? 'border-terminal/50 bg-terminal/5' : 'border-red-500/50 bg-red-500/5 opacity-60'}`}>
                        <div className="flex justify-between items-start mb-1">
                            <div className="flex flex-col">
                                <span className={`font-bold uppercase tracking-tighter ${trace.included ? 'text-terminal' : 'text-red-400'}`}>
                                    {trace.source}
                                </span>
                                <span className="text-[8px] text-text-dim/70 uppercase">{trace.classification} @ {trace.position || 'N/A'}</span>
                            </div>
                            <div className="text-[9px] font-bold text-text-dim">
                                {trace.tokens} tokens
                            </div>
                        </div>
                        <div className="flex items-center gap-1 text-text-dim italic">
                            <Info size={10} />
                            {trace.reason}
                        </div>
                    </div>
                ))}
            </div>

            <div className="mt-4 pt-2 border-t border-terminal/20 flex justify-between text-text-dim uppercase tracking-tighter">
                <span>Budget Status</span>
                <span className={budgetRemaining < 0 ? 'text-red-400 font-bold' : 'text-terminal'}>
                    {budgetRemaining < 0 ? 'OVERFLOW' : `${budgetRemaining} tokens free`}
                </span>
            </div>
        </div>
    );
};
