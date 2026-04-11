import { useState } from 'react';
import { FileText, Edit2, RotateCcw, Check, X, RotateCw } from 'lucide-react';
import { toast } from './Toast';

interface CondensedPanelProps {
    condensedSummary: string;
    condensedUpToIndex: number;
    messageCount: number;
    onSave: (draft: string) => void;
    onRetcon: (draft: string) => void;
    onReset: () => void;
}

export function CondensedPanel({
    condensedSummary,
    condensedUpToIndex,
    messageCount,
    onSave,
    onRetcon,
    onReset,
}: CondensedPanelProps) {
    const [isEditing, setIsEditing] = useState(false);
    const [draft, setDraft] = useState('');

    return (
        <div className="mx-2 md:mx-4 mb-1 border border-amber-500/30 bg-amber-500/5 rounded-sm overflow-hidden animate-[msg-in_0.15s_ease-out]">
            <div className="flex items-center justify-between px-3 py-1.5 bg-amber-500/10 border-b border-amber-500/20">
                <div className="flex items-center gap-2">
                    <FileText size={12} className="text-amber-500" />
                    <span className="text-[10px] text-amber-500 uppercase tracking-widest font-bold">Condensed Memory</span>
                    <span className="text-[9px] text-text-dim">(up to msg #{condensedUpToIndex})</span>
                </div>
                <div className="flex items-center gap-1">
                    {!isEditing ? (
                        <>
                            <button
                                onClick={() => {
                                    setDraft(condensedSummary);
                                    setIsEditing(true);
                                }}
                                className="text-text-dim hover:text-amber-500 p-1 bg-void-lighter rounded transition-colors"
                                title="Edit summary (retcon)"
                            >
                                <Edit2 size={11} />
                            </button>
                            <button
                                onClick={() => {
                                    if (window.confirm('Reset condensed memory? This will clear the summary and re-include all messages in context. Cannot be undone.')) {
                                        onReset();
                                        toast.info('Condensed memory cleared — full history restored to context');
                                    }
                                }}
                                className="text-text-dim hover:text-danger p-1 bg-void-lighter rounded transition-colors"
                                title="Reset condensed memory entirely"
                            >
                                <RotateCw size={11} />
                            </button>
                        </>
                    ) : (
                        <>
                            <button
                                onClick={() => {
                                    onSave(draft);
                                    setIsEditing(false);
                                    toast.success('Condensed memory updated');
                                }}
                                className="text-text-dim hover:text-emerald-500 p-1 bg-void-lighter rounded transition-colors"
                                title="Save edits (keep raw history)"
                            >
                                <Check size={11} />
                            </button>
                            <button
                                onClick={() => {
                                    if (window.confirm('RETCON: This will override ALL raw conversation history. Only your edited summary + your next message will be sent to the AI. Use this to rewrite scenes.')) {
                                        onRetcon(draft);
                                        setIsEditing(false);
                                        toast.success(`Retcon applied — all ${messageCount} messages now behind summary boundary`);
                                    }
                                }}
                                className="text-text-dim hover:text-amber-500 p-1 bg-void-lighter rounded transition-colors"
                                title="RETCON: Save edits & override all raw history — AI will only see this summary"
                            >
                                <RotateCcw size={11} />
                            </button>
                            <button
                                onClick={() => {
                                    setIsEditing(false);
                                    setDraft('');
                                }}
                                className="text-text-dim hover:text-danger p-1 bg-void-lighter rounded transition-colors"
                                title="Cancel edits"
                            >
                                <X size={11} />
                            </button>
                        </>
                    )}
                </div>
            </div>
            <div className="p-3 max-h-[250px] overflow-y-auto">
                {isEditing ? (
                    <textarea
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        className="w-full bg-void border border-amber-500/30 focus:border-amber-500 text-text-primary text-[11px] font-mono leading-relaxed p-2 resize-y min-h-[120px] max-h-[400px] outline-none rounded-sm transition-colors"
                        placeholder="Edit condensed memory..."
                    />
                ) : (
                    <div className="text-[11px] text-text-primary/80 font-mono leading-relaxed whitespace-pre-wrap">
                        {condensedSummary}
                    </div>
                )}
            </div>
        </div>
    );
}
