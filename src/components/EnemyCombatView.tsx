import { useMemo, useState } from 'react';
import { Minus, Plus, RotateCcw, Trash2 } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { toast } from './Toast';

/** Provides the opt-in, player-controlled combat tools for the active encounter roster. */
export function EnemyCombatView() {
    const {
        enemyCombatConfig: config,
        enemyEncounters,
        enemyInstances,
        setEnemyCombatConfig,
        applyEnemyDamage,
        rollEnemyInitiatives,
        setEnemyInitiative,
        beginEnemyTurn,
        spendEnemyAction,
        addEnemyResource,
        adjustEnemyResource,
        removeEnemyResource,
        clearEnemyCooldown,
    } = useAppStore();
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [damage, setDamage] = useState('0');
    const [damageType, setDamageType] = useState('');
    const [bypassBarrier, setBypassBarrier] = useState(false);
    const [actionName, setActionName] = useState('');
    const [cooldownRounds, setCooldownRounds] = useState('0');
    const [resourceName, setResourceName] = useState('');
    const [resourceMax, setResourceMax] = useState('1');

    const activeEncounter = enemyEncounters.find(encounter => encounter.status === 'active');
    const activeWave = activeEncounter?.waves.find(wave => wave.id === activeEncounter.activeWaveId);
    const roster = useMemo(() => {
        const activeIds = new Set(activeWave?.activeInstanceIds ?? []);
        return enemyInstances.filter(instance => activeIds.has(instance.id));
    }, [activeWave, enemyInstances]);
    const selected = roster.find(instance => instance.id === selectedId) ?? roster[0];

    const numeric = (value: string) => Math.max(0, Number(value) || 0);
    const fieldClass = 'mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case';

    /** Resolves damage and reports the exact tracked outcome without changing narrative state. */
    const resolveDamage = () => {
        if (!selected) return;
        const result = applyEnemyDamage(selected.id, numeric(damage), damageType, bypassBarrier);
        if (!result) return;
        toast.success(
            `${result.adjustedDamage} damage: ${result.barrierDamage} barrier, ${result.hpDamage} HP`
            + (result.weaknessApplied ? ' (weakness)' : '')
            + (result.resistanceApplied ? ' (resistance)' : ''),
        );
    };

    return <div className="flex-1 min-h-0 overflow-y-auto p-5 space-y-5">
        <section className="rounded border border-border p-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-sm font-semibold uppercase tracking-wider">Optional Combat Integration</h3>
                    <p className="mt-1 text-xs text-text-dim">
                        Disabled campaigns retain the manual Phase 2/3 workflow. When enabled, only actions in this console mutate combat state.
                    </p>
                </div>
                <label className="text-xs whitespace-nowrap">
                    <input type="checkbox" checked={config.enabled} onChange={event => setEnemyCombatConfig({ enabled: event.target.checked })} className="mr-2" />
                    Enabled
                </label>
            </div>
            <div className={`mt-4 grid grid-cols-2 lg:grid-cols-4 gap-3 ${config.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
                <label className="text-[10px] uppercase tracking-wider text-text-dim">
                    Initiative
                    <select value={config.initiativeMode} onChange={event => setEnemyCombatConfig({ initiativeMode: event.target.value as typeof config.initiativeMode })} className={fieldClass}>
                        <option value="manual">Manual</option><option value="d20">d20</option><option value="d100">d100</option>
                    </select>
                </label>
                <label className="text-[10px] uppercase tracking-wider text-text-dim">
                    Modifier Stat Name
                    <input value={config.initiativeModifierStat} onChange={event => setEnemyCombatConfig({ initiativeModifierStat: event.target.value })} placeholder="e.g. Dexterity" className={fieldClass} />
                </label>
                <label className="text-[10px] uppercase tracking-wider text-text-dim">
                    Barrier
                    <select value={config.barrierMode} onChange={event => setEnemyCombatConfig({ barrierMode: event.target.value as typeof config.barrierMode })} className={fieldClass}>
                        <option value="absorb-first">Absorb damage first</option><option value="manual">Manual / ignore</option>
                    </select>
                </label>
                <label className="text-[10px] uppercase tracking-wider text-text-dim">
                    Actions per Turn
                    <input type="number" min="0" value={config.defaultActionsPerTurn} onChange={event => setEnemyCombatConfig({ defaultActionsPerTurn: numeric(event.target.value) })} className={fieldClass} />
                </label>
                <label className="text-[10px] uppercase tracking-wider text-text-dim">
                    Weakness Multiplier
                    <input type="number" min="0" step="0.1" value={config.weaknessMultiplier} onChange={event => setEnemyCombatConfig({ weaknessMultiplier: numeric(event.target.value) })} className={fieldClass} />
                </label>
                <label className="text-[10px] uppercase tracking-wider text-text-dim">
                    Resistance Multiplier
                    <input type="number" min="0" step="0.1" value={config.resistanceMultiplier} onChange={event => setEnemyCombatConfig({ resistanceMultiplier: numeric(event.target.value) })} className={fieldClass} />
                </label>
                <div className="flex flex-col gap-2 pt-5 text-xs">
                    <label><input type="checkbox" checked={config.autoDefeatAtZeroHp} onChange={event => setEnemyCombatConfig({ autoDefeatAtZeroHp: event.target.checked })} className="mr-2" />Auto-resolve at 0 HP</label>
                    <label><input type="checkbox" checked={config.actionsEnabled} onChange={event => setEnemyCombatConfig({ actionsEnabled: event.target.checked })} className="mr-2" />Track actions</label>
                </div>
                <div className="flex flex-col gap-2 pt-5 text-xs">
                    <label><input type="checkbox" checked={config.cooldownsEnabled} onChange={event => setEnemyCombatConfig({ cooldownsEnabled: event.target.checked })} className="mr-2" />Track cooldowns</label>
                    <label><input type="checkbox" checked={config.resourcesEnabled} onChange={event => setEnemyCombatConfig({ resourcesEnabled: event.target.checked })} className="mr-2" />Track resources</label>
                </div>
            </div>
        </section>

        {!activeEncounter || !activeWave
            ? <div className="rounded border border-border p-6 text-sm text-text-dim">Activate an encounter and select its current wave to use the combat console.</div>
            : !roster.length
                ? <div className="rounded border border-border p-6 text-sm text-text-dim">No AI-active instances are selected in {activeEncounter.name} / {activeWave.name}.</div>
                : <div className={`grid grid-cols-[15rem_1fr] gap-4 ${config.enabled ? '' : 'opacity-40 pointer-events-none'}`}>
                    <section className="rounded border border-border overflow-hidden">
                        <div className="p-3 border-b border-border">
                            <div className="text-xs font-semibold">{activeEncounter.name}</div>
                            <div className="text-[10px] text-text-dim">{activeWave.name} · AI-active roster</div>
                        </div>
                        {roster.map(instance => <button key={instance.id} onClick={() => setSelectedId(instance.id)} className={`w-full text-left p-3 border-b border-border/50 ${selected?.id === instance.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}>
                            <div className="text-xs font-semibold">{instance.displayName}</div>
                            <div className="text-[10px] text-text-dim">HP {instance.currentHp}/{instance.maxHp} · Barrier {instance.currentBarrier}/{instance.maxBarrier}</div>
                            <div className="text-[10px] text-text-dim">Initiative {instance.initiative ?? '—'}{config.actionsEnabled ? ` · Actions ${instance.actionsRemaining}/${instance.actionsPerTurn}` : ''}</div>
                        </button>)}
                    </section>

                    {selected && <section className="space-y-4">
                        <div className="rounded border border-border p-4">
                            <div className="flex items-center justify-between gap-3">
                                <h3 className="text-sm font-semibold">{selected.displayName}</h3>
                                <button onClick={() => rollEnemyInitiatives(roster.map(instance => instance.id))} disabled={config.initiativeMode === 'manual'} className="px-3 py-2 border border-border rounded text-xs disabled:opacity-30">
                                    <RotateCcw size={12} className="inline mr-1" />Roll Roster Initiative
                                </button>
                            </div>
                            <label className="mt-3 block text-[10px] uppercase tracking-wider text-text-dim">
                                Manual Initiative
                                <input type="number" value={selected.initiative ?? ''} onChange={event => setEnemyInitiative(selected.id, event.target.value === '' ? null : Number(event.target.value))} className={fieldClass} />
                            </label>
                        </div>

                        <div className="rounded border border-border p-4">
                            <h4 className="text-xs font-semibold uppercase tracking-wider">Damage</h4>
                            <div className="mt-3 grid grid-cols-3 gap-3">
                                <label className="text-[10px] uppercase tracking-wider text-text-dim">Amount<input type="number" min="0" value={damage} onChange={event => setDamage(event.target.value)} className={fieldClass} /></label>
                                <label className="text-[10px] uppercase tracking-wider text-text-dim">Type<input value={damageType} onChange={event => setDamageType(event.target.value)} placeholder="Matches weakness/resistance" className={fieldClass} /></label>
                                <div className="flex flex-col justify-end gap-2">
                                    <label className="text-xs"><input type="checkbox" checked={bypassBarrier} onChange={event => setBypassBarrier(event.target.checked)} className="mr-2" />Bypass barrier</label>
                                    <button onClick={resolveDamage} className="px-3 py-2 bg-terminal text-void rounded text-xs font-bold">Apply Damage</button>
                                </div>
                            </div>
                        </div>

                        {config.actionsEnabled && <div className="rounded border border-border p-4">
                            <div className="flex items-center justify-between">
                                <h4 className="text-xs font-semibold uppercase tracking-wider">Actions · {selected.actionsRemaining}/{selected.actionsPerTurn}</h4>
                                <button onClick={() => beginEnemyTurn(selected.id)} className="px-3 py-2 border border-border rounded text-xs">Begin Turn</button>
                            </div>
                            <div className="mt-3 grid grid-cols-[1fr_8rem_auto] gap-3 items-end">
                                <label className="text-[10px] uppercase tracking-wider text-text-dim">Action Name<input value={actionName} onChange={event => setActionName(event.target.value)} className={fieldClass} /></label>
                                <label className="text-[10px] uppercase tracking-wider text-text-dim">Cooldown<input type="number" min="0" value={cooldownRounds} onChange={event => setCooldownRounds(event.target.value)} className={fieldClass} /></label>
                                <button onClick={() => spendEnemyAction(selected.id, actionName, numeric(cooldownRounds))} disabled={selected.actionsRemaining <= 0} className="px-3 py-2 border border-border rounded text-xs disabled:opacity-30">Spend Action</button>
                            </div>
                            {config.cooldownsEnabled && selected.cooldowns.length > 0 && <div className="mt-3 flex flex-wrap gap-2">
                                {selected.cooldowns.map(cooldown => <span key={cooldown.id} className="rounded border border-border px-2 py-1 text-xs">
                                    {cooldown.name}: {cooldown.remainingRounds}
                                    <button onClick={() => clearEnemyCooldown(selected.id, cooldown.id)} title="Clear cooldown" className="ml-2 text-ember">×</button>
                                </span>)}
                            </div>}
                        </div>}

                        {config.resourcesEnabled && <div className="rounded border border-border p-4">
                            <h4 className="text-xs font-semibold uppercase tracking-wider">Resources</h4>
                            <div className="mt-3 grid grid-cols-[1fr_8rem_auto] gap-3 items-end">
                                <label className="text-[10px] uppercase tracking-wider text-text-dim">Name<input value={resourceName} onChange={event => setResourceName(event.target.value)} className={fieldClass} /></label>
                                <label className="text-[10px] uppercase tracking-wider text-text-dim">Maximum<input type="number" min="0" value={resourceMax} onChange={event => setResourceMax(event.target.value)} className={fieldClass} /></label>
                                <button onClick={() => { addEnemyResource(selected.id, resourceName, numeric(resourceMax)); setResourceName(''); }} className="px-3 py-2 border border-border rounded text-xs"><Plus size={12} className="inline mr-1" />Add</button>
                            </div>
                            <div className="mt-3 space-y-2">
                                {selected.resources.map(resource => <div key={resource.id} className="flex items-center gap-2 rounded border border-border p-2 text-xs">
                                    <span className="flex-1">{resource.name}</span><span>{resource.current}/{resource.max}</span>
                                    <button onClick={() => adjustEnemyResource(selected.id, resource.id, -1)} className="p-1 border border-border rounded"><Minus size={12} /></button>
                                    <button onClick={() => adjustEnemyResource(selected.id, resource.id, 1)} className="p-1 border border-border rounded"><Plus size={12} /></button>
                                    <button onClick={() => removeEnemyResource(selected.id, resource.id)} className="p-1 text-ember"><Trash2 size={12} /></button>
                                </div>)}
                            </div>
                        </div>}
                    </section>}
                </div>}
    </div>;
}
