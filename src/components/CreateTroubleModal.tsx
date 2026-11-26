import { X, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';

const OPTION_LETTERS = ['A', 'B', 'C', 'D'] as const;

export function CreateTroubleModal() {
    const open = useAppStore(s => s.troubleModalOpen);
    const options = useAppStore(s => s.troubleOptions);
    const loading = useAppStore(s => s.troubleLoading);
    const close = useAppStore(s => s.closeTroubleModal);
    const inject = useAppStore(s => s.injectToComposer);

    if (!open) return null;

    return (
        <div
            data-motion="overlay" className="fixed inset-0 z-[150] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
            onClick={close}
        >
            <div
                className="bg-void-darker border border-border max-w-2xl w-full max-h-[85vh] overflow-y-auto rounded font-mono text-sm"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-3 border-b border-border">
                    <span className="text-[10px] uppercase tracking-widest text-terminal">◆ Create Trouble</span>
                    <button onClick={close} className="text-text-dim hover:text-text-primary">
                        <X size={14} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    {loading && (
                        <div className="flex items-center gap-3 py-4">
                            <Loader2 size={18} className="animate-spin text-terminal" />
                            <div className="text-text-primary text-sm">Cooking up trouble…</div>
                        </div>
                    )}

                    {!loading && options.length > 0 && (
                        <div className="space-y-2">
                            <div className="text-[10px] uppercase tracking-widest text-text-dim mb-3">Pick a new arc to introduce</div>
                            {options.map((opt, i) => (
                                <button
                                    key={i}
                                    onClick={() => {
                                        close();
                                        inject(opt);
                                    }}
                                    className="w-full text-left bg-void border border-border hover:border-terminal/40 hover:bg-terminal/5 p-3 rounded transition-colors group"
                                >
                                    <span className="text-terminal text-[10px] uppercase tracking-widest font-bold mr-2">{OPTION_LETTERS[i]}</span>
                                    <span className="text-text-primary text-xs whitespace-pre-wrap">{opt}</span>
                                </button>
                            ))}

                            <div className="flex justify-center pt-2">
                                <button
                                    onClick={close}
                                    className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1.5 rounded hover:text-text-primary"
                                >
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}
