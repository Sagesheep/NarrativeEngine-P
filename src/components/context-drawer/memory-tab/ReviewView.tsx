import { Check, AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../../store/useAppStore';
import type { DivergenceEntry } from '../../../types';

const CATEGORY_DOTS: Record<string, string> = {
    locations: 'bg-blue-400',
    npc_events: 'bg-green-400',
    promises_debts: 'bg-amber-400',
    world_state: 'bg-cyan-400',
    party_facts: 'bg-emerald-400',
    rules_lore: 'bg-purple-400',
    misc: 'bg-gray-400',
};

interface ReviewViewProps {
    reviewEntries: DivergenceEntry[];
}

export function ReviewView({ reviewEntries }: ReviewViewProps) {
    const deleteDivergenceFact = useAppStore(s => s.deleteDivergenceFact);
    const confirmReviewEntry = useAppStore(s => s.confirmReviewEntry);

    const handleDelete = (id: string) => {
        if (window.confirm('Delete this fact permanently?')) {
            deleteDivergenceFact(id);
        }
    };

    return (
        <div className="space-y-1.5">
            {reviewEntries.length === 0 ? (
                <p className="text-[10px] text-text-dim italic py-4 text-center">No entries flagged for review.</p>
            ) : (
                reviewEntries.map(e => (
                    <div key={e.id} className="bg-amber-900/20 border border-amber-500/40 p-1.5 rounded">
                        <div className="flex items-start gap-1.5 text-[10px]">
                            <span className={`shrink-0 mt-0.5 w-1.5 h-1.5 rounded-full ${CATEGORY_DOTS[e.category]}`} />
                            <div className="min-w-0 flex-1">
                                <span className="text-amber-400 font-bold text-[9px] mr-1">[REVIEW]</span>
                                <span className="text-text-primary">{e.text}</span>
                                <span className="text-text-dim ml-1 text-[9px]">[#{e.sceneRef}]</span>
                                {e.unrecognizedNpcNames && e.unrecognizedNpcNames.length > 0 && (
                                    <div className="text-[9px] text-amber-300 mt-0.5">
                                        Unrecognized: {e.unrecognizedNpcNames.join(', ')}
                                    </div>
                                )}
                            </div>
                        </div>
                        <div className="flex items-center gap-1.5 mt-1 ml-3.5">
                            <button onClick={() => confirmReviewEntry(e.id)} className="flex items-center gap-0.5 text-[9px] text-emerald-400 hover:text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10">
                                <Check size={8} /> Keep
                            </button>
                            <button onClick={() => handleDelete(e.id)} className="flex items-center gap-0.5 text-[9px] text-red-400 hover:text-red-300 px-1.5 py-0.5 rounded bg-red-500/10">
                                <AlertTriangle size={8} /> Delete
                            </button>
                        </div>
                    </div>
                ))
            )}
        </div>
    );
}
