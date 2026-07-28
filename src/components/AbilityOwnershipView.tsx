import { useMemo, useState } from 'react';
import { Plus, Trash2, UserRound } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { AbilityOwnerType, CharacterAbility } from '../types';
import { createEmptyCharacterAbility } from '../services/ability/characterAbilitySchema';
import { toast } from './Toast';
import { AbilityRuntimePanel } from './AbilityRuntimePanel';
import { AbilityProgressionPanel } from './AbilityProgressionPanel';
import { InventoryGrantedAbilities } from './InventoryGrantedAbilities';
import { ABILITY_ORIGIN_LABELS } from '../services/ability/abilitySchema';

type OwnerOption = {
    key: string;
    type: AbilityOwnerType;
    id: string;
    name: string;
};

const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);

const parseOwnerKey = (key: string): { type: AbilityOwnerType; id: string } | null => {
    const separator = key.indexOf(':');
    if (separator < 0) return null;
    const type = key.slice(0, separator);
    const id = key.slice(separator + 1);
    return (type === 'pc' || type === 'npc') && id ? { type, id } : null;
};

export function AbilityOwnershipView({ initialAbilityId = '' }: { initialAbilityId?: string }) {
    const {
        context,
        npcLedger,
        abilityCompendium,
        inventoryItems,
        characterAbilities,
        addCharacterAbility,
        updateCharacterAbility,
        removeCharacterAbility,
    } = useAppStore();

    const owners = useMemo<OwnerOption[]>(() => [
        ...(context.playerCharacter ? [{
            key: `pc:${context.playerCharacter.id}`,
            type: 'pc' as const,
            id: context.playerCharacter.id,
            name: `${context.playerCharacter.name} (Player Character)`,
        }] : []),
        ...npcLedger
            .filter(npc => !npc.archived)
            .map(npc => ({ key: `npc:${npc.id}`, type: 'npc' as const, id: npc.id, name: npc.name }))
            .sort((a, b) => a.name.localeCompare(b.name)),
    ], [context.playerCharacter, npcLedger]);

    const initialOwner = owners[0];
    const [ownerKey, setOwnerKey] = useState(initialOwner?.key ?? '');
    const [selectedAssignmentId, setSelectedAssignmentId] = useState<string | null>(null);
    const [draft, setDraft] = useState<CharacterAbility>(() => createEmptyCharacterAbility(
        initialOwner?.type ?? 'pc',
        initialOwner?.id ?? '',
        initialAbilityId || abilityCompendium[0]?.id || '',
    ));

    const owner = parseOwnerKey(ownerKey);
    const selectedAbility = abilityCompendium.find(ability => ability.id === draft.abilityId);
    const assignments = characterAbilities
        .filter(entry => owner && entry.ownerType === owner.type && entry.ownerId === owner.id)
        .sort((a, b) => {
            const aName = abilityCompendium.find(ability => ability.id === a.abilityId)?.name ?? '';
            const bName = abilityCompendium.find(ability => ability.id === b.abilityId)?.name ?? '';
            return aName.localeCompare(bName);
        });

    const newAssignment = (nextOwnerKey = ownerKey) => {
        const nextOwner = parseOwnerKey(nextOwnerKey);
        if (!nextOwner) return;
        setSelectedAssignmentId(null);
        setDraft(createEmptyCharacterAbility(
            nextOwner.type,
            nextOwner.id,
            initialAbilityId || abilityCompendium[0]?.id || '',
        ));
    };

    const selectAssignment = (entry: CharacterAbility) => {
        setSelectedAssignmentId(entry.id);
        setDraft(structuredClone(entry));
    };

    const save = () => {
        if (!owner) return toast.warning('Choose a character first');
        if (!draft.abilityId) return toast.warning('Choose an ability definition');
        const next = {
            ...draft,
            ownerType: owner.type,
            ownerId: owner.id,
        };
        if (selectedAssignmentId) updateCharacterAbility(selectedAssignmentId, next);
        else addCharacterAbility(next);
        setSelectedAssignmentId(next.id);
        setDraft(next);
        toast.success('Character ability saved');
    };

    if (!owners.length) {
        return <div className="flex-1 flex items-center justify-center text-center text-sm text-text-dim p-8">
            Create a player character or NPC before assigning abilities.
        </div>;
    }

    return <div className="flex-1 flex min-h-0">
        <aside className="w-72 border-r border-border flex flex-col">
            <div className="p-3 border-b border-border">
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Character
                    <select
                        value={ownerKey}
                        onChange={event => {
                            setOwnerKey(event.target.value);
                            newAssignment(event.target.value);
                        }}
                        className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case"
                    >
                        {owners.map(option => <option key={option.key} value={option.key}>{option.name}</option>)}
                    </select>
                </label>
            </div>
            {owner?.type === 'pc' && <InventoryGrantedAbilities abilities={abilityCompendium} inventoryItems={inventoryItems} />}
            <div className="flex-1 overflow-y-auto">
                {assignments.map(entry => {
                    const ability = abilityCompendium.find(candidate => candidate.id === entry.abilityId);
                    return <button key={entry.id} onClick={() => selectAssignment(entry)} className={`w-full text-left p-3 border-b border-border/50 ${selectedAssignmentId === entry.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}>
                        <div className="font-semibold text-sm">{entry.variantName || ability?.name || 'Missing definition'}</div>
                        <div className="text-[10px] text-text-dim">
                            {ability ? `${ABILITY_ORIGIN_LABELS[ability.origin]} · ` : ''}
                            {[ability?.name !== entry.variantName ? ability?.name : '', entry.mastery].filter(Boolean).join(' · ') || 'Unranked'}
                        </div>
                    </button>;
                })}
                {!assignments.length && <div className="p-5 text-center text-xs text-text-dim">No assigned abilities.</div>}
            </div>
            <div className="p-3 border-t border-border">
                <button onClick={() => newAssignment()} className="w-full p-2 border border-border rounded text-xs hover:text-terminal"><Plus size={13} className="inline mr-1" />Assign Ability</button>
            </div>
        </aside>
        <section className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 overflow-y-auto">
            <div className="p-5 grid grid-cols-2 gap-4">
                <label className="block text-[10px] uppercase tracking-wider text-text-dim col-span-2">
                    Canonical Ability
                    <select value={draft.abilityId} onChange={event => setDraft({ ...draft, abilityId: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case">
                        <option value="">Choose an ability…</option>
                        {[...abilityCompendium].sort((a, b) => a.name.localeCompare(b.name)).map(ability =>
                            <option key={ability.id} value={ability.id}>{ability.name}</option>)}
                    </select>
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Mastery / Rank
                    <input value={draft.mastery} onChange={event => setDraft({ ...draft, mastery: event.target.value })} placeholder="e.g. Adept, Rank 3" className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Personal Variant Name
                    <input value={draft.variantName} onChange={event => setDraft({ ...draft, variantName: event.target.value })} placeholder="Optional personal name" className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim col-span-2">
                    Personal Modifications <span className="normal-case">(one per line)</span>
                    <textarea value={draft.modifications.join('\n')} onChange={event => setDraft({ ...draft, modifications: lines(event.target.value) })} rows={5} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Learned Scene
                    <input value={draft.learnedSceneId} onChange={event => setDraft({ ...draft, learnedSceneId: event.target.value })} placeholder="Scene ID or reference" className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                    Prompt Context
                    <span className="mt-3 flex items-center text-xs text-text-normal normal-case">
                        <input type="checkbox" checked={draft.promptEnabled} onChange={event => setDraft({ ...draft, promptEnabled: event.target.checked })} className="mr-2" />
                        Include owner details when relevant
                    </span>
                </label>
                <label className="block text-[10px] uppercase tracking-wider text-text-dim col-span-2">
                    Ownership Notes
                    <textarea value={draft.notes} onChange={event => setDraft({ ...draft, notes: event.target.value })} rows={4} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                </label>
            </div>
            <AbilityProgressionPanel ability={selectedAbility} draft={draft} onChange={setDraft} />
            {selectedAssignmentId && <AbilityRuntimePanel characterAbilityId={selectedAssignmentId} />}
            </div>
            <footer className="p-4 border-t border-border flex justify-between">
                <div>
                    {selectedAssignmentId && <button onClick={() => {
                        removeCharacterAbility(selectedAssignmentId);
                        newAssignment();
                    }} className="px-3 py-2 border border-ember text-ember rounded text-xs"><Trash2 size={13} className="inline mr-1" />Remove from Character</button>}
                </div>
                <button onClick={save} disabled={!abilityCompendium.length} className="px-5 py-2 bg-terminal text-void rounded text-xs font-bold disabled:opacity-30"><UserRound size={13} className="inline mr-1" />Add to Character</button>
            </footer>
        </section>
    </div>;
}
