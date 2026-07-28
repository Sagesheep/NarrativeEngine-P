import { useMemo, useState } from 'react';
import { Clock3, Play, Plus, RefreshCw, Trash2, Zap } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import {
    activateAbilityRuntimeState,
    canActivateAbility,
    createEmptyAbilityRuntimeState,
    resetAbilityRuntimeState,
} from '../services/ability/abilityRuntimeSchema';
import { toast } from './Toast';

const numberValue = (value: string): number => Math.max(0, Math.floor(Number(value) || 0));

export function AbilityRuntimePanel({ characterAbilityId }: { characterAbilityId: string }) {
    const {
        abilityRuntimeStates,
        upsertAbilityRuntimeState,
        advanceAbilityRuntimeTurn,
    } = useAppStore();
    const empty = useMemo(
        () => createEmptyAbilityRuntimeState(characterAbilityId),
        [characterAbilityId],
    );
    const state = abilityRuntimeStates.find(entry =>
        entry.characterAbilityId === characterAbilityId) ?? empty;
    const [effectName, setEffectName] = useState('');
    const [effectTurns, setEffectTurns] = useState('1');
    const [effectNotes, setEffectNotes] = useState('');
    const [sceneId, setSceneId] = useState('');
    const activation = canActivateAbility(state);

    const update = (patch: Partial<typeof state>) => {
        upsertAbilityRuntimeState({ ...state, ...patch, updatedAt: Date.now() });
    };

    const activate = () => {
        if (!activation.ok) return toast.warning(activation.reason);
        upsertAbilityRuntimeState(activateAbilityRuntimeState(state, sceneId));
        toast.success('Ability activated');
    };

    const addEffect = () => {
        const name = effectName.trim();
        if (!name) return toast.warning('Effect name is required');
        update({
            activeEffects: [...state.activeEffects, {
                id: crypto.randomUUID(),
                name,
                remainingTurns: Math.max(1, numberValue(effectTurns)),
                notes: effectNotes.trim(),
            }],
        });
        setEffectName('');
        setEffectTurns('1');
        setEffectNotes('');
    };

    return <div className="border-t border-border p-5 space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
                <h3 className="text-xs font-bold uppercase tracking-wider flex items-center gap-2">
                    <Zap size={14} /> Runtime State
                </h3>
                <p className="text-[10px] text-text-dim mt-1">
                    Encounter state is advanced manually; narrative turns do not imply combat rounds.
                </p>
            </div>
            <div className="flex gap-2">
                <button
                    onClick={() => advanceAbilityRuntimeTurn(characterAbilityId)}
                    className="px-3 py-2 border border-border rounded text-xs hover:text-terminal"
                >
                    <Clock3 size={13} className="inline mr-1" />Advance 1 Turn
                </button>
                <button
                    onClick={() => upsertAbilityRuntimeState(resetAbilityRuntimeState(state))}
                    className="px-3 py-2 border border-border rounded text-xs hover:text-terminal"
                >
                    <RefreshCw size={13} className="inline mr-1" />Reset Encounter
                </button>
            </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                Cooldown Remaining
                <input type="number" min={0} value={state.cooldownRemaining} onChange={event =>
                    update({ cooldownRemaining: numberValue(event.target.value) })}
                    className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                Cooldown Maximum
                <input type="number" min={0} value={state.cooldownMax} onChange={event =>
                    update({ cooldownMax: numberValue(event.target.value) })}
                    className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                Charges Remaining
                <input type="number" min={0} value={state.chargesRemaining ?? ''} placeholder="Unlimited" onChange={event => {
                    const value = event.target.value === '' ? null : numberValue(event.target.value);
                    update({ chargesRemaining: value, chargesMax: value == null ? null : Math.max(state.chargesMax ?? value, value) });
                }} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                Charges Maximum
                <input type="number" min={0} value={state.chargesMax ?? ''} placeholder="Unlimited" onChange={event => {
                    const value = event.target.value === '' ? null : numberValue(event.target.value);
                    update({
                        chargesMax: value,
                        chargesRemaining: value == null ? null : Math.min(state.chargesRemaining ?? value, value),
                    });
                }} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-[1fr_auto] gap-3 items-end">
            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                Activation Scene
                <input value={sceneId} onChange={event => setSceneId(event.target.value)} placeholder="Optional scene ID"
                    className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
            <button onClick={activate} disabled={!activation.ok}
                title={activation.reason || 'Consume a charge and begin cooldown'}
                className="px-5 py-2 bg-terminal text-void rounded text-xs font-bold disabled:opacity-30">
                <Play size={13} className="inline mr-1" />Activate
            </button>
        </div>

        <div className="text-[10px] text-text-dim flex flex-wrap gap-x-5 gap-y-1">
            <span>Uses: <strong className="text-text-normal">{state.uses}</strong></span>
            <span>Last used: <strong className="text-text-normal">{state.lastUsedSceneId || '—'}</strong></span>
            <span>Status: <strong className={activation.ok ? 'text-terminal' : 'text-ember'}>
                {activation.ok ? 'Ready' : activation.reason}
            </strong></span>
        </div>

        <div className="space-y-2">
            <div className="text-[10px] uppercase tracking-wider text-text-dim">Active Effects</div>
            {state.activeEffects.map(effect => <div key={effect.id} className="border border-border rounded p-3 flex items-start justify-between gap-3">
                <div className="text-xs">
                    <div className="font-semibold">{effect.name} · {effect.remainingTurns} turn(s)</div>
                    {effect.notes && <div className="text-text-dim mt-1">{effect.notes}</div>}
                </div>
                <button aria-label={`Remove ${effect.name}`} onClick={() =>
                    update({ activeEffects: state.activeEffects.filter(candidate => candidate.id !== effect.id) })}
                    className="text-text-dim hover:text-ember"><Trash2 size={13} /></button>
            </div>)}
            {!state.activeEffects.length && <div className="text-xs text-text-dim">No active effects.</div>}
            <div className="grid grid-cols-1 md:grid-cols-[1fr_6rem_1fr_auto] gap-2 items-end">
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Effect
                    <input value={effectName} onChange={event => setEffectName(event.target.value)}
                        className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Turns
                    <input type="number" min={1} value={effectTurns} onChange={event => setEffectTurns(event.target.value)}
                        className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Effect Notes
                    <input value={effectNotes} onChange={event => setEffectNotes(event.target.value)}
                        className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <button onClick={addEffect} className="px-3 py-2 border border-border rounded text-xs hover:text-terminal">
                    <Plus size={13} className="inline mr-1" />Add
                </button>
            </div>
        </div>

        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            Runtime Notes
            <textarea value={state.notes} onChange={event => update({ notes: event.target.value })} rows={2}
                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
        </label>
    </div>;
}
