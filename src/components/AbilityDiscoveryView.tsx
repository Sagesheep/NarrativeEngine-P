import { useMemo, useState } from 'react';
import { Check, RefreshCw, Trash2, WandSparkles, X } from 'lucide-react';
import type { AbilityOwnerType, AbilityProposal } from '../types';
import { useAppStore } from '../store/useAppStore';
import { ABILITY_CATEGORIES, createEmptyAbilityEntry } from '../services/ability/abilitySchema';
import { createEmptyCharacterAbility } from '../services/ability/characterAbilitySchema';
import {
    discoverAbilityProposals,
    type AbilityDiscoveryOwner,
} from '../services/ability/abilityDiscovery';
import { toast } from './Toast';

const ownerKey = (type: AbilityOwnerType, id: string) => `${type}:${id}`;

const parseOwner = (key: string): { type: AbilityOwnerType; id: string } | null => {
    const separator = key.indexOf(':');
    if (separator < 0) return null;
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    return (type === 'pc' || type === 'npc') && id ? { type, id } : null;
};

const canonical = (value: string) =>
    value.toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** Explicit review gate between AI observations and durable ability data. */
export function AbilityDiscoveryView() {
    const state = useAppStore();
    const [scanning, setScanning] = useState(false);
    const owners = useMemo<AbilityDiscoveryOwner[]>(() => [
        ...(state.context.playerCharacter ? [{
            type: 'pc' as const,
            id: state.context.playerCharacter.id,
            name: `${state.context.playerCharacter.name} (Player Character)`,
        }] : []),
        ...state.npcLedger
            .filter(npc => !npc.archived)
            .map(npc => ({ type: 'npc' as const, id: npc.id, name: npc.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    ], [state.context.playerCharacter, state.npcLedger]);

    const scan = async () => {
        const provider = state.getActiveUtilityEndpoint() ?? state.getActiveStoryEndpoint();
        if (!provider) return toast.error('No AI provider configured');
        const narrative = state.messages.slice(-12)
            .map(message => `${message.role.toUpperCase()}: ${message.content}`)
            .join('\n\n');
        if (!narrative.trim()) return toast.warning('There is no recent play to scan');

        setScanning(true);
        try {
            const proposals = await discoverAbilityProposals(
                provider,
                narrative,
                state.abilityCompendium,
                state.characterAbilities,
                owners,
            );
            state.addAbilityProposals(proposals);
            if (proposals.length) toast.success(`Added ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} for review`);
            else toast.info('No durable ability changes were found');
        } finally {
            setScanning(false);
        }
    };

    const updateOwner = (proposal: AbilityProposal, key: string) => {
        const owner = parseOwner(key);
        state.updateAbilityProposal(proposal.id, {
            ownerType: owner?.type ?? null,
            ownerId: owner?.id ?? '',
        });
    };

    const accept = (proposal: AbilityProposal) => {
        const owner = proposal.ownerType && proposal.ownerId
            ? { type: proposal.ownerType, id: proposal.ownerId }
            : null;
        let ability = proposal.abilityId
            ? state.abilityCompendium.find(entry => entry.id === proposal.abilityId)
            : undefined;

        if (proposal.kind === 'new') {
            const name = proposal.abilityName.trim();
            if (!name) return toast.warning('A new ability needs a name');
            ability = state.abilityCompendium.find(entry =>
                [entry.name, ...entry.aliases.split(',')]
                    .some(candidate => canonical(candidate) === canonical(name)));
            if (!ability) {
                ability = {
                    ...createEmptyAbilityEntry(),
                    name,
                    category: proposal.category,
                    effect: proposal.effect,
                    activation: proposal.activation,
                    source: proposal.sourceSceneId
                        ? `Discovered in play — ${proposal.sourceSceneId}`
                        : 'Discovered in play',
                    gmNotes: [proposal.reason, proposal.evidence].filter(Boolean).join('\n'),
                };
                state.addAbility(ability);
            }
        }

        if (!ability) return toast.warning('Choose a canonical ability');

        if (proposal.kind === 'assign' || (proposal.kind === 'new' && owner)) {
            if (!owner) return toast.warning('Choose the character who learned this ability');
            const existing = state.characterAbilities.find(entry =>
                entry.abilityId === ability!.id
                && entry.ownerType === owner.type
                && entry.ownerId === owner.id);
            if (!existing) {
                state.addCharacterAbility({
                    ...createEmptyCharacterAbility(owner.type, owner.id, ability.id),
                    mastery: proposal.mastery,
                    modifications: proposal.modification ? [proposal.modification] : [],
                    learnedSceneId: proposal.sourceSceneId,
                    notes: proposal.reason,
                });
            }
        }

        if (proposal.kind === 'progression') {
            if (!owner) return toast.warning('Choose the character whose ability progressed');
            const assignment = state.characterAbilities.find(entry =>
                entry.abilityId === ability!.id
                && entry.ownerType === owner.type
                && entry.ownerId === owner.id);
            if (!assignment) return toast.warning('That character does not own this ability');
            const modifications = proposal.modification
                && !assignment.modifications.some(item => canonical(item) === canonical(proposal.modification))
                ? [...assignment.modifications, proposal.modification]
                : assignment.modifications;
            state.updateCharacterAbility(assignment.id, {
                mastery: proposal.mastery || assignment.mastery,
                modifications,
                notes: [assignment.notes, proposal.reason].filter(Boolean).join('\n'),
            });
        }

        state.dismissAbilityProposal(proposal.id);
        toast.success(
            proposal.kind === 'new'
                ? `Added ${ability.name} to the library${owner ? ' and assigned it' : ''}`
                : proposal.kind === 'assign'
                    ? `Assigned ${ability.name}`
                    : `Updated ${ability.name} progression`,
        );
    };

    return <div className="flex-1 min-h-0 overflow-y-auto p-5">
        <section className="max-w-4xl mx-auto space-y-4">
            <div className="border border-terminal/30 rounded bg-terminal/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 className="font-semibold flex items-center gap-2"><WandSparkles size={16} />Discovery Review</h3>
                        <p className="text-xs text-text-dim mt-1 max-w-2xl">
                            Scan recent play for newly learned abilities and meaningful progression.
                            Results remain proposals until you accept them.
                        </p>
                    </div>
                    <button
                        onClick={() => void scan()}
                        disabled={scanning}
                        className="px-3 py-2 border border-terminal text-terminal rounded text-xs disabled:opacity-40"
                    >
                        <RefreshCw size={13} className={`inline mr-1.5 ${scanning ? 'animate-spin' : ''}`} />
                        {scanning ? 'Scanning…' : 'Scan Recent Play'}
                    </button>
                </div>
            </div>

            <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wider text-text-dim">
                    Pending proposals ({state.abilityProposals.length})
                </h3>
                <button
                    onClick={state.clearAbilityProposals}
                    disabled={!state.abilityProposals.length}
                    className="text-[10px] text-text-dim hover:text-ember disabled:opacity-30"
                >
                    <Trash2 size={12} className="inline mr-1" />Dismiss all
                </button>
            </div>

            {!state.abilityProposals.length && <div className="border border-dashed border-border rounded p-10 text-center text-xs text-text-dim">
                No ability changes are awaiting review.
            </div>}

            {state.abilityProposals.map(proposal => {
                const selectedOwner = proposal.ownerType && proposal.ownerId
                    ? ownerKey(proposal.ownerType, proposal.ownerId)
                    : '';
                return <article key={proposal.id} className="border border-border rounded p-4 space-y-3 bg-void-lighter">
                    <div className="flex items-center gap-2">
                        <span className="px-2 py-1 rounded bg-amber-400/10 text-amber-300 text-[9px] uppercase tracking-wider">
                            {proposal.kind}
                        </span>
                        <span className="text-xs text-text-dim flex-1">{proposal.reason || 'Review the proposed durable change.'}</span>
                        <button onClick={() => accept(proposal)} title="Accept proposal" className="p-1.5 text-terminal hover:bg-terminal/10 rounded">
                            <Check size={15} />
                        </button>
                        <button onClick={() => state.dismissAbilityProposal(proposal.id)} title="Reject proposal" className="p-1.5 text-text-dim hover:text-ember rounded">
                            <X size={15} />
                        </button>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        {proposal.kind === 'new' ? <label className="text-[10px] uppercase text-text-dim">
                            Ability Name
                            <input
                                value={proposal.abilityName}
                                onChange={event => state.updateAbilityProposal(proposal.id, { abilityName: event.target.value })}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            />
                        </label> : <label className="text-[10px] uppercase text-text-dim">
                            Canonical Ability
                            <select
                                value={proposal.abilityId}
                                onChange={event => state.updateAbilityProposal(proposal.id, { abilityId: event.target.value })}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            >
                                <option value="">Choose an ability…</option>
                                {[...state.abilityCompendium].sort((a, b) => a.name.localeCompare(b.name))
                                    .map(ability => <option key={ability.id} value={ability.id}>{ability.name}</option>)}
                            </select>
                        </label>}

                        <label className="text-[10px] uppercase text-text-dim">
                            Character
                            <select
                                value={selectedOwner}
                                onChange={event => updateOwner(proposal, event.target.value)}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            >
                                <option value="">{proposal.kind === 'new' ? 'Library only' : 'Choose a character…'}</option>
                                {owners.map(owner => <option key={ownerKey(owner.type, owner.id)} value={ownerKey(owner.type, owner.id)}>{owner.name}</option>)}
                            </select>
                        </label>

                        {proposal.kind === 'new' && <label className="text-[10px] uppercase text-text-dim">
                            Category
                            <select
                                value={proposal.category}
                                onChange={event => state.updateAbilityProposal(proposal.id, { category: event.target.value as AbilityProposal['category'] })}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            >
                                {ABILITY_CATEGORIES.map(category => <option key={category} value={category}>{category.replace('-', ' ')}</option>)}
                            </select>
                        </label>}

                        {(proposal.kind === 'assign' || proposal.kind === 'progression') && <label className="text-[10px] uppercase text-text-dim">
                            Mastery / Rank
                            <input
                                value={proposal.mastery}
                                onChange={event => state.updateAbilityProposal(proposal.id, { mastery: event.target.value })}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            />
                        </label>}
                    </div>

                    {proposal.kind === 'new' && <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                        <label className="text-[10px] uppercase text-text-dim">
                            Core Effect
                            <textarea value={proposal.effect} onChange={event => state.updateAbilityProposal(proposal.id, { effect: event.target.value })} rows={2} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <label className="text-[10px] uppercase text-text-dim">
                            Activation
                            <textarea value={proposal.activation} onChange={event => state.updateAbilityProposal(proposal.id, { activation: event.target.value })} rows={2} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                    </div>}

                    {proposal.kind === 'progression' && <label className="block text-[10px] uppercase text-text-dim">
                        Personal Modification
                        <input value={proposal.modification} onChange={event => state.updateAbilityProposal(proposal.id, { modification: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                    </label>}

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                        <label className="text-[10px] uppercase text-text-dim">
                            Scene Reference
                            <input value={proposal.sourceSceneId} onChange={event => state.updateAbilityProposal(proposal.id, { sourceSceneId: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                        </label>
                        <div className="md:col-span-2 text-[10px] text-text-dim">
                            Evidence
                            <p className="mt-1 p-2 border border-border/60 rounded normal-case leading-relaxed">{proposal.evidence || 'No evidence summary supplied.'}</p>
                        </div>
                    </div>
                </article>;
            })}
        </section>
    </div>;
}
