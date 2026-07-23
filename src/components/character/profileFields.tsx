import { Trash2, AlertCircle } from 'lucide-react';
import type { CharacterTrait, DivergenceCategory, SceneEventType } from '../../types';
import { TRAIT_CATEGORIES, TRAIT_EVENT_TAGS, TRAIT_CATEGORY_LABELS } from './profileConstants';

export function TraitRow({ trait, onChange, onSupersede, onRemove }: {
    trait: CharacterTrait;
    onChange: (patch: Partial<CharacterTrait>) => void;
    onSupersede: () => void;
    onRemove: () => void;
}) {
    const toggleTag = (tag: SceneEventType) => {
        const has = trait.eventTags.includes(tag);
        onChange({
            eventTags: has
                ? trait.eventTags.filter(t => t !== tag)
                : [...trait.eventTags, tag],
        });
    };

    return (
        <div className="space-y-1 bg-void-dark/40 border border-border/40 rounded px-2 py-1.5">
            <div className="flex items-start gap-2">
                <textarea
                    value={trait.text}
                    onChange={(e) => onChange({ text: e.target.value })}
                    rows={1}
                    placeholder="Trait text..."
                    className="flex-1 bg-void-dark border border-border/40 rounded px-2 py-1 text-[11px] text-text-bright resize-none min-h-[28px]"
                />
                <input
                    type="number"
                    min={1}
                    max={10}
                    value={trait.importance}
                    onChange={(e) => onChange({ importance: Math.max(1, Math.min(10, Number(e.target.value) || 5)) })}
                    className="w-10 bg-void-dark border border-border/40 rounded px-1 py-1 text-[10px] text-text-bright text-center"
                    title="Importance (1-10)"
                />
                <button onClick={onSupersede} className="text-text-dim/50 hover:text-ember" title="Mark superseded">
                    <AlertCircle size={11} />
                </button>
                <button onClick={onRemove} className="text-text-dim/50 hover:text-red-400" title="Delete">
                    <Trash2 size={11} />
                </button>
            </div>
            <div className="flex flex-wrap gap-1 items-center">
                <select
                    value={trait.category}
                    onChange={(e) => onChange({ category: e.target.value as DivergenceCategory })}
                    className="bg-void-dark border border-border/40 rounded px-1.5 py-0.5 text-[9px] text-text-dim uppercase tracking-wider"
                >
                    {TRAIT_CATEGORIES.map(c => <option key={c} value={c}>{TRAIT_CATEGORY_LABELS[c]}</option>)}
                </select>
                {TRAIT_EVENT_TAGS.map(tag => {
                    const active = trait.eventTags.includes(tag);
                    return (
                        <button
                            key={tag}
                            onClick={() => toggleTag(tag)}
                            className={`px-1.5 py-0.5 rounded text-[8px] uppercase tracking-wider transition-colors ${
                                active ? 'bg-terminal/20 text-terminal border border-terminal/40' : 'bg-void-dark/50 text-text-dim/40 border border-border/20 hover:text-text-dim'
                            }`}
                        >
                            {tag}
                        </button>
                    );
                })}
            </div>
        </div>
    );
}

export function IdentityFields({ identity, onChange, disabled, hideLevel }: {
    identity: { name?: string; race?: string; class?: string; archetype?: string; level?: number };
    onChange: (patch: Partial<typeof identity>) => void;
    disabled?: boolean;
    hideLevel?: boolean;
}) {
    return (
        <div className="grid grid-cols-2 gap-2">
            <input
                type="text"
                value={identity.name || ''}
                onChange={(e) => onChange({ name: e.target.value })}
                placeholder="Name"
                disabled={disabled}
                className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright disabled:opacity-70"
            />
            <input
                type="text"
                value={identity.race || ''}
                onChange={(e) => onChange({ race: e.target.value })}
                placeholder="Race"
                disabled={disabled}
                className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright disabled:opacity-70"
            />
            <input
                type="text"
                value={identity.class || ''}
                onChange={(e) => onChange({ class: e.target.value })}
                placeholder="Class"
                disabled={disabled}
                className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright disabled:opacity-70"
            />
            <input
                type="text"
                value={identity.archetype || ''}
                onChange={(e) => onChange({ archetype: e.target.value })}
                placeholder="Archetype"
                disabled={disabled}
                className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright disabled:opacity-70"
            />
            {!hideLevel && (
                <input
                    type="number"
                    value={identity.level ?? ''}
                    onChange={(e) => onChange({ level: e.target.value ? Number(e.target.value) : undefined })}
                    placeholder="Level"
                    disabled={disabled}
                    className="bg-void-dark border border-border rounded px-2 py-1 text-[12px] text-text-bright disabled:opacity-70"
                />
            )}
        </div>
    );
}