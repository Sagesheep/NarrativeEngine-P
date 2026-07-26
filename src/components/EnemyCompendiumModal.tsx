import { useMemo, useRef, useState } from 'react';
import { Download, Plus, Search, Trash2, Upload, X, Copy } from 'lucide-react';
import { useAppStore } from '../store/useAppStore';
import type { EnemyEntry } from '../types';
import { toast } from './Toast';
import { EnemyInstancesView } from './EnemyInstancesView';
import { EnemyEncountersView } from './EnemyEncountersView';
import { EnemyCombatView } from './EnemyCombatView';

/** Creates a complete unsaved template so every editor field remains controlled. */
const emptyEnemy = (): EnemyEntry => {
    const now = Date.now();
    return {
        id: crypto.randomUUID(), name: '', aliases: '', classification: '',
        description: '', threatTier: '', tags: [], faction: '', stats: [], actions: [],
        passiveTraits: [], specialBehaviors: [], weaknesses: [], resistances: [],
        tactics: '', loot: '', gmNotes: '', promptEnabled: true, createdAt: now, updatedAt: now,
    };
};

/** Converts a multiline editor value into trimmed, non-empty list entries. */
const lines = (value: string) => value.split('\n').map(v => v.trim()).filter(Boolean);

/** Parses "name: value" lines while preserving additional colons in the value. */
const pairs = (value: string) => lines(value).map(line => {
    const [name, ...rest] = line.split(':');
    return { name: name.trim(), value: rest.join(':').trim() };
});

/** Adapts generic name/value pairs to the EnemyAction data shape. */
const actions = (value: string) => pairs(value).map(({ name, value }) => ({ name, description: value }));

/**
 * Provides campaign-scoped CRUD, search, duplication, and JSON transfer for
 * reusable enemy templates. Store actions handle persistence; this component
 * only manages the currently edited draft.
 */
