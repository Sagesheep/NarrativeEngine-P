import { useState } from 'react';
import { X, Sparkles, Loader2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { sendMessage } from '../services/llm/llmService';
import { extractJson } from '../services/infrastructure/jsonExtract';
import { CATEGORY_LABELS, coerceCategory } from '../services/campaign-state/divergenceRegister';
import { uid } from '../utils/uid';
import { toast } from './Toast';
import type { DivergenceCategory, DivergenceEntry } from '../types';

const CATEGORIES: DivergenceCategory[] = ['locations', 'npc_events', 'promises_debts', 'world_state', 'party_facts', 'rules_lore', 'misc'];

const STRUCTURE_PROMPT = `You are a structured data extractor for a tabletop RPG campaign. Given a free-form description of a campaign fact, output a JSON object with exactly two fields:
- "category": one of [locations, npc_events, promises_debts, world_state, party_facts, rules_lore, misc]
- "fact": a concise one-line canonical statement of the fact, in the format "Subject —predicate→ Object" where appropriate.

Example input: "Aldric killed the Goblin King in the Northern Wastes"
Example output: {"category": "npc_events", "fact": "Aldric —killed→ Goblin King [location: Northern Wastes]"}

Respond ONLY with the JSON object, no explanation.`;

export function DivergenceReviewModal() {
    const open = useAppStore(s => s.divergenceEntryOpen);
    const addDivergenceEntry = useAppStore(s => s.addDivergenceEntry);
    const closeDivergenceEntry = useAppStore(s => s.closeDivergenceEntry);

    const [factText, setFactText] = useState('');
    const [category, setCategory] = useState<DivergenceCategory | ''>('');
    const [isStructuring, setIsStructuring] = useState(false);

    if (!open) return null;

    const handleStructure = async () => {
        if (!factText.trim()) return;
        setIsStructuring(true);
        try {
            const provider = useAppStore.getState().getActiveUtilityEndpoint() ?? useAppStore.getState().getActiveStoryEndpoint();
            if (!provider) {
                toast.error('No AI provider configured');
                setIsStructuring(false);
                return;
            }
            const raw = await new Promise<string>((resolve, reject) => {
                sendMessage(
                    provider,
                    [{ role: 'user', content: `${STRUCTURE_PROMPT}\n\nFact: ${factText.trim()}` }],
                    () => {},
                    (text) => resolve(text),
                    (err) => reject(new Error(err)),
                    undefined,
                    undefined,
                    { temperature: 0.3, max_tokens: 256 },
                );
            });
            const jsonStr = extractJson(raw);
            const parsed = JSON.parse(jsonStr);
            if (parsed.category) setCategory(coerceCategory(parsed.category));
            if (parsed.fact) setFactText(parsed.fact);
        } catch {
            toast.error('Failed to structure fact');
        }
        setIsStructuring(false);
    };

    const handleSubmit = () => {
        if (!factText.trim() || !category) return;
        const entry: DivergenceEntry = {
            id: uid(),
            chapterId: '',
            category,
            text: factText.trim(),
            sceneRef: 'manual',
            npcIds: [],
            pinned: false,
            source: 'manual',
        };
        addDivergenceEntry(entry);
        setFactText('');
        setCategory('');
        closeDivergenceEntry();
        toast.info('Fact added to divergence register');
    };

    const handleClose = () => {
        setFactText('');
        setCategory('');
        closeDivergenceEntry();
    };

    return (
        <div
            data-motion="overlay" className="fixed inset-0 z-[150] flex items-center justify-center bg-black/80 backdrop-blur-sm p-4"
            onClick={handleClose}
        >
            <div
                className="bg-void-darker border border-border max-w-lg w-full rounded font-mono text-sm"
                onClick={(e) => e.stopPropagation()}
            >
                <div className="flex items-center justify-between p-3 border-b border-border">
                    <span className="text-[10px] uppercase tracking-widest text-amber-400">◆ Add Campaign Fact</span>
                    <button onClick={handleClose} className="text-text-dim hover:text-text-primary">
                        <X size={14} />
                    </button>
                </div>

                <div className="p-4 space-y-4">
                    <div>
                        <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">
                            Fact description
                        </label>
                        <textarea
                            value={factText}
                            onChange={(e) => setFactText(e.target.value)}
                            placeholder="e.g. Aldric killed the Goblin King in the Northern Wastes"
                            rows={3}
                            className="w-full bg-void border border-border p-2 text-xs font-mono placeholder:text-text-dim/50 focus:outline-none focus:border-amber-500/40 rounded resize-y"
                        />
                    </div>

                    <div>
                        <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">
                            Category
                        </label>
                        <div className="flex flex-wrap gap-1">
                            {CATEGORIES.map(cat => (
                                <button
                                    key={cat}
                                    onClick={() => setCategory(cat)}
                                    className={`text-[9px] uppercase tracking-wider px-2 py-1 rounded border transition-colors ${
                                        category === cat
                                            ? 'bg-amber-500/15 border-amber-500/50 text-amber-400'
                                            : 'border-border text-text-dim hover:text-text-primary hover:border-amber-500/30'
                                    }`}
                                >
                                    {CATEGORY_LABELS[cat]}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className="flex gap-2">
                        <button
                            onClick={handleStructure}
                            disabled={isStructuring || !factText.trim()}
                            className="text-[10px] uppercase tracking-widest border border-amber-500 text-amber-400 px-3 py-1.5 rounded hover:bg-amber-500/10 flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            {isStructuring ? <Loader2 size={10} className="animate-spin" /> : <Sparkles size={10} />}
                            AI Structure
                        </button>
                        <button
                            onClick={handleSubmit}
                            disabled={!factText.trim() || !category}
                            className="text-[10px] uppercase tracking-widest bg-amber-500/10 border border-amber-500 text-amber-400 px-3 py-1.5 rounded hover:bg-amber-500/20 flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed"
                        >
                            Add Fact
                        </button>
                        <button
                            onClick={handleClose}
                            className="text-[10px] uppercase tracking-widest border border-border text-text-dim px-3 py-1.5 rounded hover:text-text-primary"
                        >
                            Cancel
                        </button>
                    </div>

                    <p className="text-[8px] text-text-dim leading-tight">
                        Manual facts are marked with source=manual and sceneRef=manual. Use "AI Structure" to auto-detect category and format.
                    </p>
                </div>
            </div>
        </div>
    );
}