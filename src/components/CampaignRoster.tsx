import { useRef, useState } from 'react';
import { Plus, Upload, User, X } from 'lucide-react';
import { prepareRosterFile, type CampaignRosterEntry } from '../services/import/campaignRoster';
import { useAppStore } from '../store/useAppStore';

export function CampaignRoster({ entries, onChange, onBusyChange }: {
    entries: CampaignRosterEntry[];
    onChange: (entries: CampaignRosterEntry[]) => void;
    onBusyChange: (busy: boolean) => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const importing = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const importFiles = async (files: File[]) => {
        if (importing.current || !files.length) return;
        importing.current = true;
        setBusy(true); onBusyChange(true); setError('');
        const next = [...entries];
        const errors: string[] = [];
        try {
            for (const file of files) {
                try {
                    const entry = await prepareRosterFile(file, useAppStore.getState().settings.matureMode ?? false);
                    if (next.some(e => e.npc.name.trim().toLowerCase() === entry.npc.name.trim().toLowerCase())) {
                        throw new Error(`${entry.npc.name} is already in the roster. Remove it first to replace it.`);
                    }
                    if (entry.portraitFile) entry.preview = await new Promise<string>((resolve, reject) => {
                        const reader = new FileReader();
                        reader.onload = () => resolve(reader.result as string);
                        reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
                        reader.readAsDataURL(file);
                    });
                    next.push(entry);
                } catch (e) { errors.push(e instanceof Error ? e.message : `Could not read ${file.name}`); }
            }
            onChange(next);
            setError(errors.join('\n'));
        } finally { importing.current = false; setBusy(false); onBusyChange(false); }
    };
    const update = (index: number, patch: Partial<CampaignRosterEntry>) => onChange(entries.map((e, i) => i === index ? { ...e, ...patch } : e));
    return <section aria-label="Character roster" className="my-5 space-y-3" onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); void importFiles(Array.from(e.dataTransfer.files)); }}>
        <div className="flex justify-between items-center gap-2">
            <h3 className="text-sm text-terminal font-bold">Character roster <span className="text-text-dim">({entries.length})</span></h3>
            <button type="button" disabled={busy} className="text-xs text-terminal underline" onClick={() => {
                let name = 'New NPC';
                let number = 2;
                while (entries.some(e => e.npc.name.toLowerCase() === name.toLowerCase())) name = 'New NPC ' + number++;
                void importFiles([new File([JSON.stringify({ name, description: '', personality: '' })], 'new-npc.json', { type: 'application/json' })]);
            }}>Create NPC manually</button>
        </div>
        <p className="text-xs text-text-dim">Upload or drop SillyTavern PNG / JSON cards to add NPCs. Review their details before creating your campaign.</p>
        <input ref={input} type="file" multiple accept=".png,.json" className="hidden" aria-label="Upload NPC cards"
            onChange={e => { void importFiles(Array.from(e.target.files ?? [])); e.target.value = ''; }} />
        <fieldset disabled={busy} className="grid grid-cols-[repeat(auto-fill,minmax(180px,1fr))] gap-3">
            {entries.map((entry, index) => <article key={entry.npc.id} className="rounded-lg border border-border bg-void-lighter overflow-hidden">
                <div className="relative h-36 bg-void flex items-center justify-center">
                    {entry.preview ? <img src={entry.preview} alt={entry.npc.name} className="h-full w-full object-contain" /> : <User className="text-text-dim" size={32} />}
                    <button type="button" aria-label={`Remove ${entry.npc.name}`} className="absolute top-2 right-2 bg-surface rounded p-1 text-text-dim hover:text-danger"
                        onClick={() => onChange(entries.filter((_, i) => i !== index))}><X size={16} /></button>
                </div>
                <div className="p-3 space-y-2">
                    <label className="block text-xs text-text-dim">Name<input className="w-full mt-1 p-2 bg-surface border border-border rounded text-text-primary" value={entry.npc.name}
                        onChange={e => update(index, { npc: { ...entry.npc, name: e.target.value } })} /></label>
                    <label className="block text-xs text-text-dim">Personality<textarea rows={3} className="w-full mt-1 p-2 bg-surface border border-border rounded text-text-primary" value={entry.npc.personality || ''}
                        onChange={e => update(index, { npc: { ...entry.npc, personality: e.target.value } })} /></label>
                    <label className="block text-xs text-text-dim">Description<textarea rows={3} className="w-full mt-1 p-2 bg-surface border border-border rounded text-text-primary" value={entry.npc.storyRelevance || ''}
                        onChange={e => update(index, { npc: { ...entry.npc, storyRelevance: e.target.value } })} /></label>
                    {entry.characterSheets.length > 0 && <details className="text-xs text-text-dim"><summary>Full character reference</summary><div className="max-h-40 overflow-auto whitespace-pre-wrap mt-2">{entry.characterSheets.map(c => <p key={c.id}>{c.content}</p>)}</div></details>}
                    {entry.loreChunks.length > 0 && <details className="text-xs text-text-dim">
                        <summary>Embedded lore ({entry.loreChunks.length})</summary>
                        <div className="max-h-40 overflow-auto my-2 space-y-2">{entry.loreChunks.map(c => <p key={c.id}><strong>{c.header}</strong><br />{c.content}</p>)}</div>
                        <label className="flex items-center gap-2"><input type="checkbox" checked={entry.includeLore} onChange={e => update(index, { includeLore: e.target.checked })} />Include this lore in the world</label>
                    </details>}
                </div>
            </article>)}
            <button type="button" onClick={() => input.current?.click()} className="min-h-44 self-start rounded-lg border border-dashed border-terminal/40 bg-terminal/5 hover:bg-terminal/10 text-terminal flex flex-col items-center justify-center gap-2 p-4">
                <Plus size={28} /><strong>Add NPC</strong><span className="text-xs flex items-center gap-1"><Upload size={12} /> Upload character cards</span>
            </button>
        </fieldset>
        {busy && <p role="status" className="text-xs text-terminal">Reading character cards…</p>}
        {error && <p role="alert" className="text-xs text-danger whitespace-pre-wrap">{error}</p>}
    </section>;
}
