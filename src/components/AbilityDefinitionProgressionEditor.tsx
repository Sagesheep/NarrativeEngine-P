import { Plus, Trash2 } from 'lucide-react';
import type { AbilityEntry, AbilityMasteryTier, AbilityUpgradeNode } from '../types';

type Props = {
    draft: AbilityEntry;
    onChange: (draft: AbilityEntry) => void;
};

const createTier = (): AbilityMasteryTier => ({
    id: crypto.randomUUID(),
    name: '',
    requirements: '',
    benefits: '',
});

const createUpgrade = (): AbilityUpgradeNode => ({
    id: crypto.randomUUID(),
    branch: '',
    name: '',
    description: '',
    prerequisiteTierId: '',
    prerequisiteUpgradeIds: [],
});

export function AbilityDefinitionProgressionEditor({ draft, onChange }: Props) {
    const updateTier = (id: string, patch: Partial<AbilityMasteryTier>) =>
        onChange({
            ...draft,
            masteryLadder: draft.masteryLadder.map(tier => tier.id === id ? { ...tier, ...patch } : tier),
        });
    const updateUpgrade = (id: string, patch: Partial<AbilityUpgradeNode>) =>
        onChange({
            ...draft,
            upgradeNodes: draft.upgradeNodes.map(node => node.id === id ? { ...node, ...patch } : node),
        });

    return <div className="col-span-2 space-y-5 border border-border rounded p-4 bg-void/40">
        <div>
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider">Mastery Ladder</h3>
                    <p className="text-[10px] text-text-dim mt-1">Ordered from the starting tier to the highest tier.</p>
                </div>
                <button type="button" onClick={() => onChange({ ...draft, masteryLadder: [...draft.masteryLadder, createTier()] })} className="px-2 py-1.5 border border-border rounded text-[10px] hover:text-terminal">
                    <Plus size={12} className="inline mr-1" />Add Tier
                </button>
            </div>
            <div className="mt-3 space-y-2">
                {draft.masteryLadder.map((tier, index) => <div key={tier.id} className="grid grid-cols-12 gap-2 border border-border/60 rounded p-3">
                    <span className="col-span-1 text-xs text-text-dim pt-2 text-center">{index + 1}</span>
                    <input aria-label={`Mastery tier ${index + 1} name`} value={tier.name} onChange={event => updateTier(tier.id, { name: event.target.value })} placeholder="Tier name" className="col-span-3 bg-void border border-border rounded p-2 text-xs" />
                    <input aria-label={`Mastery tier ${index + 1} requirements`} value={tier.requirements} onChange={event => updateTier(tier.id, { requirements: event.target.value })} placeholder="Requirements" className="col-span-4 bg-void border border-border rounded p-2 text-xs" />
                    <input aria-label={`Mastery tier ${index + 1} benefits`} value={tier.benefits} onChange={event => updateTier(tier.id, { benefits: event.target.value })} placeholder="Benefits" className="col-span-3 bg-void border border-border rounded p-2 text-xs" />
                    <button type="button" aria-label={`Remove mastery tier ${index + 1}`} onClick={() => onChange({ ...draft, masteryLadder: draft.masteryLadder.filter(candidate => candidate.id !== tier.id) })} className="col-span-1 text-text-dim hover:text-ember"><Trash2 size={14} /></button>
                </div>)}
                {!draft.masteryLadder.length && <p className="text-xs text-text-dim border border-dashed border-border rounded p-3 text-center">No structured mastery ladder.</p>}
            </div>
        </div>

        <div>
            <div className="flex items-center justify-between">
                <div>
                    <h3 className="text-xs font-semibold uppercase tracking-wider">Upgrade Branches</h3>
                    <p className="text-[10px] text-text-dim mt-1">Create upgrades with optional tier and prior-upgrade prerequisites.</p>
                </div>
                <button type="button" onClick={() => onChange({ ...draft, upgradeNodes: [...draft.upgradeNodes, createUpgrade()] })} className="px-2 py-1.5 border border-border rounded text-[10px] hover:text-terminal">
                    <Plus size={12} className="inline mr-1" />Add Upgrade
                </button>
            </div>
            <div className="mt-3 space-y-3">
                {draft.upgradeNodes.map((node, index) => <div key={node.id} className="grid grid-cols-2 gap-2 border border-border/60 rounded p-3">
                    <input aria-label={`Upgrade ${index + 1} name`} value={node.name} onChange={event => updateUpgrade(node.id, { name: event.target.value })} placeholder="Upgrade name" className="bg-void border border-border rounded p-2 text-xs" />
                    <input aria-label={`Upgrade ${index + 1} branch`} value={node.branch} onChange={event => updateUpgrade(node.id, { branch: event.target.value })} placeholder="Branch, e.g. Offense" className="bg-void border border-border rounded p-2 text-xs" />
                    <textarea aria-label={`Upgrade ${index + 1} description`} value={node.description} onChange={event => updateUpgrade(node.id, { description: event.target.value })} rows={2} placeholder="What this upgrade changes" className="bg-void border border-border rounded p-2 text-xs" />
                    <div className="space-y-2">
                        <select aria-label={`Upgrade ${index + 1} mastery prerequisite`} value={node.prerequisiteTierId} onChange={event => updateUpgrade(node.id, { prerequisiteTierId: event.target.value })} className="w-full bg-void border border-border rounded p-2 text-xs">
                            <option value="">No mastery prerequisite</option>
                            {draft.masteryLadder.map(tier => <option key={tier.id} value={tier.id}>Requires {tier.name || 'Unnamed tier'}</option>)}
                        </select>
                        <select
                            multiple
                            aria-label={`Upgrade ${index + 1} upgrade prerequisites`}
                            value={node.prerequisiteUpgradeIds}
                            onChange={event => updateUpgrade(node.id, {
                                prerequisiteUpgradeIds: Array.from(event.target.selectedOptions, option => option.value),
                            })}
                            className="w-full bg-void border border-border rounded p-2 text-xs min-h-16"
                        >
                            {draft.upgradeNodes.filter(candidate => candidate.id !== node.id).map(candidate =>
                                <option key={candidate.id} value={candidate.id}>{candidate.name || 'Unnamed upgrade'}</option>)}
                        </select>
                    </div>
                    <button type="button" onClick={() => onChange({ ...draft, upgradeNodes: draft.upgradeNodes.filter(candidate => candidate.id !== node.id) })} className="col-span-2 justify-self-end text-[10px] text-text-dim hover:text-ember">
                        <Trash2 size={12} className="inline mr-1" />Remove Upgrade
                    </button>
                </div>)}
                {!draft.upgradeNodes.length && <p className="text-xs text-text-dim border border-dashed border-border rounded p-3 text-center">No upgrade branches.</p>}
            </div>
        </div>
    </div>;
}

