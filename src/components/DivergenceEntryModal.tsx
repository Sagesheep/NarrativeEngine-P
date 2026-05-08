import { useState } from 'react';
import { Zap, Loader2 } from 'lucide-react';
import type { DivergenceCategory, DivergenceEntry, EndpointConfig } from '../types';
import { uid } from '../utils/uid';
import { structureManualEntry } from '../services/divergenceRegister';
import { toast } from './Toast';

type DivergenceEntryModalProps = {
    onAdd: (entry: DivergenceEntry) => void;
    onClose: () => void;
    provider?: EndpointConfig;
};

const CATEGORIES: { value: DivergenceCategory; label: string }[] = [
    { value: 'canon_override', label: 'Canon Override' },
    { value: 'world_change', label: 'World Change' },
    { value: 'entity_state', label: 'NPC / Entity State' },
    { value: 'player_state', label: 'Player State' },
    { value: 'obligation', label: 'Obligation' },
];

export function DivergenceEntryModal({ onAdd, onClose, provider }: DivergenceEntryModalProps) {
    const [subject, setSubject] = useState('');
    const [divergence, setDivergence] = useState('');
    const [category, setCategory] = useState<DivergenceCategory>('entity_state');
    const [freeText, setFreeText] = useState('');
    const [structuring, setStructuring] = useState(false);

    const handleSubmit = () => {
        if (!subject.trim() || !divergence.trim()) return;
        onAdd({
            id: `div_${uid()}`,
            category,
            subject: subject.trim(),
            divergence: divergence.trim(),
            sceneRef: 'manual',
            linkedSceneIds: ['manual'],
            importance: 7,
            source: 'manual',
        });
        onClose();
    };

    const handleAIStructure = async () => {
        if (!freeText.trim() || !provider) return;
        setStructuring(true);
        try {
            const result = await structureManualEntry(provider, freeText);
            if (result) {
                setSubject(result.subject);
                setDivergence(result.divergence);
                setCategory(result.category);
            }
        } catch (e) {
            console.warn('[DivergenceEntry] AI structure failed:', e);
            toast.error('AI structuring failed — please fill in manually');
        }
        setStructuring(false);
    };

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-void/80 backdrop-blur-sm" onClick={onClose}>
            <div className="bg-surface border border-border rounded p-4 w-[90vw] max-w-md space-y-3" onClick={e => e.stopPropagation()}>
                <div className="flex items-center gap-2 mb-2">
                    <Zap size={14} className="text-amber-400" />
                    <span className="text-[10px] text-amber-400 uppercase tracking-widest font-bold">Add Divergence</span>
                </div>

                <div>
                    <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Subject</label>
                    <input
                        type="text"
                        value={subject}
                        onChange={e => setSubject(e.target.value)}
                        className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                        placeholder="Goblin King Grak"
                    />
                </div>

                <div>
                    <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Divergence</label>
                    <input
                        type="text"
                        value={divergence}
                        onChange={e => setDivergence(e.target.value)}
                        className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                        placeholder="Now allied with player"
                    />
                </div>

                <div>
                    <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Category</label>
                    <select
                        value={category}
                        onChange={e => setCategory(e.target.value as DivergenceCategory)}
                        className="w-full bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                    >
                        {CATEGORIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
                    </select>
                </div>

                {provider && (
                    <div className="border-t border-border pt-3">
                        <label className="block text-[10px] text-text-dim uppercase tracking-wider mb-1">Or describe it in your own words</label>
                        <div className="flex gap-2">
                            <input
                                type="text"
                                value={freeText}
                                onChange={e => setFreeText(e.target.value)}
                                className="flex-1 bg-void border border-border px-3 py-2 text-sm text-text-primary focus:border-amber-400 focus:outline-none"
                                placeholder="Grak promised his army if I free his brother..."
                            />
                            <button
                                onClick={handleAIStructure}
                                disabled={structuring || !freeText.trim()}
                                className="flex items-center gap-1 bg-amber-500/20 text-amber-400 px-3 py-2 text-[10px] uppercase tracking-wider border border-amber-500/30 rounded hover:bg-amber-500/30 disabled:opacity-40"
                            >
                                {structuring ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
                                AI Structure
                            </button>
                        </div>
                    </div>
                )}

                <div className="flex gap-2 pt-2">
                    <button
                        onClick={handleSubmit}
                        disabled={!subject.trim() || !divergence.trim()}
                        className="flex-1 bg-amber-500/20 text-amber-400 py-2 text-[11px] uppercase tracking-wider border border-amber-500/30 rounded hover:bg-amber-500/30 disabled:opacity-40"
                    >
                        Add Entry
                    </button>
                    <button
                        onClick={onClose}
                        className="flex-1 bg-void text-text-dim py-2 text-[11px] uppercase tracking-wider border border-border rounded hover:text-text-primary"
                    >
                        Cancel
                    </button>
                </div>
            </div>
        </div>
    );
}
