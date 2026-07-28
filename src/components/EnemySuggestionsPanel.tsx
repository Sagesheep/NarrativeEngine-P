import { Check, Lightbulb, Trash2, X } from 'lucide-react';
import type { EnemyEntry } from '../types';
import { canonicalEnemyName, createEmptyEnemyEntry } from '../services/enemy/enemySchema';
import { useAppStore } from '../store/useAppStore';
import { toast } from './Toast';

type EnemySuggestionsPanelProps = {
    onAccepted: (enemy: EnemyEntry) => void;
};

/**
 * Review queue for post-turn enemy discovery. Editing remains local store state;
 * only Accept mutates the persisted compendium.
 */
export function EnemySuggestionsPanel({ onAccepted }: EnemySuggestionsPanelProps) {
    const {
        enemySuggestions,
        enemyCompendium,
        addEnemy,
        updateEnemy,
        updateEnemySuggestion,
        dismissEnemySuggestion,
        clearEnemySuggestions,
    } = useAppStore();

    if (!enemySuggestions.length) return null;

    const accept = (id: string) => {
        const suggestion = enemySuggestions.find(candidate => candidate.id === id);
        if (!suggestion) return;
        const name = suggestion.name.trim();
        if (!name) return toast.warning('Suggestion name is required');

        if (suggestion.kind === 'alias') {
            const target = enemyCompendium.find(enemy => enemy.id === suggestion.targetEnemyId);
            if (!target) return toast.warning('Choose an existing enemy for this alias');
            const aliases = (target.aliases || '').split(',').map(value => value.trim()).filter(Boolean);
            const alreadyKnown = [target.name, ...aliases].some(value => canonicalEnemyName(value) === canonicalEnemyName(name));
            const nextAliases = alreadyKnown ? aliases : [...aliases, name];
            const updated = { ...target, aliases: nextAliases.join(', '), updatedAt: Date.now() };
            updateEnemy(target.id, updated);
            dismissEnemySuggestion(id);
            onAccepted(updated);
            toast.success(alreadyKnown ? `${name} is already known` : `Added ${name} as an alias for ${target.name}`);
            return;
        }

        const existing = enemyCompendium.find(enemy =>
            [enemy.name, ...(enemy.aliases || '').split(',')].some(value => canonicalEnemyName(value) === canonicalEnemyName(name)));
        if (existing) {
            dismissEnemySuggestion(id);
            onAccepted(existing);
            toast.warning(`${name} is already in the compendium`);
            return;
        }
        const created = createEmptyEnemyEntry(name, suggestion.classification ?? '');
        addEnemy(created);
        dismissEnemySuggestion(id);
        onAccepted(created);
        toast.success(`Created ${name}; complete any campaign-specific fields before saving`);
    };

    return (
        <section className="mx-3 mb-2 border border-amber-400/30 rounded bg-amber-400/5 overflow-hidden">
            <div className="flex items-center gap-2 px-2.5 py-2 text-[10px] uppercase tracking-wider text-amber-300">
                <Lightbulb size={12} />
                Enemy suggestions ({enemySuggestions.length})
                <button onClick={clearEnemySuggestions} title="Dismiss all suggestions" className="ml-auto hover:text-red-400">
                    <Trash2 size={12} />
                </button>
            </div>
            <div className="max-h-64 overflow-y-auto border-t border-amber-400/20">
                {enemySuggestions.map(suggestion => (
                    <div key={suggestion.id} className="p-2 border-b border-border/50 last:border-b-0 space-y-1.5">
                        <div className="flex items-center gap-1.5">
                            <span className="text-[9px] uppercase text-amber-300 w-9">{suggestion.kind}</span>
                            <input
                                value={suggestion.name}
                                onChange={event => updateEnemySuggestion(suggestion.id, { name: event.target.value })}
                                className="min-w-0 flex-1 bg-void border border-border rounded px-1.5 py-1 text-xs"
                            />
                        </div>
                        {suggestion.kind === 'alias' ? (
                            <select
                                value={suggestion.targetEnemyId ?? ''}
                                onChange={event => updateEnemySuggestion(suggestion.id, { targetEnemyId: event.target.value })}
                                className="w-full bg-void border border-border rounded px-1.5 py-1 text-[10px]"
                            >
                                <option value="">Choose existing enemy…</option>
                                {enemyCompendium.map(enemy => <option key={enemy.id} value={enemy.id}>{enemy.name}</option>)}
                            </select>
                        ) : (
                            <input
                                value={suggestion.classification ?? ''}
                                onChange={event => updateEnemySuggestion(suggestion.id, { classification: event.target.value })}
                                placeholder="Classification (optional)"
                                className="w-full bg-void border border-border rounded px-1.5 py-1 text-[10px]"
                            />
                        )}
                        {suggestion.reason && <p className="text-[9px] leading-snug text-text-dim">{suggestion.reason}</p>}
                        <div className="flex justify-end gap-1">
                            <button onClick={() => accept(suggestion.id)} title="Accept suggestion" className="p-1 text-terminal hover:bg-terminal/10 rounded">
                                <Check size={13} />
                            </button>
                            <button onClick={() => dismissEnemySuggestion(suggestion.id)} title="Reject suggestion" className="p-1 text-text-dim hover:text-red-400 rounded">
                                <X size={13} />
                            </button>
                        </div>
                    </div>
                ))}
            </div>
        </section>
    );
}
