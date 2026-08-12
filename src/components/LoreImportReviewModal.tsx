import { useState } from 'react';
import { X, Loader2, ChevronDown, ChevronRight } from 'lucide-react';
import { classifyPastedLore, ALL_CATEGORIES, CATEGORY_LABELS, type ClassifiedChunk, type ClassifiedCategory } from '../services/lore/worldLoreImport';
import { AuxNotConfiguredError } from '../services/lore/worldLoreAI';
import { toast } from './Toast';
import type { WorldLoreDraft } from '../types';

type ReviewItem = ClassifiedChunk & { accepted: boolean };

type Props = {
    draft: WorldLoreDraft;
    onStartClassification: (text: string) => void;
    onMerge: (flatUpdates: Partial<WorldLoreDraft>, listItems: Record<string, { title: string; body: string }[]>, rawSource: string) => void;
    onClose: () => void;
};

export function LoreImportReviewModal({ draft, onStartClassification, onMerge, onClose }: Props) {
    const [phase, setPhase] = useState<'paste' | 'reviewing' | 'error'>('paste');
    const [pastedText, setPastedText] = useState('');
    const [rawSource, setRawSource] = useState('');
    const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
    const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
    const [error, setError] = useState('');
    const [classifying, setClassifying] = useState(false);

    const handleClassify = async () => {
        if (!pastedText.trim()) return;

        setClassifying(true);
        setError('');
        const src = pastedText.trim();
        setRawSource(src);
        onStartClassification(src);

        try {
            const chunks = await classifyPastedLore(src);
            setReviewItems(chunks.map((c) => ({ ...c, accepted: true })));
            setPhase('reviewing');
        } catch (err) {
            if (err instanceof AuxNotConfiguredError) {
                setReviewItems([{
                    category: 'background',
                    title: 'Pasted Lore (uncategorized)',
                    body: pastedText.trim(),
                    accepted: true,
                }]);
                setPhase('reviewing');
                toast.info('Aux AI not configured. All text placed in "background" — reassign categories manually.');
            } else {
                setError(err instanceof Error ? err.message : 'Classification failed.');
                setPhase('error');
            }
        } finally {
            setClassifying(false);
        }
    };

    const handleCategoryChange = (idx: number, category: ClassifiedCategory) => {
        setReviewItems((prev) => prev.map((item, i) => i === idx ? { ...item, category } : item));
    };

    const handleTitleChange = (idx: number, title: string) => {
        setReviewItems((prev) => prev.map((item, i) => i === idx ? { ...item, title } : item));
    };

    const handleToggleAccepted = (idx: number) => {
        setReviewItems((prev) => prev.map((item, i) => i === idx ? { ...item, accepted: !item.accepted } : item));
    };

    const handleMerge = () => {
        const accepted = reviewItems.filter((item) => item.accepted);
        if (accepted.length === 0) {
            toast.info('No chunks selected — nothing to merge.');
            return;
        }

        const flatFields = ['background', 'languages', 'powerSystem', 'techEconomy', 'timeline', 'toneBoundaries', 'houseRules'] as const;
        const flatUpdates: Record<string, string> = {};
        const listItems: Record<string, { title: string; body: string }[]> = {
            locations: [],
            cultures: [],
            factions: [],
            threats: [],
            npcs: [],
        };

        for (const chunk of accepted) {
            if (flatFields.includes(chunk.category as typeof flatFields[number])) {
                const key = chunk.category as typeof flatFields[number];
                const existing = flatUpdates[key] || (draft as Record<string, unknown>)[key] as string || '';
                flatUpdates[key] = existing ? `${existing}\n\n${chunk.body}` : chunk.body;
            } else {
                listItems[chunk.category]?.push({ title: chunk.title, body: chunk.body });
            }
        }

        onMerge(flatUpdates as Partial<WorldLoreDraft>, listItems, rawSource);
        toast.success(`Merged ${accepted.length} chunk${accepted.length !== 1 ? 's' : ''} into draft.`);
        onClose();
    };

    const toggleExpand = (id: string) => {
        setExpandedItems((prev) => ({ ...prev, [id]: !prev[id] }));
    };

    return (
        <div className="fixed inset-0 z-[110] flex items-center justify-center" role="dialog" aria-modal="true" aria-label="Import Lore">
            <div className="absolute inset-0 bg-ember/40 backdrop-blur-sm" onClick={onClose} />

            <div className="relative bg-surface border border-border w-full h-full sm:h-[85vh] sm:max-w-2xl sm:mx-4 flex flex-col shadow-2xl overflow-hidden">
                <div className="flex items-center justify-between p-4 border-b border-border shrink-0 bg-void z-10">
                    <h2 className="text-terminal text-sm font-bold tracking-[0.2em] uppercase">
                        Import Lore
                    </h2>
                    <button onClick={onClose} className="text-text-dim hover:text-danger transition-colors">
                        <X size={18} />
                    </button>
                </div>

                <div className="flex-1 overflow-y-auto p-4 sm:p-6">
                    {phase === 'paste' && (
                        <div className="space-y-4">
                            <p className="text-text-dim text-xs">
                                Paste your existing lore text below. The AI will classify it into categories. You can review and reassign before merging.
                            </p>
                            <textarea
                                value={pastedText}
                                onChange={(e) => setPastedText(e.target.value)}
                                placeholder="Paste your world lore here — any format, any length..."
                                rows={14}
                                className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none resize-y min-h-[200px] font-mono"
                                disabled={classifying}
                            />
                            <button
                                onClick={handleClassify}
                                disabled={classifying || !pastedText.trim()}
                                className="w-full bg-terminal/10 border border-terminal/40 text-terminal text-xs uppercase tracking-widest py-2 hover:bg-terminal/20 transition-colors disabled:opacity-50 flex items-center justify-center gap-2"
                            >
                                {classifying ? <><Loader2 size={14} className="animate-spin" /> Classifying...</> : 'Classify with AI'}
                            </button>
                        </div>
                    )}

                    {phase === 'reviewing' && (
                        <div className="space-y-3">
                            <div className="flex items-center justify-between mb-2">
                                <span className="text-text-dim text-xs uppercase tracking-wider">
                                    {reviewItems.length} chunks classified
                                </span>
                                <span className="text-text-dim text-[10px]">
                                    Toggle or reassign before merging
                                </span>
                            </div>

                            {reviewItems.map((item, idx) => {
                                const isExpanded = expandedItems[`${idx}`] ?? false;
                                return (
                                    <div key={idx} className={`border rounded overflow-hidden ${item.accepted ? 'border-border bg-surface' : 'border-border/50 bg-void opacity-60'}`}>
                                        <div className="flex items-center gap-2 p-2">
                                            <button
                                                onClick={() => handleToggleAccepted(idx)}
                                                className={`flex-shrink-0 w-4 h-4 rounded border transition-colors flex items-center justify-center ${
                                                    item.accepted ? 'bg-terminal border-terminal text-void' : 'border-border bg-void'
                                                }`}
                                            >
                                                {item.accepted && <span className="text-[10px]">✓</span>}
                                            </button>
                                            <input
                                                type="text"
                                                value={item.title}
                                                onChange={(e) => handleTitleChange(idx, e.target.value)}
                                                className="flex-1 bg-transparent text-sm text-text-primary focus:outline-none"
                                                placeholder="Title"
                                            />
                                            <select
                                                value={item.category}
                                                onChange={(e) => handleCategoryChange(idx, e.target.value as ClassifiedCategory)}
                                                className="bg-void border border-border px-1 py-0.5 text-[10px] text-text-primary focus:border-terminal focus:outline-none uppercase tracking-wider"
                                            >
                                                {ALL_CATEGORIES.map((cat) => (
                                                    <option key={cat} value={cat}>{CATEGORY_LABELS[cat]}</option>
                                                ))}
                                            </select>
                                            <button
                                                onClick={() => toggleExpand(`${idx}`)}
                                                className="flex-shrink-0 text-text-dim hover:text-terminal transition-colors"
                                            >
                                                {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                                            </button>
                                        </div>
                                        {isExpanded && (
                                            <div className="px-3 pb-3 border-t border-border">
                                                <p className="text-xs text-text-dim whitespace-pre-wrap mt-2">{item.body}</p>
                                            </div>
                                        )}
                                    </div>
                                );
                            })}

                            <button
                                onClick={handleMerge}
                                className="w-full bg-terminal/10 border border-terminal/40 text-terminal text-xs uppercase tracking-widest py-2 hover:bg-terminal/20 transition-colors mt-4"
                            >
                                Add {reviewItems.filter((i) => i.accepted).length} chunk{reviewItems.filter((i) => i.accepted).length !== 1 ? 's' : ''} to draft
                            </button>
                        </div>
                    )}

                    {phase === 'error' && (
                        <div className="space-y-4">
                            <div className="p-3 border border-danger/40 bg-danger/5 rounded">
                                <p className="text-danger text-sm font-bold mb-1">Classification failed</p>
                                <p className="text-text-dim text-xs whitespace-pre-wrap">{error}</p>
                            </div>
                            <button
                                onClick={() => { setPhase('paste'); setError(''); }}
                                className="text-xs text-terminal hover:text-terminal/80 transition-colors"
                            >
                                Try again
                            </button>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
}