import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, Trash2 } from 'lucide-react';
import type { WorldLoreItem } from '../types';
import { LoreTextarea } from './LoreTextarea';

type ListKey = 'locations' | 'cultures' | 'factions' | 'threats' | 'npcs';

type AccordionListProps = {
    items: WorldLoreItem[];
    listKey: ListKey;
    noun: string;
    placeholder: string;
    categoryLabel: string;
    onUpdateItem: (listKey: ListKey, itemId: string, patch: Partial<WorldLoreItem>) => void;
    onRemoveItem: (listKey: ListKey, itemId: string) => void;
    onAddItem: (listKey: ListKey) => void;
};

export function AccordionList({ items, listKey, noun, placeholder, categoryLabel, onUpdateItem, onRemoveItem, onAddItem }: AccordionListProps) {
    const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>({});
    const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

    const toggleItem = (itemId: string) => {
        setExpandedItems((prev) => ({ ...prev, [itemId]: !prev[itemId] }));
    };

    const handleDelete = (itemId: string) => {
        if (confirmDeleteId === itemId) {
            onRemoveItem(listKey, itemId);
            setConfirmDeleteId(null);
            setExpandedItems((prev) => {
                const next = { ...prev };
                delete next[itemId];
                return next;
            });
        } else {
            setConfirmDeleteId(itemId);
        }
    };

    const handleDeleteBlur = (itemId: string) => {
        if (confirmDeleteId === itemId) {
            setConfirmDeleteId(null);
        }
    };

    return (
        <div className="space-y-2">
            {items.length === 0 && (
                <p className="text-text-dim text-xs italic">No {noun}s yet.</p>
            )}
            {items.map((item) => {
                const isExpanded = expandedItems[item.id] ?? false;
                const isConfirming = confirmDeleteId === item.id;
                return (
                    <div key={item.id} className="border border-border rounded bg-surface overflow-hidden">
                        <div className="flex items-center gap-1">
                            <button
                                onClick={() => toggleItem(item.id)}
                                className="flex-shrink-0 p-2 text-text-dim hover:text-terminal transition-colors"
                            >
                                {isExpanded ? <ChevronDown size={14} className="text-terminal" /> : <ChevronRight size={14} />}
                            </button>
                            <input
                                type="text"
                                value={item.title}
                                onChange={(e) => onUpdateItem(listKey, item.id, { title: e.target.value })}
                                placeholder={`${noun} name`}
                                className="flex-1 bg-transparent px-1 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:outline-none"
                            />
                            <button
                                onClick={() => handleDelete(item.id)}
                                onBlur={() => handleDeleteBlur(item.id)}
                                className={`flex-shrink-0 px-2 py-1 transition-colors text-[10px] uppercase tracking-wider ${
                                    isConfirming
                                        ? 'bg-danger/20 text-danger border border-danger/60 hover:bg-danger/30'
                                        : 'text-text-dim hover:text-danger'
                                }`}
                                title={`Delete ${noun}`}
                            >
                                {isConfirming ? 'Confirm?' : <Trash2 size={12} />}
                            </button>
                        </div>
                        {isExpanded && (
                            <div className="px-3 pb-3 border-t border-border bg-void">
                                <LoreTextarea
                                    value={item.body}
                                    onChange={(v) => onUpdateItem(listKey, item.id, { body: v })}
                                    placeholder={placeholder}
                                    rows={4}
                                    category={`${categoryLabel}${item.title ? ` — ${item.title}` : ''}`}
                                    className="w-full bg-surface border border-border px-3 py-2 text-sm text-text-primary placeholder:text-text-dim/40 focus:border-terminal focus:outline-none resize-y mt-2"
                                />
                            </div>
                        )}
                    </div>
                );
            })}
            <button
                onClick={() => onAddItem(listKey)}
                className="flex items-center gap-1 text-xs text-terminal hover:text-terminal/80 transition-colors"
            >
                <Plus size={12} /> Add {noun}
            </button>
        </div>
    );
}