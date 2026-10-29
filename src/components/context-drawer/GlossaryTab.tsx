import { useState } from 'react';
import { BookOpen, Plus, Search } from 'lucide-react';
import type { GlossaryEntry } from '../../types';
import { useAppStore } from '../../store/useAppStore';
import { uid } from '../../utils/uid';

const EMPTY: GlossaryEntry[] = [];
const fieldClass = 'mt-1 w-full rounded border border-border bg-void px-3 py-2 text-sm text-text-primary focus:outline-none focus:border-terminal';
const buttonClass = 'rounded border border-border px-3 py-2 text-xs text-terminal hover:border-terminal disabled:opacity-40';

function GlossaryEditor({ entry, initialName, onClose }: {
    entry?: GlossaryEntry; initialName?: string | null; onClose: () => void;
}) {
    const [form, setForm] = useState<GlossaryEntry>(() => entry ?? {
        id: uid(), name: initialName ?? '', aliases: '', description: '', category: '', image: '',
    });
    const [error, setError] = useState('');
    const patch = (value: Partial<GlossaryEntry>) => { setForm(prev => ({ ...prev, ...value })); setError(''); };

    const save = (event: React.FormEvent) => {
        event.preventDefault();
        const state = useAppStore.getState();
        const entries = state.context.glossary ?? [];
        const name = form.name.trim();
        if (!name || !form.description.trim()) return;
        if (entries.some(item => item.id !== form.id && item.name.toLowerCase() === name.toLowerCase())) {
            setError('A glossary entry with this name already exists. Edit it or use a different name.');
            return;
        }
        const saved = { ...form, name, aliases: form.aliases.trim(), description: form.description.trim(), category: form.category?.trim(), image: form.image?.trim() || undefined };
        state.updateContext({ glossary: entry ? entries.map(item => item.id === entry.id ? saved : item) : [...entries, saved] });
        onClose();
    };

    return (
        <form onSubmit={save} aria-label={entry ? 'Edit glossary entry' : 'New glossary entry'} className="space-y-4 rounded border border-terminal/40 bg-surface p-4">
            <h3 className="text-sm font-bold text-terminal">{entry ? 'Edit entry' : 'New entry'}</h3>
            <label className="block text-xs text-text-dim">Name
                <input required value={form.name} onChange={e => patch({ name: e.target.value })} className={fieldClass} />
            </label>
            <label className="block text-xs text-text-dim">Aliases (comma-separated)
                <input value={form.aliases} onChange={e => patch({ aliases: e.target.value })} placeholder="Other names used in the story" className={fieldClass} />
            </label>
            <label className="block text-xs text-text-dim">Short description
                <textarea required rows={3} value={form.description} onChange={e => patch({ description: e.target.value })} aria-describedby="glossary-description-hint" className={fieldClass} />
            </label>
            <p id="glossary-description-hint" className="text-xs text-text-dim">Aim for about 128 characters; longer reminders are welcome. {form.description.length} characters.</p>
            <label className="block text-xs text-text-dim">Category (optional)
                <input value={form.category ?? ''} onChange={e => patch({ category: e.target.value })} placeholder="Faction, item, event, family, or your own category" className={fieldClass} />
            </label>
            <label className="block text-xs text-text-dim">Image URL or asset path (optional)
                <input value={form.image ?? ''} onChange={e => patch({ image: e.target.value })} className={fieldClass} />
            </label>
            {error && <p role="alert" className="text-xs text-danger">{error}</p>}
            <div className="flex gap-2">
                <button type="submit" disabled={!form.name.trim() || !form.description.trim()} className={buttonClass}>Save entry</button>
                <button type="button" onClick={onClose} className={buttonClass}>Cancel</button>
            </div>
        </form>
    );
}

export function GlossaryTab({ initialName }: { initialName?: string | null }) {
    const entries = useAppStore(s => s.context.glossary ?? EMPTY);
    const [query, setQuery] = useState('');
    const [editing, setEditing] = useState<GlossaryEntry | 'new' | null>(initialName ? 'new' : null);
    const [deleting, setDeleting] = useState<string | null>(null);
    const filtered = entries.filter(entry => [entry.name, entry.aliases, entry.category, entry.description].some(value => value?.toLowerCase().includes(query.toLowerCase())));

    const remove = (id: string) => {
        const state = useAppStore.getState();
        state.updateContext({ glossary: (state.context.glossary ?? []).filter(entry => entry.id !== id) });
        if (editing && editing !== 'new' && editing.id === id) setEditing(null);
        setDeleting(null);
    };

    return (
        <div className="flex-1 min-h-0 flex flex-col gap-4">
            <p className="text-sm text-text-dim">Quick reminders for factions, families, items, events, and other story terms. Names and aliases show previews in the story. NPCs and locations use their existing ledgers.</p>
            <div className="flex flex-wrap items-center gap-3">
                <label className="flex flex-1 min-w-48 items-center gap-2 text-text-dim">
                    <Search size={16} />
                    <input aria-label="Search glossary" value={query} onChange={e => setQuery(e.target.value)} placeholder="Search glossary…" className={fieldClass} />
                </label>
                <button type="button" onClick={() => setEditing('new')} className={`${buttonClass} flex items-center gap-2`}><Plus size={14} /> New entry</button>
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto space-y-4">
                {editing && <GlossaryEditor key={editing === 'new' ? 'new' : editing.id} entry={editing === 'new' ? undefined : editing} initialName={initialName} onClose={() => setEditing(null)} />}
                {filtered.length === 0 && <div className="py-8 text-center text-text-dim space-y-2"><BookOpen className="mx-auto opacity-50" size={30} /><p>{query ? 'No matching terms.' : 'No glossary entries yet. Create one here or select story text and choose “Add to Glossary”.'}</p></div>}
                {filtered.map(entry => (
                    <article key={entry.id} className="rounded border border-border bg-void p-4 space-y-2">
                        <div className="flex items-start justify-between gap-3">
                            <div className="min-w-0"><h3 className="text-terminal font-bold break-words">{entry.name}</h3>{entry.category && <p className="text-xs text-text-dim">{entry.category}</p>}</div>
                            <div className="flex flex-wrap gap-2 shrink-0">
                                <button type="button" onClick={() => setEditing(entry)} aria-label={`Edit ${entry.name}`} className={buttonClass}>Edit</button>
                                <button type="button" onClick={() => setDeleting(entry.id)} aria-label={`Delete ${entry.name}`} className={buttonClass}>Delete</button>
                            </div>
                        </div>
                        {entry.aliases && <p className="text-xs text-text-dim break-words">Also: {entry.aliases}</p>}
                        <p className="text-sm text-text-primary whitespace-pre-wrap break-words">{entry.description}</p>
                        {deleting === entry.id && <div className="flex flex-wrap items-center gap-2 text-xs text-text-dim"><span>Delete this entry?</span><button type="button" onClick={() => remove(entry.id)} className={buttonClass}>Confirm delete</button><button type="button" onClick={() => setDeleting(null)} className={buttonClass}>Keep entry</button></div>}
                    </article>
                ))}
            </div>
        </div>
    );
}
