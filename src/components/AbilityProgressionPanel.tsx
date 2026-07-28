import { Check, LockKeyhole, Plus, Trash2 } from 'lucide-react';
import type { AbilityEntry, AbilityTrainingMilestone, CharacterAbility } from '../types';
import { getUpgradeAvailability, setCharacterMasteryTier, toggleCharacterUpgrade } from '../services/ability/abilityProgression';

type Props = {
    ability?: AbilityEntry;
    draft: CharacterAbility;
    onChange: (draft: CharacterAbility) => void;
};

const createMilestone = (): AbilityTrainingMilestone => ({
    id: crypto.randomUUID(),
    name: '',
    requirement: '',
    completed: false,
    completedSceneId: '',
    completedAt: null,
});

export function AbilityProgressionPanel({ ability, draft, onChange }: Props) {
    if (!ability) return null;
    const updateMilestone = (id: string, patch: Partial<AbilityTrainingMilestone>) =>
        onChange({
            ...draft,
            trainingMilestones: draft.trainingMilestones.map(milestone =>
                milestone.id === id ? { ...milestone, ...patch } : milestone),
        });

    return <div className="mx-5 mb-5 border border-terminal/20 rounded bg-terminal/5 p-4 space-y-5">
        <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider">Progression</h3>
            <p className="text-[10px] text-text-dim mt-1">Manual progression remains authoritative. Save the character assignment to keep these changes.</p>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Mastery Tier
                {ability.masteryLadder.length ? <select
                    value={draft.masteryTierId}
                    onChange={event => onChange(setCharacterMasteryTier(ability, draft, event.target.value))}
                    className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                >
                    <option value="">Unranked / Custom</option>
                    {ability.masteryLadder.map(tier => <option key={tier.id} value={tier.id}>{tier.name || 'Unnamed tier'}</option>)}
                </select> : <span className="mt-2 block text-xs text-text-dim normal-case">Define a ladder in the Library to use structured tiers.</span>}
            </label>
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Training Progress
                <input type="number" min={0} value={draft.trainingProgress} onChange={event => onChange({ ...draft, trainingProgress: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal" />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Training Goal
                <input type="number" min={0} value={draft.trainingGoal} onChange={event => onChange({ ...draft, trainingGoal: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal" />
            </label>
        </div>
        {draft.trainingGoal > 0 && <div>
            <div className="h-2 bg-void border border-border rounded overflow-hidden">
                <div className="h-full bg-terminal" style={{ width: `${Math.min(100, (draft.trainingProgress / draft.trainingGoal) * 100)}%` }} />
            </div>
            <p className="text-[10px] text-text-dim mt-1 text-right">{draft.trainingProgress} / {draft.trainingGoal}{draft.trainingProgress >= draft.trainingGoal ? ' · Goal reached' : ''}</p>
        </div>}

        <div>
            <div className="flex items-center justify-between">
                <h4 className="text-[10px] uppercase tracking-wider text-text-dim">Training Milestones</h4>
                <button type="button" onClick={() => onChange({ ...draft, trainingMilestones: [...draft.trainingMilestones, createMilestone()] })} className="text-[10px] hover:text-terminal">
                    <Plus size={12} className="inline mr-1" />Add Milestone
                </button>
            </div>
            <div className="mt-2 space-y-2">
                {draft.trainingMilestones.map((milestone, index) => <div key={milestone.id} className="grid grid-cols-12 gap-2 items-center">
                    <input type="checkbox" aria-label={`Milestone ${index + 1} completed`} checked={milestone.completed} onChange={event => updateMilestone(milestone.id, {
                        completed: event.target.checked,
                        completedAt: event.target.checked ? Date.now() : null,
                    })} className="col-span-1" />
                    <input aria-label={`Milestone ${index + 1} name`} value={milestone.name} onChange={event => updateMilestone(milestone.id, { name: event.target.value })} placeholder="Milestone" className="col-span-3 bg-void border border-border rounded p-2 text-xs" />
                    <input aria-label={`Milestone ${index + 1} requirement`} value={milestone.requirement} onChange={event => updateMilestone(milestone.id, { requirement: event.target.value })} placeholder="Requirement" className="col-span-5 bg-void border border-border rounded p-2 text-xs" />
                    <input aria-label={`Milestone ${index + 1} scene`} value={milestone.completedSceneId} onChange={event => updateMilestone(milestone.id, { completedSceneId: event.target.value })} placeholder="Scene" className="col-span-2 bg-void border border-border rounded p-2 text-xs" />
                    <button type="button" aria-label={`Remove milestone ${index + 1}`} onClick={() => onChange({ ...draft, trainingMilestones: draft.trainingMilestones.filter(candidate => candidate.id !== milestone.id) })} className="col-span-1 text-text-dim hover:text-ember"><Trash2 size={13} /></button>
                </div>)}
                {!draft.trainingMilestones.length && <p className="text-xs text-text-dim">No milestones recorded.</p>}
            </div>
        </div>

        <div>
            <h4 className="text-[10px] uppercase tracking-wider text-text-dim mb-2">Upgrade Branches</h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                {ability.upgradeNodes.map(upgrade => {
                    const unlocked = draft.unlockedUpgradeIds.includes(upgrade.id);
                    const availability = getUpgradeAvailability(ability, draft, upgrade);
                    return <button
                        type="button"
                        key={upgrade.id}
                        disabled={!unlocked && !availability.available}
                        title={availability.reasons.join('; ')}
                        onClick={() => onChange(toggleCharacterUpgrade(ability, draft, upgrade.id))}
                        className={`text-left border rounded p-3 disabled:opacity-50 ${unlocked ? 'border-terminal bg-terminal/10' : 'border-border'}`}
                    >
                        <div className="flex items-center gap-2">
                            {unlocked ? <Check size={13} className="text-terminal" /> : !availability.available ? <LockKeyhole size={13} /> : <span className="w-[13px]" />}
                            <span className="text-xs font-semibold">{upgrade.name}</span>
                            {upgrade.branch && <span className="ml-auto text-[9px] uppercase text-text-dim">{upgrade.branch}</span>}
                        </div>
                        <p className="text-[10px] text-text-dim mt-1">{availability.reasons.join(' · ') || upgrade.description || 'Available'}</p>
                    </button>;
                })}
                {!ability.upgradeNodes.length && <p className="text-xs text-text-dim">No upgrade branches defined for this ability.</p>}
            </div>
        </div>
    </div>;
}
