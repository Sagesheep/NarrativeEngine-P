import { useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { EMPTY_REGISTER, countRegisterTokens } from '../../services/campaign-state/divergenceRegister';
import { FactsView } from './memory-tab/FactsView';
import { ReviewView } from './memory-tab/ReviewView';

type Tab = 'facts' | 'review';

export function MemoryTab() {
    const divergenceRegister = useAppStore(s => s.divergenceRegister);
    const settings = useAppStore(s => s.settings);

    const [tab, setTab] = useState<Tab>('facts');

    const reg = divergenceRegister ?? EMPTY_REGISTER;
    const tokenBudget = settings.divergenceTokenBudget ?? 2000;
    const regTokens = countRegisterTokens(reg);
    const entries = reg.entries;
    const reviewEntries = entries.filter(e => e.reviewFlag);

    const activeCount = entries.filter(e => {
        if (e.enabled === false) return false;
        if (e.pinned) return true;
        const chapterOn = reg.chapterToggles[e.chapterId] !== false;
        if (!chapterOn) return false;
        const catToggles = reg.categoryToggles[e.chapterId];
        if (catToggles && catToggles[e.category] === false) return false;
        return true;
    }).length;
    const pinnedCount = entries.filter(e => e.pinned).length;

    return (
        <div className="p-3 space-y-3">
            <div className="flex items-center gap-1 overflow-x-auto no-scrollbar">
                <button
                    onClick={() => setTab('facts')}
                    className={`flex items-center gap-0.5 text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'facts' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                >
                    Facts ({activeCount})
                </button>
                {reviewEntries.length > 0 && (
                    <button
                        onClick={() => setTab('review')}
                        className={`flex items-center gap-0.5 text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'review' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim'}`}
                    >
                        <AlertTriangle size={9} />
                        Rev ({reviewEntries.length})
                    </button>
                )}
            </div>

            <div className="text-[11px] text-text-dim">
                {regTokens}/{tokenBudget} tkns &middot; {activeCount} active{pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
            </div>

            {tab === 'facts' && <FactsView />}
            {tab === 'review' && <ReviewView reviewEntries={reviewEntries} />}
        </div>
    );
}
