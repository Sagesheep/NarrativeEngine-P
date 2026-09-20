import { countTokens } from '../services/infrastructure/tokenizer';
import { useEffect, useRef, useState } from 'react';
import { BookOpen, Upload, PenLine } from 'lucide-react';
import { cardFromDraft, readWorldFile, type WorldImport } from '../services/lore/worldCard';
import { parseJsonCard, parsePngCard } from '../services/import/stCardParser';
import { useAppStore } from '../store/useAppStore';

export function CampaignWorldSetup({ world, onChange, onBusyChange, onOpenBuilder }: {
    world?: WorldImport;
    onChange: (file: File | null, world?: WorldImport) => void;
    onBusyChange: (busy: boolean) => void;
    onOpenBuilder: () => void;
}) {
    const input = useRef<HTMLInputElement>(null);
    const lock = useRef(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [text, setText] = useState('');
    const [mode, setMode] = useState<'blank' | 'upload' | 'write'>(world ? 'upload' : 'blank');
    const drafts = useAppStore(s => s.worldLoreDrafts);
    const loadDrafts = useAppStore(s => s.loadWorldLoreDrafts);
    useEffect(() => { loadDrafts(); }, [loadDrafts]);
    const upload = async (file?: File) => {
        if (!file || lock.current) return;
        lock.current = true; setBusy(true); onBusyChange(true); setError('');
        try {
            if (/\.(png|json)$/i.test(file.name)) {
                if (/\.png$/i.test(file.name) && parsePngCard(await file.arrayBuffer()).ok) {
                    throw new Error('This is a character card. Use Add NPC in the character roster below.');
                }
                if (/\.json$/i.test(file.name)) {
                    const raw = await file.text();
                    const parsed = JSON.parse(raw);
                    if (parseJsonCard(raw) && (parsed.spec?.startsWith('chara_card') || parsed.first_mes !== undefined || parsed.personality !== undefined || parsed.character_book || parsed.data?.name)) {
                        throw new Error('This is a character card. Use Add NPC in the character roster below.');
                    }
                }
                const result = await readWorldFile(file);
                onChange(file, result); setMode('upload');
            } else if (/\.(md|txt)$/i.test(file.name)) {
                const value = await file.text(); setText(value); setMode('write'); onChange(file);
            } else throw new Error('Choose a world PNG, lorebook JSON, Markdown, or text file.');
        } catch (e) { setError(e instanceof Error ? e.message : 'Could not read world file.'); }
        finally { lock.current = false; setBusy(false); onBusyChange(false); }
    };
    const editChunk = (id: string, content: string) => {
        if (!world) return;
        const updated = { ...world, card: { ...world.card, world: { ...world.card.world, chunks: world.card.world.chunks.map(c => c.id === id ? { ...c, content, tokens: countTokens(`${c.header}\n${content}`) } : c) } } };
        onChange(new File([JSON.stringify(updated.card)], 'world.json', { type: 'application/json' }), updated);
    };
    const tile = 'rounded-lg border p-4 text-left flex flex-col gap-2 hover:border-terminal disabled:opacity-40';
    return <section className="space-y-3 mb-5" aria-label="World setup" onDragOver={e => e.preventDefault()} onDrop={e => { e.preventDefault(); void upload(e.dataTransfer.files[0]); }}>
        <h3 className="text-sm text-terminal font-bold">Choose your world</h3>
        <p className="text-xs text-text-dim">Start fresh, bring a world lore card, or write your own setting. Characters go in the roster below.</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <button type="button" disabled={busy} aria-pressed={mode === 'blank'} className={`${tile} ${mode === 'blank' ? 'border-terminal bg-terminal/10' : 'border-border'}`} onClick={() => { setMode('blank'); setError(''); onChange(null); }}><BookOpen size={20} /><strong className="text-sm">Start blank</strong><span className="text-xs text-text-dim">Discover the world as you play</span></button>
            <button type="button" disabled={busy} aria-pressed={mode === 'upload'} className={`${tile} ${mode === 'upload' ? 'border-terminal bg-terminal/10' : 'border-border'}`} onClick={() => input.current?.click()}><Upload size={20} /><strong className="text-sm">Upload world lore</strong><span className="text-xs text-text-dim">World PNG, lorebook JSON, or text</span></button>
            <button type="button" disabled={busy} aria-pressed={mode === 'write'} className={`${tile} ${mode === 'write' ? 'border-terminal bg-terminal/10' : 'border-border'}`} onClick={() => { setMode('write'); setError(''); onChange(text ? new File([text], 'world.md') : null); }}><PenLine size={20} /><strong className="text-sm">Write your world</strong><span className="text-xs text-text-dim">Start with an idea or a saved draft</span></button>
        </div>
        <input ref={input} type="file" className="hidden" accept=".png,.json,.md,.txt" aria-label="Upload world lore" onChange={e => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
        <div className="flex flex-wrap gap-3 items-center text-xs">
            <button type="button" disabled={busy} className="text-terminal underline" onClick={onOpenBuilder}>Open World Lore Builder</button>
            {drafts.length > 0 && <label className="text-text-dim">Use saved world <select value="" disabled={busy} className="ml-2 p-2 bg-void border border-border rounded" onChange={e => {
                const draft = drafts.find(d => d.id === e.target.value);
                if (!draft) return;
                const card = cardFromDraft(draft);
                onChange(new File([JSON.stringify(card)], 'world.json'), { card, source: 'native', warnings: [] }); setMode('upload'); setError('');
            }}><option value="">Choose draft…</option>{drafts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
        </div>
        {mode === 'write' && <label className="block text-xs text-text-dim">World lore<textarea rows={5} value={text} className="block w-full mt-2 p-3 bg-void border border-border rounded text-text-primary" placeholder="Describe the setting, its history, factions, and conflicts…" onChange={e => { setText(e.target.value); onChange(new File([e.target.value], 'world.md')); }} /></label>}
        {world && <div className="rounded border border-border p-3 space-y-2">
            <strong className="text-sm">{world.card.world.name}</strong><p className="text-xs text-text-dim">{world.card.world.chunks.length} lore entries · {world.card.world.chunks.filter(c => c.disabled).length} disabled</p>
            {world.warnings.map(w => <p key={w} className="text-xs text-amber-400">{w}</p>)}
            <details className="text-xs"><summary>Review and edit lore</summary><div className="max-h-64 overflow-auto space-y-3 mt-2">{world.card.world.chunks.map(c => <label key={c.id} className="block">{c.header}{c.disabled ? ' (disabled)' : ''}<textarea rows={3} value={c.content} onChange={e => editChunk(c.id, e.target.value)} className="block w-full p-2 bg-void border border-border mt-1" /></label>)}</div></details>
        </div>}
        {busy && <p role="status" className="text-xs text-terminal">Reading world lore…</p>}
        {error && <p role="alert" className="text-xs text-danger">{error}</p>}
    </section>;
}
