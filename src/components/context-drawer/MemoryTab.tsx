import { useState } from 'react';
import { AlertTriangle, Brain } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';
import { EMPTY_REGISTER, countRegisterTokens } from '../../services/campaign-state/divergenceRegister';
import { FactsView } from './memory-tab/FactsView';
import { ReviewView } from './memory-tab/ReviewView';
import { ScreenSection } from '../primitives/ScreenSection';

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
        // Shape A — Editor. The screen is a curated register, not a single
        // textarea; the "editor" here is the Facts view (one entry per fact).
        // The header row carries the sub-tabs and the budget meter inline so
        // they stay visible while the list scrolls.
        <div className="flex flex-col h-full space-y-3">
            <ScreenSection
                icon={Brain}
                label="Memory"
                count={activeCount}
                rightSlot={
                    <div className="flex items-center gap-1">
                        <button
                            onClick={() => setTab('facts')}
                            className={`flex items-center gap-0.5 text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'facts' ? 'text-terminal bg-terminal/10' : 'text-text-dim hover:text-text-primary'}`}
                        >
                            Facts
                        </button>
                        {reviewEntries.length > 0 && (
                            <button
                                onClick={() => setTab('review')}
                                className={`flex items-center gap-0.5 text-[11px] uppercase tracking-widest font-bold px-1.5 py-0.5 rounded whitespace-nowrap ${tab === 'review' ? 'text-amber-400 bg-amber-500/10' : 'text-text-dim hover:text-text-primary'}`}
                            >
                                <AlertTriangle size={9} />
                                Review ({reviewEntries.length})
                            </button>
                        )}
                    </div>
                }
            />

            <div className="text-[11px] text-text-dim">
                {regTokens}/{tokenBudget} tkns &middot; {activeCount} active{pinnedCount > 0 ? ` · ${pinnedCount} pinned` : ''}
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto -mx-1 px-1">
                {tab === 'facts' && <FactsView />}
                {tab === 'review' && <ReviewView reviewEntries={reviewEntries} />}
            </div>
        </div>
    );
}