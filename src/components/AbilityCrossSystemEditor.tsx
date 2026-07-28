import { useState } from 'react';
import { BookOpenCheck, RotateCcw } from 'lucide-react';
import type { AbilityEntry, EndpointConfig } from '../types';
import { ABILITY_ORIGINS, ABILITY_ORIGIN_LABELS } from '../services/ability/abilitySchema';
import { runLoreCheck } from '../services/lore/loreCheck';
import { useAppStore } from '../store/useAppStore';
import { toast } from './Toast';

type Props = {
    draft: AbilityEntry;
    onChange: (draft: AbilityEntry) => void;
};

const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);

export function AbilityCrossSystemEditor({ draft, onChange }: Props) {
    const state = useAppStore();
    const [checking, setChecking] = useState(false);
    const [status, setStatus] = useState('');

    const checkLore = async () => {
        const provider = state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint();
        if (!provider) return toast.error('No AI provider configured for Lore Check');
        if (!state.activeCampaignId) return toast.warning('Open a campaign before checking lore');
        if (!draft.name.trim()) return toast.warning('Name the ability before checking lore');
        setChecking(true);
        try {
            const result = await runLoreCheck({
                utilityEndpoint: provider as EndpointConfig,
                selectedText: [
                    `Ability: ${draft.name}.`,
                    draft.effect,
                    draft.description,
                    draft.source && `Claimed source: ${draft.source}.`,
                ].filter(Boolean).join(' '),
                surroundingContext: draft.loreCheckNotes || 'Verify whether this ability is supported by campaign lore.',
                messages: state.messages,
                targetMessageId: state.messages.at(-1)?.id ?? '',
                loreChunks: state.loreChunks,
                archiveIndex: state.archiveIndex,
                sealedChapters: state.chapters,
                campaignId: state.activeCampaignId,
                onStatus: setStatus,
                hint: draft.loreCheckNotes || `Check whether ${draft.name} is established and correctly described.`,
                categories: ['contradicts-lore'],
            });
            const verified = result.verdict === 'consistent';
            onChange({
                ...draft,
                loreStatus: verified ? 'verified' : 'flagged',
                loreCheckNotes: [
                    ...result.issues,
                    ...result.citations.map(citation => citation.ref),
                ].join('\n'),
                loreCheckedAt: Date.now(),
            });
            toast[verified ? 'success' : 'warning'](
                verified ? 'Ability passed Lore Check' : `Lore Check returned: ${result.verdict}`,
            );
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Lore Check failed');
        } finally {
            setChecking(false);
            setStatus('');
        }
    };

    return <div className="col-span-2 border border-border rounded p-4 bg-void/40 space-y-4">
        <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider">Cross-System Classification</h3>
            <p className="text-[10px] text-text-dim mt-1">Origin describes where the ability comes from; category still describes how it behaves.</p>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Ability Origin
                <select
                    value={draft.origin}
                    onChange={event => onChange({
                        ...draft,
                        origin: event.target.value as AbilityEntry['origin'],
                        sourceInventoryItemId: event.target.value === 'item-granted' ? draft.sourceInventoryItemId : '',
                    })}
                    className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                >
                    {ABILITY_ORIGINS.map(origin => <option key={origin} value={origin}>{ABILITY_ORIGIN_LABELS[origin]}</option>)}
                </select>
            </label>
            <div className="text-[10px] text-text-dim border border-border/60 rounded p-2">
                <span className="uppercase tracking-wider">Current grouping</span>
                <p className="normal-case text-xs text-text-normal mt-1">{ABILITY_ORIGIN_LABELS[draft.origin]} · {draft.category.replace('-', ' ')}</p>
            </div>
        </div>

        {draft.origin === 'item-granted' && <div className="grid grid-cols-1 md:grid-cols-2 gap-3 border border-sky-400/20 bg-sky-400/5 rounded p-3">
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Granting Inventory Item
                <select value={draft.sourceInventoryItemId} onChange={event => onChange({ ...draft, sourceInventoryItemId: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case">
                    <option value="">Choose an inventory item…</option>
                    {[...state.inventoryItems].sort((a, b) => a.name.localeCompare(b.name)).map(item =>
                        <option key={item.id} value={item.id}>{item.name}</option>)}
                </select>
            </label>
            <label className="text-xs text-text-normal self-end pb-2">
                <input type="checkbox" checked={draft.inventoryRequiresEquipped} onChange={event => onChange({ ...draft, inventoryRequiresEquipped: event.target.checked })} className="mr-2" />
                Item must be equipped to grant this power
            </label>
        </div>}

        {draft.origin === 'enemy-action' && <p className="text-xs text-text-dim border border-rose-400/20 bg-rose-400/5 rounded p-3">
            Link this definition from an action in the Enemy Compendium. Enemy prompts will then use this canonical effect and its interaction rules.
        </p>}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Interaction Tags <span className="normal-case">(one per line)</span>
                <textarea value={draft.interactionTags.join('\n')} onChange={event => onChange({ ...draft, interactionTags: lines(event.target.value) })} rows={3} placeholder="fire&#10;movement&#10;charm" className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
            <label className="text-[10px] uppercase tracking-wider text-text-dim">
                Counter Tags <span className="normal-case">(one per line)</span>
                <textarea value={draft.counterTags.join('\n')} onChange={event => onChange({ ...draft, counterTags: lines(event.target.value) })} rows={3} placeholder="ice&#10;silence&#10;anti-magic" className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
        </div>

        <div className="border border-amber-400/20 bg-amber-400/5 rounded p-3 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="text-xs text-text-normal">
                    <input type="checkbox" checked={draft.loreCheckRequired} onChange={event => onChange({ ...draft, loreCheckRequired: event.target.checked })} className="mr-2" />
                    Require a verified Lore Check before prompt injection
                </label>
                <div className="flex items-center gap-2">
                    <span className={`text-[9px] uppercase px-2 py-1 rounded ${
                        draft.loreStatus === 'verified' ? 'bg-terminal/10 text-terminal'
                            : draft.loreStatus === 'flagged' ? 'bg-ember/10 text-ember'
                                : 'bg-white/5 text-text-dim'
                    }`}>{draft.loreStatus}</span>
                    <button type="button" onClick={() => void checkLore()} disabled={checking} className="px-2 py-1.5 border border-border rounded text-[10px] disabled:opacity-40 hover:text-terminal">
                        <BookOpenCheck size={12} className="inline mr-1" />{checking ? status || 'Checking…' : 'Run Lore Check'}
                    </button>
                    <button type="button" title="Reset Lore Check" onClick={() => onChange({ ...draft, loreStatus: 'unverified', loreCheckNotes: '', loreCheckedAt: null })} className="p-1.5 text-text-dim hover:text-text-normal">
                        <RotateCcw size={12} />
                    </button>
                </div>
            </div>
            <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                Lore Check Notes / Focus
                <textarea value={draft.loreCheckNotes} onChange={event => onChange({ ...draft, loreCheckNotes: event.target.value })} rows={2} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
            </label>
        </div>
    </div>;
}