export function EnemyCompendiumModal() {
    const { enemyCompendiumOpen, toggleEnemyCompendium, enemyCompendium, enemyInstances, enemyEncounters, addEnemy, updateEnemy, removeEnemy, setEnemyCompendium } = useAppStore();
    const [query, setQuery] = useState('');
    const [view, setView] = useState<'templates' | 'instances' | 'encounters' | 'combat'>('templates');
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [draft, setDraft] = useState<EnemyEntry>(emptyEnemy);
    const importRef = useRef<HTMLInputElement>(null);

    const shown = useMemo(() => {
        const q = query.toLowerCase().trim();
        return [...enemyCompendium]
            .filter(e => !q || [e.name, e.aliases, e.classification, e.faction, e.tags.join(' ')].some(v => v.toLowerCase().includes(q)))
            .sort((a, b) => a.name.localeCompare(b.name));
    }, [enemyCompendium, query]);

    if (!enemyCompendiumOpen) return null;

    /** Loads an existing template into an isolated draft, or starts a new one. */
    const select = (enemy?: EnemyEntry) => {
        setSelectedId(enemy?.id ?? null);
        setDraft(enemy ? structuredClone(enemy) : emptyEnemy());
    };

    /** Validates and persists the draft as either an update or a new template. */
    const save = () => {
        if (!draft.name.trim()) return toast.warning('Enemy name is required');
        const next = { ...draft, name: draft.name.trim(), updatedAt: Date.now() };
        if (selectedId) updateEnemy(selectedId, next);
        else addEnemy(next);
        setSelectedId(next.id);
        setDraft(next);
        toast.success('Enemy saved');
    };

    /** Copies the current draft under a new ID without saving it immediately. */
    const duplicate = () => {
        const now = Date.now();
        setSelectedId(null);
        setDraft({ ...structuredClone(draft), id: crypto.randomUUID(), name: `${draft.name} Copy`, createdAt: now, updatedAt: now });
    };

    /** Downloads the full campaign compendium in the format accepted by import. */
    const exportJson = () => {
        const blob = new Blob([JSON.stringify(enemyCompendium, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url; a.download = 'enemy-compendium.json'; a.click();
        URL.revokeObjectURL(url);
    };

    /**
     * Replaces the current compendium with valid named records from a JSON array.
     * Missing fields receive defaults so older or hand-authored files remain usable.
     */
    const importJson = async (file?: File) => {
        if (!file) return;
        try {
            const parsed = JSON.parse(await file.text());
            if (!Array.isArray(parsed)) throw new Error('Expected a JSON array');
            const now = Date.now();
            const imported = parsed.filter(e => e && typeof e.name === 'string').map(e => ({ ...emptyEnemy(), ...e, id: e.id || crypto.randomUUID(), updatedAt: now }));
            setEnemyCompendium(imported);
            select();
            toast.success(`Imported ${imported.length} enemies`);
        } catch (e) { toast.error(e instanceof Error ? e.message : 'Import failed'); }
    };

    /** Renders a controlled text input or textarea for a scalar template field. */
    const field = (label: string, key: keyof EnemyEntry, multiline = false) => (
        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            {label}
            {multiline
                ? <textarea value={String(draft[key] ?? '')} onChange={e => setDraft({ ...draft, [key]: e.target.value })} rows={3} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
                : <input value={String(draft[key] ?? '')} onChange={e => setDraft({ ...draft, [key]: e.target.value })} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />}
        </label>
    );

    /** Renders a multiline editor backed by one of the template's string arrays. */
    const listField = (label: string, key: 'tags' | 'passiveTraits' | 'specialBehaviors' | 'weaknesses' | 'resistances') => (
        <label className="block text-[10px] uppercase tracking-wider text-text-dim">
            {label} <span className="normal-case">(one per line)</span>
            <textarea value={draft[key].join('\n')} onChange={e => setDraft({ ...draft, [key]: lines(e.target.value) })} rows={3} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" />
        </label>
    );

    return <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
        <div className="w-full max-w-[95vw] h-[88vh] bg-void-lighter border border-border rounded flex overflow-hidden">
            <aside className="w-80 border-r border-border flex flex-col">
                <div className="p-3 flex gap-2">
                    <div className="relative flex-1"><Search size={13} className="absolute left-2 top-2.5 text-text-dim" /><input value={query} onChange={e => setQuery(e.target.value)} placeholder="Search enemies…" className="w-full bg-void border border-border rounded py-2 pl-7 pr-2 text-xs" /></div>
                    <button onClick={() => select()} title="New enemy" className="p-2 border border-border rounded hover:text-terminal"><Plus size={15} /></button>
                </div>
                <div className="flex-1 overflow-y-auto">
                    {shown.map(enemy => <button key={enemy.id} onClick={() => select(enemy)} className={`w-full text-left p-3 border-b border-border/50 ${selectedId === enemy.id ? 'bg-terminal/10 text-terminal' : 'hover:bg-white/5'}`}>
                        <div className="font-semibold text-sm">{enemy.name}</div>
                        <div className="text-[10px] text-text-dim">{[enemy.classification, enemy.threatTier].filter(Boolean).join(' · ') || 'Unclassified'}</div>
                    </button>)}
                </div>
                <div className="p-3 border-t border-border flex gap-2">
                    <button onClick={exportJson} disabled={!enemyCompendium.length} className="flex-1 p-2 border border-border rounded text-xs"><Download size={13} className="inline mr-1" />Export</button>
                    <button onClick={() => importRef.current?.click()} className="flex-1 p-2 border border-border rounded text-xs"><Upload size={13} className="inline mr-1" />Import</button>
                    <input ref={importRef} type="file" accept=".json,application/json" hidden onChange={e => void importJson(e.target.files?.[0])} />
                </div>
            </aside>
            <main className="flex-1 flex flex-col min-w-0">
                <header className="p-4 border-b border-border flex items-center justify-between">
                    <div>
                        <h2 className="font-bold uppercase tracking-wider">Enemy Compendium</h2>
                        <div className="flex gap-3 mt-2">
                            <button onClick={() => setView('templates')} className={`text-xs ${view === 'templates' ? 'text-terminal' : 'text-text-dim'}`}>Templates</button>
                            <button onClick={() => setView('instances')} className={`text-xs ${view === 'instances' ? 'text-terminal' : 'text-text-dim'}`}>Encounter Instances ({enemyInstances.length})</button>
                            <button onClick={() => setView('encounters')} className={`text-xs ${view === 'encounters' ? 'text-terminal' : 'text-text-dim'}`}>Encounter Roster ({enemyEncounters.filter(encounter => encounter.status === 'active').length})</button>
                            <button onClick={() => setView('combat')} className={`text-xs ${view === 'combat' ? 'text-terminal' : 'text-text-dim'}`}>Combat</button>
                        </div>
                    </div>
                    <button onClick={toggleEnemyCompendium}><X size={20} /></button>
                </header>
                {view === 'templates' ? <div className="flex-1 overflow-y-auto p-5 grid grid-cols-2 gap-4">
                    {field('Name', 'name')}{field('Aliases', 'aliases')}
                    {field('Classification / Species', 'classification')}{field('Threat Tier', 'threatTier')}
                    {field('Faction', 'faction')}{listField('Tags', 'tags')}
                    <div className="col-span-2">{field('Description', 'description', true)}</div>
                    <label className="block text-[10px] uppercase tracking-wider text-text-dim">Stats <span className="normal-case">(Name: value)</span><textarea value={draft.stats.map(s => `${s.name}: ${s.value}`).join('\n')} onChange={e => setDraft({ ...draft, stats: pairs(e.target.value) })} rows={5} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" /></label>
                    <label className="block text-[10px] uppercase tracking-wider text-text-dim">Actions <span className="normal-case">(Name: description)</span><textarea value={draft.actions.map(a => `${a.name}: ${a.description}`).join('\n')} onChange={e => setDraft({ ...draft, actions: actions(e.target.value) })} rows={5} className="mt-1 w-full bg-void border border-border rounded p-2 text-xs text-text-normal normal-case" /></label>
                    {listField('Passive Traits', 'passiveTraits')}{listField('Special Behaviours', 'specialBehaviors')}
                    {listField('Weaknesses', 'weaknesses')}{listField('Resistances', 'resistances')}
                    {field('Preferred Range / Tactics', 'tactics', true)}{field('Loot / Rewards', 'loot', true)}
                    <div className="col-span-2">{field('GM Notes', 'gmNotes', true)}</div>
                    <label className="col-span-2 text-xs"><input type="checkbox" checked={draft.promptEnabled} onChange={e => setDraft({ ...draft, promptEnabled: e.target.checked })} className="mr-2" />Inject this template when its name or alias appears in recent play</label>
                </div> : view === 'instances'
                    ? <EnemyInstancesView selectedTemplateId={selectedId} />
                    : view === 'encounters'
                        ? <EnemyEncountersView selectedTemplateId={selectedId} />
                        : <EnemyCombatView />}
                {view === 'templates' && <footer className="p-4 border-t border-border flex justify-between">
                    <div className="flex gap-2">
                        <button onClick={duplicate} disabled={!draft.name} className="px-3 py-2 border border-border rounded text-xs disabled:opacity-30"><Copy size={13} className="inline mr-1" />Duplicate</button>
                        {selectedId && <button onClick={() => { removeEnemy(selectedId); select(); }} className="px-3 py-2 border border-ember text-ember rounded text-xs"><Trash2 size={13} className="inline mr-1" />Delete</button>}
                    </div>
                    <button onClick={save} className="px-5 py-2 bg-terminal text-void rounded text-xs font-bold">Save Template</button>
                </footer>}
            </main>
        </div>
    </div>;
}
