import { useMemo, useState } from 'react';
import { Check, FileInput, RefreshCw, Trash2, WandSparkles, X } from 'lucide-react';
import type { AbilityOwnerType, AbilityProposal } from '../types';
import { useAppStore } from '../store/useAppStore';
import { ABILITY_CATEGORIES, ABILITY_ORIGINS, ABILITY_ORIGIN_LABELS, createEmptyAbilityEntry } from '../services/ability/abilitySchema';
import { createEmptyCharacterAbility } from '../services/ability/characterAbilitySchema';
import { buildCharacterSheetAbilityImport } from '../services/ability/characterSheetAbilityImport';
import { getUpgradeAvailability, setCharacterMasteryTier, toggleCharacterUpgrade } from '../services/ability/abilityProgression';
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

    const removeProfileAbilitySources = (sources: string[]) => {
        if (!sources.length) return;
        const current = useAppStore.getState();
        const profile = current.characterProfileData ?? current.context.characterProfileData;
        const sourceKeys = new Set(sources.map(source => source.trim()).filter(Boolean));
        const abilities = profile.abilities.filter(source => !sourceKeys.has(source.trim()));
        if (abilities.length !== profile.abilities.length) {
            current.setCharacterProfileData({ ...profile, abilities });
        }
    };

    const importCharacterSheet = () => {
        const playerCharacter = state.context.playerCharacter;
        if (!playerCharacter) return toast.warning('Create a player character before importing sheet abilities');
        const profile = state.characterProfileData ?? state.context.characterProfileData;
        if (!profile.abilities.length) return toast.info('The character sheet has no abilities to import');

        const result = buildCharacterSheetAbilityImport(
            profile.abilities,
            playerCharacter.id,
            state.abilityCompendium,
            state.characterAbilities,
            state.abilityProposals,
        );
        state.addAbilityProposals(result.proposals);
        removeProfileAbilitySources(result.alreadyTrackedSources);

        if (result.proposals.length) {
            toast.success(`Added ${result.proposals.length} character-sheet proposal${result.proposals.length === 1 ? '' : 's'} for review`);
        } else if (result.alreadyTrackedSources.length) {
            toast.success(`Removed ${result.alreadyTrackedSources.length} already-tracked entr${result.alreadyTrackedSources.length === 1 ? 'y' : 'ies'} from the character sheet`);
        } else if (result.pendingSources.length) {
            toast.info('All character-sheet abilities are already awaiting review');
        } else {
            toast.info('No importable character-sheet abilities were found');
        }
    };

    const accept = (proposal: AbilityProposal, silent = false): boolean => {
        const current = useAppStore.getState();
        const reject = (message: string) => {
            if (!silent) toast.warning(message);
            return false;
        };
        const owner = proposal.ownerType && proposal.ownerId
            ? { type: proposal.ownerType, id: proposal.ownerId }
            : null;
        let ability = proposal.abilityId
            ? current.abilityCompendium.find(entry => entry.id === proposal.abilityId)
            : undefined;

        if (proposal.kind === 'new') {
            const name = proposal.abilityName.trim();
            if (!name) return reject('A new ability needs a name');
            ability = current.abilityCompendium.find(entry =>
                [entry.name, ...entry.aliases.split(',')]
                    .some(candidate => canonical(candidate) === canonical(name)));
            if (!ability) {
                ability = {
                    ...createEmptyAbilityEntry(),
                    name,
                    category: proposal.category,
                    origin: proposal.origin,
                    effect: proposal.effect,
                    activation: proposal.activation,
                    source: proposal.sourceProfileAbility
                        ? 'Imported from character sheet'
                        : proposal.sourceSceneId
                        ? `Discovered in play — ${proposal.sourceSceneId}`
                        : 'Discovered in play',
                    gmNotes: [proposal.reason, proposal.evidence].filter(Boolean).join('\n'),
                };
                current.addAbility(ability);
            }
        }

        if (!ability) return reject('Choose a canonical ability');

        if (proposal.kind === 'assign' || (proposal.kind === 'new' && owner)) {
            if (!owner) return reject('Choose the character who learned this ability');
            const existing = current.characterAbilities.find(entry =>
                entry.abilityId === ability!.id
                && entry.ownerType === owner.type
                && entry.ownerId === owner.id);
            if (!existing) {
                current.addCharacterAbility({
                    ...createEmptyCharacterAbility(owner.type, owner.id, ability.id),
                    mastery: proposal.mastery
                        || ability.masteryLadder.find(tier => tier.id === proposal.masteryTierId)?.name
                        || '',
                    masteryTierId: proposal.masteryTierId,
                    modifications: proposal.modification ? [proposal.modification] : [],
                    learnedSceneId: proposal.sourceSceneId,
                    notes: proposal.reason,
                });
            }
        }

        if (proposal.kind === 'progression') {
            if (!owner) return reject('Choose the character whose ability progressed');
            const assignment = current.characterAbilities.find(entry =>
                entry.abilityId === ability!.id
                && entry.ownerType === owner.type
                && entry.ownerId === owner.id);
            if (!assignment) return reject('That character does not own this ability');
            const modifications = proposal.modification
                && !assignment.modifications.some(item => canonical(item) === canonical(proposal.modification))
                ? [...assignment.modifications, proposal.modification]
                : assignment.modifications;
            let progressed = proposal.masteryTierId
                ? setCharacterMasteryTier(ability, assignment, proposal.masteryTierId)
                : assignment;
            if (proposal.upgradeId) {
                const upgrade = ability.upgradeNodes.find(node => node.id === proposal.upgradeId);
                if (!upgrade) return reject('Choose a valid upgrade');
                if (progressed.unlockedUpgradeIds.includes(proposal.upgradeId)) {
                    return reject(`${upgrade.name} is already unlocked`);
                }
                const availability = getUpgradeAvailability(ability, progressed, upgrade);
                if (!availability.available) return reject(availability.reasons.join('; '));
                progressed = toggleCharacterUpgrade(ability, progressed, proposal.upgradeId);
            }
            current.updateCharacterAbility(assignment.id, {
                mastery: proposal.mastery || progressed.mastery,
                masteryTierId: progressed.masteryTierId,
                unlockedUpgradeIds: progressed.unlockedUpgradeIds,
                trainingProgress: progressed.trainingProgress + proposal.trainingDelta,
                modifications,
                notes: [assignment.notes, proposal.reason].filter(Boolean).join('\n'),
            });
        }

        current.dismissAbilityProposal(proposal.id);
        if (proposal.sourceProfileAbility) {
            removeProfileAbilitySources([proposal.sourceProfileAbility]);
        }
        if (!silent) {
            toast.success(
                proposal.kind === 'new'
                    ? `Added ${ability.name} to the library${owner ? ' and assigned it' : ''}`
                    : proposal.kind === 'assign'
                        ? `Assigned ${ability.name}`
                        : `Updated ${ability.name} progression`,
            );
        }
        return true;
    };

    const acceptAll = () => {
        const proposals = [...useAppStore.getState().abilityProposals];
        let accepted = 0;
        for (const proposal of proposals) {
            if (accept(proposal, true)) accepted++;
        }
        const skipped = proposals.length - accepted;
        if (accepted) toast.success(`Added ${accepted} proposal${accepted === 1 ? '' : 's'} to the compendium`);
        if (skipped) toast.warning(`${skipped} proposal${skipped === 1 ? ' needs' : 's need'} more information`);
    };

    return <div className="flex-1 min-h-0 overflow-y-auto p-5">
        <section className="max-w-4xl mx-auto space-y-4">
            <div className="border border-terminal/30 rounded bg-terminal/5 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                        <h3 className="font-semibold flex items-center gap-2"><WandSparkles size={16} />Discovery Review</h3>
                        <p className="text-xs text-text-dim mt-1 max-w-2xl">
                            Scan recent play for newly learned abilities and meaningful progression.
                            Import existing sheet abilities when starting a compendium.
                            Results remain proposals until you accept them.
                        </p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                        <button
                            onClick={importCharacterSheet}
                            className="px-3 py-2 border border-border text-text-normal rounded text-xs hover:border-terminal hover:text-terminal"
                        >
                            <FileInput size={13} className="inline mr-1.5" />
                            Import Character Sheet
                        </button>
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
            </div>

            <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wider text-text-dim">
                    Pending proposals ({state.abilityProposals.length})
                </h3>
                <div className="flex items-center gap-3">
                    <button
                        onClick={acceptAll}
                        disabled={!state.abilityProposals.length}
                        className="text-[10px] text-terminal hover:text-terminal-bright disabled:opacity-30"
                    >
                        <Check size={12} className="inline mr-1" />Add all
                    </button>
                    <button
                        onClick={state.clearAbilityProposals}
                        disabled={!state.abilityProposals.length}
                        className="text-[10px] text-text-dim hover:text-ember disabled:opacity-30"
                    >
                        <Trash2 size={12} className="inline mr-1" />Dismiss all
                    </button>
                </div>
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
                        {proposal.sourceProfileAbility && <span className="px-2 py-1 rounded bg-sky-400/10 text-sky-300 text-[9px] uppercase tracking-wider">
                            character sheet
                        </span>}
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

                        {proposal.kind === 'new' && <label className="text-[10px] uppercase text-text-dim">
                            Origin
                            <select
                                value={proposal.origin}
                                onChange={event => state.updateAbilityProposal(proposal.id, { origin: event.target.value as AbilityProposal['origin'] })}
                                className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                            >
                                {ABILITY_ORIGINS.map(origin => <option key={origin} value={origin}>{ABILITY_ORIGIN_LABELS[origin]}</option>)}
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

                        {proposal.kind === 'progression' && (() => {
                            const ability = state.abilityCompendium.find(entry => entry.id === proposal.abilityId);
                            return ability?.masteryLadder.length ? <label className="text-[10px] uppercase text-text-dim">
                                Structured Mastery Tier
                                <select value={proposal.masteryTierId} onChange={event => state.updateAbilityProposal(proposal.id, { masteryTierId: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case">
                                    <option value="">No tier change</option>
                                    {ability.masteryLadder.map(tier => <option key={tier.id} value={tier.id}>{tier.name}</option>)}
                                </select>
                            </label> : null;
                        })()}
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

                    {proposal.kind === 'progression' && (() => {
                        const ability = state.abilityCompendium.find(entry => entry.id === proposal.abilityId);
                        return <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                            <label className="text-[10px] uppercase text-text-dim">
                                Unlock Upgrade
                                <select value={proposal.upgradeId} onChange={event => state.updateAbilityProposal(proposal.id, { upgradeId: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case">
                                    <option value="">No upgrade</option>
                                    {ability?.upgradeNodes.map(node => <option key={node.id} value={node.id}>{node.branch ? `${node.branch} · ` : ''}{node.name}</option>)}
                                </select>
                            </label>
                            <label className="text-[10px] uppercase text-text-dim">
                                Training Progress Gained
                                <input type="number" min={0} value={proposal.trainingDelta} onChange={event => state.updateAbilityProposal(proposal.id, { trainingDelta: Math.max(0, Number(event.target.value) || 0) })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                            </label>
                        </div>;
                    })()}

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
