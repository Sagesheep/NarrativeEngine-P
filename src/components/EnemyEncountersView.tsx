import { useMemo, useState } from 'react';
import { Pause, Play, Plus, Square, UserPlus } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import { toast } from './Toast';
import { EnemyResolutionDialog } from './EnemyResolutionDialog';

type EnemyEncountersViewProps = {
    selectedTemplateId: string | null;
};

/**
 * Manages saved encounters, waves, roster membership, prompt-active enemies,
 * reinforcements, and lifecycle state without resolving combat mechanics.
 */
export function EnemyEncountersView({ selectedTemplateId }: EnemyEncountersViewProps) {
    const {
        enemyCompendium, enemyInstances, enemyEncounters, enemyResolutions,
        createEnemyEncounter, updateEnemyEncounter, addEnemyEncounterWave,
        updateEnemyEncounterWave, setEnemyEncounterStatus,
        setEnemyEncounterInstanceAssigned, setEnemyEncounterInstanceActive,
        addEnemyReinforcement,
    } = useAppStore();
    const [newEncounterName, setNewEncounterName] = useState('');
    const [selectedEncounterId, setSelectedEncounterId] = useState<string | null>(null);
    const [selectedWaveId, setSelectedWaveId] = useState<string | null>(null);
    const [resolving, setResolving] = useState(false);

    const sortedEncounters = useMemo(
        () => [...enemyEncounters].sort((a, b) => b.updatedAt - a.updatedAt),
        [enemyEncounters],
    );
    const encounter = enemyEncounters.find(candidate => candidate.id === selectedEncounterId)
        ?? enemyEncounters.find(candidate => candidate.status === 'active')
        ?? sortedEncounters[0];
    const wave = encounter?.waves.find(candidate => candidate.id === selectedWaveId)
        ?? encounter?.waves.find(candidate => candidate.id === encounter.activeWaveId)
        ?? encounter?.waves[0];
    const selectedTemplate = enemyCompendium.find(template => template.id === selectedTemplateId);
    const resolution = encounter?.resolutionId
        ? enemyResolutions.find(candidate => candidate.id === encounter.resolutionId)
        : undefined;

    /** Creates an active encounter and pauses any previously active encounter. */
    const create = () => {
        const created = createEnemyEncounter(newEncounterName);
        setSelectedEncounterId(created.id);
        setSelectedWaveId(created.activeWaveId);
        setNewEncounterName('');
        toast.success(`Created ${created.name}`);
    };

    /** Adds a numbered wave and makes it the encounter's current wave. */
    const addWave = () => {
        if (!encounter || encounter.resolutionId) return;
        const created = addEnemyEncounterWave(encounter.id);
        if (created) setSelectedWaveId(created.id);
    };

    /** Spawns a fresh instance and activates it in the selected wave. */
    const reinforce = () => {
        if (!encounter || encounter.resolutionId || !wave || !selectedTemplate) {
            return toast.warning('Select an encounter, wave, and enemy template first');
        }
        const instance = addEnemyReinforcement(encounter.id, wave.id, selectedTemplate.id);
        if (instance) toast.success(`${instance.displayName} joined ${wave.name}`);
    };

    return <div className="flex-1 flex min-w-0">
        <section className="w-56 border-r border-border flex flex-col">
            <div className="p-3 border-b border-border space-y-2">
                <input
                    aria-label="New encounter name"
                    value={newEncounterName}
                    onChange={event => setNewEncounterName(event.target.value)}
                    placeholder="Encounter name"
                    className="w-full bg-void border border-border rounded p-2 text-xs"
                />
                <button onClick={create} className="w-full px-3 py-2 bg-terminal text-void rounded text-xs font-bold">
                    <Plus size={13} className="inline mr-1" />Create Encounter
                </button>
            </div>
            <div className="flex-1 overflow-y-auto">
                {sortedEncounters.map(candidate => <button
                    key={candidate.id}
                    onClick={() => {
                        setSelectedEncounterId(candidate.id);
                        setSelectedWaveId(candidate.activeWaveId);
                    }}
                    className={`w-full text-left p-3 border-b border-border/50 ${encounter?.id === candidate.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}
                >
                    <div className="font-semibold text-sm">{candidate.name}</div>
                    <div className="text-[10px] uppercase text-text-dim">{candidate.status} · {candidate.waves.length} wave{candidate.waves.length === 1 ? '' : 's'}</div>
                </button>)}
                {!sortedEncounters.length && <p className="p-4 text-xs text-text-dim">Create an encounter to assemble waves and choose the enemies visible to the AI.</p>}
            </div>
        </section>

        {!encounter ? <div className="flex-1 grid place-items-center p-8 text-sm text-text-dim">
            No encounters have been created.
        </div> : <>
            <section className="w-48 border-r border-border flex flex-col">
                <div className="p-3 border-b border-border">
                    <button onClick={addWave} disabled={Boolean(encounter.resolutionId)} className="w-full px-3 py-2 border border-border rounded text-xs disabled:opacity-30">
                        <Plus size={13} className="inline mr-1" />Add Wave
                    </button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {encounter.waves.map(candidate => <button
                        key={candidate.id}
                        onClick={() => setSelectedWaveId(candidate.id)}
                        className={`w-full text-left p-3 border-b border-border/50 ${wave?.id === candidate.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}
                    >
                        <div className="font-semibold text-sm">{candidate.name}</div>
                        <div className="text-[10px] text-text-dim">
                            {candidate.instanceIds.length} assigned · {candidate.activeInstanceIds.length} AI active
                        </div>
                        {encounter.activeWaveId === candidate.id && <div className="text-[10px] uppercase mt-1">Current wave</div>}
                    </button>)}
                </div>
            </section>

            <section className="flex-1 min-w-0 flex flex-col">
                <header className="p-4 border-b border-border space-y-3">
                    <div className="flex items-center gap-3">
                        <input
                            aria-label="Encounter name"
                            value={encounter.name}
                            onChange={event => updateEnemyEncounter(encounter.id, { name: event.target.value })}
                            className="flex-1 bg-void border border-border rounded p-2 text-sm font-semibold"
                        />
                        {encounter.resolutionId
                            ? <span className="px-3 py-2 text-xs uppercase text-text-dim">Resolved</span>
                            : encounter.status === 'active'
                            ? <button onClick={() => setEnemyEncounterStatus(encounter.id, 'paused')} className="px-3 py-2 border border-border rounded text-xs"><Pause size={13} className="inline mr-1" />Pause</button>
                            : <button onClick={() => setEnemyEncounterStatus(encounter.id, 'active')} className="px-3 py-2 border border-terminal text-terminal rounded text-xs"><Play size={13} className="inline mr-1" />Resume</button>}
                        {!encounter.resolutionId && <button onClick={() => setResolving(true)} className="px-3 py-2 border border-ember text-ember rounded text-xs"><Square size={13} className="inline mr-1" />Resolve</button>}
                    </div>
                    {wave && <div className="flex items-center gap-3">
                        <input
                            aria-label="Wave name"
                            value={wave.name}
                            disabled={Boolean(encounter.resolutionId)}
                            onChange={event => updateEnemyEncounterWave(encounter.id, wave.id, { name: event.target.value })}
                            className="flex-1 bg-void border border-border rounded p-2 text-xs"
                        />
                        {encounter.activeWaveId !== wave.id && <button disabled={Boolean(encounter.resolutionId)} onClick={() => updateEnemyEncounter(encounter.id, { activeWaveId: wave.id })} className="px-3 py-2 border border-border rounded text-xs disabled:opacity-30">
                            Set Current Wave
                        </button>}
                        <button onClick={reinforce} disabled={!selectedTemplate || Boolean(encounter.resolutionId)} className="px-3 py-2 bg-terminal text-void rounded text-xs font-bold disabled:opacity-30">
                            <UserPlus size={13} className="inline mr-1" />
                            {selectedTemplate ? `Reinforce: ${selectedTemplate.name}` : 'Select a template'}
                        </button>
                    </div>}
                    <p className="text-[11px] text-text-dim">
                        Only checked AI-active instances in the current wave are sent to the storyteller. Pause or resolve the encounter to remove the entire roster from AI context.
                    </p>
                </header>

                <div className="flex-1 overflow-y-auto p-4">
                    {resolution && <div className="mb-4 rounded border border-terminal/40 bg-terminal/5 p-4">
                        <div className="flex items-center justify-between gap-4">
                            <div className="text-xs font-semibold uppercase tracking-wider">Resolution: {resolution.outcome}</div>
                            <div className="text-[10px] text-text-dim">{new Date(resolution.resolvedAt).toLocaleString()}</div>
                        </div>
                        <p className="mt-2 text-sm">{resolution.summary}</p>
                        <div className="mt-3 text-xs text-text-dim">
                            XP: {resolution.xpAwarded}
                            {resolution.lootAwarded.length ? ` · Loot: ${resolution.lootAwarded.join(', ')}` : ''}
                            {resolution.otherRewards.length ? ` · Rewards: ${resolution.otherRewards.join(', ')}` : ''}
                        </div>
                        <div className="mt-1 text-[10px] text-text-dim">
                            {resolution.participantNames.join(', ') || 'No saved participants'} · Runtime data {resolution.instanceDisposition === 'archive' ? 'archived' : 'discarded'}
                            {resolution.timelineEventId ? ' · Timeline event created' : ''}
                        </div>
                    </div>}
                    {!wave ? <p className="text-sm text-text-dim">This encounter has no wave.</p> : <div className="space-y-2">
                        {enemyInstances.map(instance => {
                            const assigned = wave.instanceIds.includes(instance.id);
                            const active = wave.activeInstanceIds.includes(instance.id);
                            return <div key={instance.id} className={`grid grid-cols-[1fr_auto_auto] items-center gap-4 rounded border p-3 ${active ? 'border-terminal/50 bg-terminal/5' : 'border-border'}`}>
                                <div>
                                    <div className="text-sm font-semibold">{instance.displayName}</div>
                                    <div className="text-[10px] text-text-dim">
                                        HP {instance.currentHp}/{instance.maxHp} · Barrier {instance.currentBarrier}/{instance.maxBarrier}
                                        {instance.defeated ? ' · Defeated/resolved' : ''}
                                    </div>
                                </div>
                                <label className="text-xs">
                                    <input
                                        aria-label={`Assign ${instance.displayName} to wave`}
                                        type="checkbox"
                                        checked={assigned}
                                        disabled={Boolean(encounter.resolutionId)}
                                        onChange={event => setEnemyEncounterInstanceAssigned(encounter.id, wave.id, instance.id, event.target.checked)}
                                        className="mr-2"
                                    />
                                    Assigned
                                </label>
                                <label className={`text-xs ${assigned ? '' : 'opacity-40'}`}>
                                    <input
                                        aria-label={`Make ${instance.displayName} AI active`}
                                        type="checkbox"
                                        checked={active}
                                        disabled={!assigned || Boolean(encounter.resolutionId)}
                                        onChange={event => setEnemyEncounterInstanceActive(encounter.id, wave.id, instance.id, event.target.checked)}
                                        className="mr-2"
                                    />
                                    AI Active
                                </label>
                            </div>;
                        })}
                        {!enemyInstances.length && <p className="text-sm text-text-dim">Create an instance or use the reinforcement button after selecting a template.</p>}
                    </div>}
                </div>
            </section>
        </>}
        {resolving && encounter && <EnemyResolutionDialog encounter={encounter} onClose={() => setResolving(false)} />}
    </div>;
}
