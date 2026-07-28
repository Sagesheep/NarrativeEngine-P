import { useMemo, useRef, useState } from 'react';
import { Copy, Download, Plus, Search, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { AbilityCost, AbilityEntry } from '../types';
import { ABILITY_CATEGORIES, createEmptyAbilityEntry, normalizeAbilityEntries } from '../services/ability/abilitySchema';
import { toast } from './Toast';
import { AbilityOwnershipView } from './AbilityOwnershipView';
import { AbilityDiscoveryView } from './AbilityDiscoveryView';

const lines = (value: string) => value.split('\n').map(item => item.trim()).filter(Boolean);

const parseCosts = (value: string): AbilityCost[] => lines(value).flatMap(line => {
    const [resource = '', amount = '', timing = '', condition = ''] = line.split('|').map(part => part.trim());
    return resource ? [{ resource, amount, timing, condition }] : [];
});

/** Campaign-scoped canonical ability library with safe JSON transfer. */
export function AbilityCompendiumModal() {
    const {
        abilityCompendiumOpen,
        toggleAbilityCompendium,
        abilityCompendium,
        setAbilityCompendium,
        addAbility,
        updateAbility,
        removeAbility,
    } = useAppStore();
    const [query, setQuery] = useState('');
    const [view, setView] = useState<'library' | 'characters' | 'discoveries'>('library');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<AbilityEntry>(() => createEmptyAbilityEntry());
    const importRef = useRef<HTMLInputElement>(null);

    const shown = useMemo(() => {
        const q = query.toLocaleLowerCase().trim();
        return [...abilityCompendium]
            .filter(ability => !q || [
                ability.name, ability.aliases, ability.category, ability.tags.join(' '), ability.source,
            ].some(value => value.toLocaleLowerCase().includes(q)))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [abilityCompendium, query]);

    if (!abilityCompendiumOpen) return null;

    const select = (ability?: AbilityEntry) => {
        setSelectedId(ability?.id ?? null);
        setDraft(ability ? structuredClone(ability) : createEmptyAbilityEntry());
    };

    const save = () => {
        if (!draft.name.trim()) return toast.warning('Ability name is required');
        const next = { ...draft, name: draft.name.trim(), updatedAt: Date.now() };
        if (selectedId) updateAbility(selectedId, next);
        else addAbility(next);
        setSelectedId(next.id);
        setDraft(next);
        toast.success('Ability saved');
    };

    const duplicate = () => {
        const now = Date.now();
        setSelectedId(null);
        setDraft({
            ...structuredClone(draft),
            id: crypto.randomUUID(),
            name: `${draft.name} Copy`,
            createdAt: now,
            updatedAt: now,
        });
    };

    const exportJson = () => {
        const blob = new Blob([JSON.stringify(abilityCompendium, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = 'ability-compendium.json';
        anchor.click();
        URL.revokeObjectURL(url);
    };

    const importJson = async (file?: File) => {
        if (!file) return;
        try {
            const parsed: unknown = JSON.parse(await file.text());
            if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
            const { entries, skipped } = normalizeAbilityEntries(parsed);
            setAbilityCompendium(entries);
            select();
            toast.success(`Imported ${entries.length} abilities${skipped ? ` (${skipped} invalid records skipped)` : ''}`);
        } catch (error) {
            toast.error(error instanceof Error ? error.message : 'Import failed');
        }
    };

    const field = (label: string, key: keyof AbilityEntry, multiline = false) => (
        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            {label}
            {multiline
                ? <textarea value={String(draft[key] ?? '')} onChange={event => setDraft({ ...draft, [key]: event.target.value })} rows={3} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                : <input value={String(draft[key] ?? '')} onChange={event => setDraft({ ...draft, [key]: event.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />}
        </label>
    );

    const listField = (label: string, key: 'limitations' | 'counters' | 'prerequisites' | 'tags') => (
        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            {label} <span className="normal-case">(one per line)</span>
            <textarea value={draft[key].join('\n')} onChange={event => setDraft({ ...draft, [key]: lines(event.target.value) })} rows={3} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
        </label>
    );

    return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
        <div className="w-full max-w-[95vw] h-[88vh] bg-void-lighter border border-border rounded flex flex-col md:flex-row overflow-hidden">
            <aside className="w-full h-44 md:w-80 md:h-auto border-b md:border-b-0 md:border-r border-border flex flex-col shrink-0">
                <div className="p-3 flex gap-2">
                    <div className="relative flex-1">
                        <Search size={13} className="absolute left-2 top-2.5 text-text-dim" />
                        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Search abilities…" className="w-full bg-void border border-border rounded py-2 pl-7 pr-2 text-xs" />
                    </div>
                    <button onClick={() => select()} title="New ability" className="p-2 border border-border rounded hover:text-terminal"><Plus size={15} /></button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {shown.map(ability => <button key={ability.id} onClick={() => select(ability)} className={`w-full text-left p-3 border-b border-border/50 ${selectedId === ability.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}>
                        <div className="font-semibold text-sm">{ability.name}</div>
                        <div className="text-[10px] text-text-dim">{ability.category.replace('-', ' ')}</div>
                    </button>)}
                    {!shown.length && <div className="p-6 text-center text-xs text-text-dim">No abilities found.</div>}
                </div>
                <div className="p-3 border-t border-border flex gap-2">
                    <button onClick={exportJson} disabled={!abilityCompendium.length} className="flex-1 p-2 border border-border rounded text-xs disabled:opacity-30"><Download size={13} className="inline mr-1" />Export</button>
                    <button onClick={() => importRef.current?.click()} className="flex-1 p-2 border border-border rounded text-xs"><Upload size={13} className="inline mr-1" />Import</button>
                    <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={event => void importJson(event.target.files?.[0])} />
                </div>
            </aside>
            <main className="flex-1 flex flex-col min-w-0 min-h-0">
                <header className="p-4 border-b border-border flex items-center justify-between">
                    <div>
                        <h2 className="font-bold uppercase tracking-wider flex items-center gap-2"><Sparkles size={16} />Ability &amp; Power Compendium</h2>
                        <p className="text-xs text-text-dim mt-1">Canonical definitions and character-specific ownership.</p>
                        <div className="flex gap-3 mt-2">
                            <button onClick={() => setView('library')} className={`text-xs ${view === 'library' ? 'text-terminal' : 'text-text-dim'}`}>Library</button>
                            <button onClick={() => setView('characters')} className={`text-xs ${view === 'characters' ? 'text-terminal' : 'text-text-dim'}`}>Characters</button>
                            <button onClick={() => setView('discoveries')} className={`text-xs ${view === 'discoveries' ? 'text-terminal' : 'text-text-dim'}`}>Discoveries</button>
                        </div>
                    </div>
                    <button onClick={toggleAbilityCompendium} aria-label="Close ability compendium"><X size={20} /></button>
                </header>
                {view === 'library' ? <>
                    <div className="flex-1 overflow-y-auto p-5 grid grid-cols-2 gap-4">
                    {field('Name', 'name')}{field('Aliases (comma separated)', 'aliases')}
                    <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                        Category
                        <select value={draft.category} onChange={event => setDraft({ ...draft, category: event.target.value as AbilityEntry['category'] })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case">
                            {ABILITY_CATEGORIES.map(category => <option key={category} value={category}>{category.replace('-', ' ')}</option>)}
                        </select>
                    </label>
                    {field('Canon / Lore Source', 'source')}
                    <div className="col-span-2">{field('Core Effect', 'effect', true)}</div>
                    {field('Activation Requirements', 'activation', true)}
                    <label className="block text-[10px] uppercase tracking-wider text-text-dim">
                        Costs <span className="normal-case">(Resource | Amount | Timing | Condition)</span>
                        <textarea value={draft.costs.map(cost => [cost.resource, cost.amount, cost.timing, cost.condition].join(' | ')).join('\n')} onChange={event => setDraft({ ...draft, costs: parseCosts(event.target.value) })} rows={3} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                    </label>
                    {field('Range', 'range')}{field('Targets', 'targets')}
                    {field('Duration', 'duration')}{field('Area', 'area')}
                    {listField('Limitations', 'limitations')}{listField('Counters', 'counters')}
                    {listField('Prerequisites', 'prerequisites')}{listField('Tags', 'tags')}
                    <div className="col-span-2">{field('Outcome Guidance', 'outcomeGuidance', true)}</div>
                    {field('Description', 'description', true)}{field('Narrative Appearance', 'appearance', true)}
                    <div className="col-span-2">{field('GM Notes', 'gmNotes', true)}</div>
                    <label className="col-span-2 text-xs">
                        <input type="checkbox" checked={draft.promptEnabled} onChange={event => setDraft({ ...draft, promptEnabled: event.target.checked })} className="mr-2" />
                        Inject this definition when its exact name or alias appears in recent play
                    </label>
                    </div>
                    <footer className="p-4 border-t border-border flex justify-between">
                    <div className="flex gap-2">
                        <button onClick={duplicate} disabled={!draft.name} className="px-3 py-2 border border-border rounded text-xs disabled:opacity-30"><Copy size={13} className="inline mr-1" />Duplicate</button>
                        {selectedId && <button onClick={() => { removeAbility(selectedId); select(); }} className="px-3 py-2 border border-ember text-ember rounded text-xs"><Trash2 size={13} className="inline mr-1" />Delete</button>}
                    </div>
                    <button onClick={save} className="px-5 py-2 bg-terminal text-void rounded text-xs font-bold">Save Definition</button>
                    </footer>
                </> : view === 'characters'
                    ? <AbilityOwnershipView key={selectedId ?? 'unselected'} initialAbilityId={selectedId ?? ''} />
                    : <AbilityDiscoveryView />}
            </main>
        </div>
    </div>;
}
