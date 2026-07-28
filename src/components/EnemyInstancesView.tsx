import { useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { EnemyInstance, EnemyModifier } from '../types';
import { toast } from './Toast';

/** Converts a multiline editor into trimmed, non-empty condition names. */
const lines = (value: string) => value.split('\n').map(line => line.trim()).filter(Boolean);

/** Parses temporary modifiers from "name: value" lines while retaining row IDs. */
function modifiers(value: string, current: EnemyModifier[]): EnemyModifier[] {
    return lines(value).map((line, index) => {
        const [name, ...rest] = line.split(':');
        return { id: current[index]?.id ?? crypto.randomUUID(), name: name.trim(), value: rest.join(':').trim() };
    });
}

type EnemyInstancesViewProps = {
    selectedTemplateId: string | null;
};

/**
 * Edits mutable encounter copies while showing their frozen template origin.
 * The encounter roster separately controls whether a copy enters the AI prompt.
 */
export function EnemyInstancesView({ selectedTemplateId }: EnemyInstancesViewProps) {
    const {
        enemyCompendium, enemyInstances, spawnEnemyInstance,
        updateEnemyInstance, removeEnemyInstance,
    } = useAppStore();
    const [selectedInstanceId, setSelectedInstanceId] = useState<string | null>(null);
    const [modifierDrafts, setModifierDrafts] = useState<Record<string, string>>({});

    const selectedTemplate = enemyCompendium.find(enemy => enemy.id === selectedTemplateId);
    const sorted = useMemo(
        () => [...enemyInstances].sort((a, b) => b.createdAt - a.createdAt),
        [enemyInstances],
    );
    const selected = enemyInstances.find(instance => instance.id === selectedInstanceId) ?? sorted[0];

    /** Creates a new copy from the template selected in the left-hand list. */
    const spawn = () => {
        if (!selectedTemplate) return toast.warning('Select an enemy template first');
        const instance = spawnEnemyInstance(selectedTemplate.id);
        if (!instance) return toast.error('Could not create enemy instance');
        setSelectedInstanceId(instance.id);
        toast.success(`Created ${instance.displayName}`);
    };

    /** Applies a partial edit to the selected instance without touching its snapshot. */
    const update = (patch: Partial<EnemyInstance>) => {
        if (selected) updateEnemyInstance(selected.id, patch);
    };

    /** Converts a numeric input to a finite, non-negative encounter value. */
    const numberValue = (value: string) => Math.max(0, Number(value) || 0);

    return <div className="flex-1 flex min-w-0">
        <section className="w-64 border-r border-border flex flex-col">
            <div className="p-3 border-b border-border">
                <button onClick={spawn} disabled={!selectedTemplate} className="w-full px-3 py-2 bg-terminal text-void rounded text-xs font-bold disabled:opacity-30">
                    <Plus size={13} className="inline mr-1" />
                    {selectedTemplate ? `Create ${selectedTemplate.name}` : 'Select a template'}
                </button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {sorted.map(instance => <button
                    key={instance.id}
                    onClick={() => setSelectedInstanceId(instance.id)}
                    className={`w-full text-left p-3 border-b border-border/50 ${selected?.id === instance.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}
                >
                    <div className="font-semibold text-sm">{instance.displayName}</div>
                    <div className="text-[10px] text-text-dim">
                        HP {instance.currentHp}/{instance.maxHp} · Barrier {instance.currentBarrier}/{instance.maxBarrier}
                    </div>
                    {instance.defeated && <div className="text-[10px] uppercase text-ember mt-1">Defeated</div>}
                </button>)}
                {!sorted.length && <p className="p-4 text-xs text-text-dim">Select a template on the left and create the first encounter copy.</p>}
            </div>
        </section>

        <section className="flex-1 min-w-0 flex flex-col">
            {!selected ? <div className="flex-1 grid place-items-center p-8 text-sm text-text-dim">
                No enemy instances are active.
            </div> : <>
                <div className="flex-1 overflow-y-auto p-5">
                    <div className="mb-4 rounded border border-terminal/30 bg-terminal/5 p-3 text-xs text-text-dim">
                        This copy uses a frozen snapshot of <span className="text-text-normal">{selected.templateSnapshot.name}</span>.
                        It reaches the story AI only when explicitly selected in an active encounter wave.
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                        <label className="col-span-2 block text-[10px] uppercase tracking-wider text-text-dim">
                            Display Name
                            <input value={selected.displayName} onChange={event => update({ displayName: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                            Current HP
                            <input type="number" min="0" value={selected.currentHp} onChange={event => update({ currentHp: numberValue(event.target.value) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                            Maximum HP
                            <input type="number" min="0" value={selected.maxHp} onChange={event => update({ maxHp: numberValue(event.target.value) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                            Current Barrier
                            <input type="number" min="0" value={selected.currentBarrier} onChange={event => update({ currentBarrier: numberValue(event.target.value) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                            Maximum Barrier
                            <input type="number" min="0" value={selected.maxBarrier} onChange={event => update({ maxBarrier: numberValue(event.target.value) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                            Conditions <span className="normal-case">(one per line)</span>
                            <textarea value={selected.conditions.join('\n')} onChange={event => update({ conditions: lines(event.target.value) })} rows={6} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                            Temporary Modifiers <span className="normal-case">(Name: value)</span>
                            <textarea
                                value={modifierDrafts[selected.id] ?? selected.temporaryModifiers.map(modifier => `${modifier.name}: ${modifier.value}`).join('\n')}
                                onChange={event => {
                                    const value = event.target.value;
                                    setModifierDrafts(drafts => ({ ...drafts, [selected.id]: value }));
                                    update({ temporaryModifiers: modifiers(value, selected.temporaryModifiers) });
                                }}
                                rows={6}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            />
                        </label>
                        <label className="col-span-2 text-xs">
                            <input type="checkbox" checked={selected.defeated} onChange={event => update({ defeated: event.target.checked })} className="mr-2" />
                            Mark defeated, removed, surrendered, or otherwise resolved
                        </label>
                    </div>
                </div>
                <footer className="p-4 border-t border-border flex justify-end">
                    <button onClick={() => {
                        removeEnemyInstance(selected.id);
                        setSelectedInstanceId(null);
                    }} className="px-3 py-2 border border-ember text-ember rounded text-xs">
                        <Trash2 size={13} className="inline mr-1" />Delete Instance
                    </button>
                </footer>
            </>}
        </section>
    </div>;
}
