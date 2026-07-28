import { useState } from 'react';
import { Archive, Trash2, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { EnemyEncounter, EnemyEncounterOutcome, EnemyInstanceDisposition } from '../types';
import { suggestEnemyResolution } from '../services/enemy/enemyResolution';
import { toast } from './Toast';

type EnemyResolutionDialogProps = {
    encounter: EnemyEncounter;
    onClose: () => void;
};

/** Converts multiline reward editors into trimmed, non-empty entries. */
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);

/** Collects player-confirmed outcome and rewards before irreversible instance cleanup. */
export function EnemyResolutionDialog({ encounter, onClose }: EnemyResolutionDialogProps) {
    const { enemyInstances, resolveEnemyEncounter } = useAppStore();
    const suggestion = suggestEnemyResolution(encounter, enemyInstances);
    const [outcome, setOutcome] = useState<EnemyEncounterOutcome>(suggestion.outcome);
    const [summary, setSummary] = useState(suggestion.summary);
    const [xpAwarded, setXpAwarded] = useState(String(suggestion.xpAwarded));
    const [lootAwarded, setLootAwarded] = useState(suggestion.lootAwarded.join('\n'));
    const [otherRewards, setOtherRewards] = useState('');
    const [instanceDisposition, setInstanceDisposition] = useState<EnemyInstanceDisposition>('archive');
    const [createTimelineEvent, setCreateTimelineEvent] = useState(true);
    const [saving, setSaving] = useState(false);

    /** Freezes the resolution, removes live instances, and optionally records the timeline event. */
    const confirm = async () => {
        setSaving(true);
        try {
            const resolution = await resolveEnemyEncounter(encounter.id, {
                outcome,
                summary,
                xpAwarded: Math.max(0, Number(xpAwarded) || 0),
                lootAwarded: lines(lootAwarded),
                otherRewards: lines(otherRewards),
                instanceDisposition,
                createTimelineEvent,
            });
            if (!resolution) return toast.error('This encounter could not be resolved');
            toast.success(`${encounter.name} resolved`);
            onClose();
        } finally {
            setSaving(false);
        }
    };

    const fieldClass = 'mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case';

    return <div className="fixed inset-0 z-[60] bg-black/75 grid place-items-center p-4">
        <div className="w-full max-w-2xl max-h-[88vh] overflow-y-auto bg-void-lighter border border-border rounded">
            <header className="p-4 border-b border-border flex items-center justify-between">
                <div>
                    <h3 className="font-bold uppercase tracking-wider">Resolve Encounter</h3>
                    <p className="text-xs text-text-dim mt-1">{encounter.name}</p>
                </div>
                <button onClick={onClose} disabled={saving}><X size={18} /></button>
            </header>

            <div className="p-5 space-y-4">
                <p className="rounded border border-terminal/30 bg-terminal/5 p-3 text-xs text-text-dim">
                    Review these suggestions before confirming. Resolution is explicit: the story AI cannot award XP, remove instances, or archive combat state by narration alone.
                </p>

                <div className="grid grid-cols-2 gap-4">
                    <label className="text-[10px] uppercase tracking-wider text-text-dim">
                        Outcome
                        <select value={outcome} onChange={event => setOutcome(event.target.value as EnemyEncounterOutcome)} className={fieldClass}>
                            <option value="victory">Victory</option>
                            <option value="partial">Partial Result</option>
                            <option value="defeat">Defeat</option>
                            <option value="escaped">Escaped / Withdrew</option>
                            <option value="negotiated">Negotiated / Nonviolent</option>
                            <option value="other">Other</option>
                        </select>
                    </label>
                    <label className="text-[10px] uppercase tracking-wider text-text-dim">
                        XP Awarded
                        <input type="number" min="0" value={xpAwarded} onChange={event => setXpAwarded(event.target.value)} className={fieldClass} />
                    </label>
                </div>

                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Encounter Summary
                    <textarea value={summary} onChange={event => setSummary(event.target.value)} rows={5} className={fieldClass} />
                </label>

                <div className="grid grid-cols-2 gap-4">
                    <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                        Loot Awarded <span className="normal-case">(one per line)</span>
                        <textarea value={lootAwarded} onChange={event => setLootAwarded(event.target.value)} rows={5} className={fieldClass} />
                    </label>
                    <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                        Other Rewards <span className="normal-case">(one per line)</span>
                        <textarea value={otherRewards} onChange={event => setOtherRewards(event.target.value)} rows={5} className={fieldClass} />
                    </label>
                </div>

                <fieldset className="rounded border border-border p-4">
                    <legend className="px-1 text-[10px] uppercase tracking-wider text-text-dim">Runtime Instance Data</legend>
                    <label className="flex gap-3 text-xs">
                        <input type="radio" checked={instanceDisposition === 'archive'} onChange={() => setInstanceDisposition('archive')} />
                        <span><Archive size={13} className="inline mr-1" />Archive full final HP, barriers, conditions, cooldowns, and resources inside this resolution.</span>
                    </label>
                    <label className="flex gap-3 text-xs mt-3">
                        <input type="radio" checked={instanceDisposition === 'discard'} onChange={() => setInstanceDisposition('discard')} />
                        <span><Trash2 size={13} className="inline mr-1" />Discard runtime data after retaining participant names and the summary.</span>
                    </label>
                </fieldset>

                <label className="block text-xs">
                    <input type="checkbox" checked={createTimelineEvent} onChange={event => setCreateTimelineEvent(event.target.checked)} className="mr-2" />
                    Add this resolution and its rewards to the campaign timeline/archive context
                </label>
            </div>

            <footer className="p-4 border-t border-border flex justify-end gap-2">
                <button onClick={onClose} disabled={saving} className="px-4 py-2 border border-border rounded text-xs">Cancel</button>
                <button onClick={() => void confirm()} disabled={saving} className="px-4 py-2 bg-terminal text-void rounded text-xs font-bold disabled:opacity-40">
                    {saving ? 'Resolving…' : 'Confirm Resolution'}
                </button>
            </footer>
        </div>
    </div>;
}
